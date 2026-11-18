#![no_std]

//! # CLMM Core — Concentrated Liquidity Market Maker Engine
//!
//! Implements Uniswap V3-style concentrated liquidity with tick-based math,
//! custom price ranges, and NFT-style position tracking for capital efficiency.
//!
//! Position accounting is journalled: `mint`, `burn` and `collect` snapshot the
//! pre-operation state, record every completed step, and roll that snapshot back
//! when a step fails. See `docs/clmm-position-accounting.md`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

mod math;
mod operation;
mod position;
mod tick;

// ── Storage Keys ────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Initialized,
    Token0,
    Token1,
    Fee,
    TickSpacing,
    CurrentTick,
    SqrtPriceX96,
    Liquidity,
    FeeGrowthGlobal0X128,
    FeeGrowthGlobal1X128,
    Tick(i32),
    Position(u64),
    NextPositionId,
    PendingOperation(Address),
}

// ── Data Structures ─────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TickInfo {
    pub liquidity_gross: u128,
    pub liquidity_net: i128,
    pub fee_growth_outside_0_x128: u128,
    pub fee_growth_outside_1_x128: u128,
    pub initialized: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub owner: Address,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    pub fee_growth_inside_0_last_x128: u128,
    pub fee_growth_inside_1_last_x128: u128,
    pub tokens_owed_0: u128,
    pub tokens_owed_1: u128,
}

/// Kind of position operation tracked by the operation journal.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationKind {
    Mint,
    Burn,
    Collect,
}

/// Durable journal entry for an in-flight position operation.
///
/// The entry snapshots the pre-operation state, then records the furthest step
/// the operation reached and which token transfers already settled. A failure
/// replays that snapshot in `operation::rollback`, so accounting always matches
/// the tokens that actually moved and a retry starts from a known state.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingOperation {
    pub owner: Address,
    pub kind: OperationKind,
    pub step: u32,
    pub transfers_settled: u32,
    pub position_id: u64,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub tick_lower_before: TickInfo,
    pub tick_upper_before: TickInfo,
    pub liquidity_before: u128,
    pub position_before: Position,
    pub has_position_before: bool,
    pub amount_0: u128,
    pub amount_1: u128,
}

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ClmmError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    InvalidTick = 3,
    InvalidTickRange = 4,
    InsufficientLiquidity = 5,
    InvalidAmount = 6,
    PriceLimitExceeded = 7,
    Unauthorized = 8,
    InvalidPosition = 9,
    OperationPending = 10,
    TokenTransferFailed = 11,
}

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct ClmmCore;

#[contractimpl]
impl ClmmCore {
    /// Initialize the CLMM pool with two tokens, fee tier, and tick spacing.
    ///
    /// # Arguments
    /// * `token0` — First token address (lower address)
    /// * `token1` — Second token address (higher address)
    /// * `fee` — Fee in basis points (e.g., 3000 = 0.3%)
    /// * `tick_spacing` — Minimum tick spacing (e.g., 60 for 0.3% fee tier)
    /// * `sqrt_price_x96` — Initial sqrt price in Q64.96 format
    pub fn initialize(
        env: Env,
        token0: Address,
        token1: Address,
        fee: u32,
        tick_spacing: i32,
        sqrt_price_x96: u128,
    ) -> Result<(), ClmmError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(ClmmError::AlreadyInitialized);
        }

        let initial_tick = math::get_tick_at_sqrt_ratio(sqrt_price_x96);

        env.storage().instance().set(&DataKey::Token0, &token0);
        env.storage().instance().set(&DataKey::Token1, &token1);
        env.storage().instance().set(&DataKey::Fee, &fee);
        env.storage()
            .instance()
            .set(&DataKey::TickSpacing, &tick_spacing);
        env.storage()
            .instance()
            .set(&DataKey::CurrentTick, &initial_tick);
        env.storage()
            .instance()
            .set(&DataKey::SqrtPriceX96, &sqrt_price_x96);
        env.storage().instance().set(&DataKey::Liquidity, &0u128);
        env.storage()
            .instance()
            .set(&DataKey::FeeGrowthGlobal0X128, &0u128);
        env.storage()
            .instance()
            .set(&DataKey::FeeGrowthGlobal1X128, &0u128);
        env.storage()
            .instance()
            .set(&DataKey::NextPositionId, &1u64);
        env.storage().instance().set(&DataKey::Initialized, &true);

        env.events().publish(
            (symbol_short!("init"),),
            (token0, token1, fee, tick_spacing, sqrt_price_x96),
        );

        Ok(())
    }

    /// Mint a new liquidity position with custom price range.
    ///
    /// Validation, tick accounting, the provisional position and both token
    /// deposits are tracked by an operation journal. If any step fails the
    /// journal rolls the accounting back and refunds deposits that already
    /// settled, so the reserved position id can be retried without gaps.
    ///
    /// # Arguments
    /// * `owner` — Position owner address
    /// * `tick_lower` — Lower tick boundary
    /// * `tick_upper` — Upper tick boundary
    /// * `amount` — Liquidity amount to add
    /// * `amount0_max` — Maximum token0 to deposit
    /// * `amount1_max` — Maximum token1 to deposit
    ///
    /// # Returns
    /// (position_id, amount0, amount1) — Position ID and actual amounts deposited
    pub fn mint(
        env: Env,
        owner: Address,
        tick_lower: i32,
        tick_upper: i32,
        amount: u128,
        amount0_max: u128,
        amount1_max: u128,
    ) -> Result<(u64, u128, u128), ClmmError> {
        Self::require_init(&env)?;
        owner.require_auth();

        if amount == 0 {
            return Err(ClmmError::InvalidAmount);
        }

        Self::validate_tick_range(&env, tick_lower, tick_upper)?;
        operation::require_idle(&env, &owner)?;

        let current_tick: i32 = env.storage().instance().get(&DataKey::CurrentTick).unwrap();
        let sqrt_price: u128 = env
            .storage()
            .instance()
            .get(&DataKey::SqrtPriceX96)
            .unwrap();

        // Calculate required token amounts
        let (amount0, amount1) =
            math::get_amounts_for_liquidity(sqrt_price, tick_lower, tick_upper, amount);

        if amount0 > amount0_max || amount1 > amount1_max {
            return Err(ClmmError::InvalidAmount);
        }

        // Reserve the position id without consuming it: a failed mint leaves no
        // gap, so a retry gets the same id deterministically.
        let position_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextPositionId)
            .unwrap();

        let mut journal = PendingOperation {
            owner: owner.clone(),
            kind: OperationKind::Mint,
            step: operation::STEP_PREPARED,
            transfers_settled: 0,
            position_id,
            tick_lower,
            tick_upper,
            tick_lower_before: tick::get_tick(&env, tick_lower),
            tick_upper_before: tick::get_tick(&env, tick_upper),
            liquidity_before: env.storage().instance().get(&DataKey::Liquidity).unwrap(),
            // A mint has no position yet; the slot is only read back when
            // `has_position_before` is set.
            position_before: Position {
                owner: owner.clone(),
                tick_lower,
                tick_upper,
                liquidity: 0,
                fee_growth_inside_0_last_x128: 0,
                fee_growth_inside_1_last_x128: 0,
                tokens_owed_0: 0,
                tokens_owed_1: 0,
            },
            has_position_before: false,
            amount_0: amount0,
            amount_1: amount1,
        };

        operation::begin(&env, journal.clone())?;

        match Self::execute_mint(&env, &owner, amount, current_tick, &mut journal) {
            Ok(result) => {
                env.storage()
                    .instance()
                    .set(&DataKey::NextPositionId, &(position_id + 1));
                operation::commit(&env, &journal);

                env.events().publish(
                    (symbol_short!("mint"),),
                    (position_id, owner, tick_lower, tick_upper, amount),
                );

                Ok(result)
            }
            Err(err) => {
                operation::rollback(&env, &journal);
                Err(err)
            }
        }
    }

    /// Burn liquidity from an existing position and collect tokens.
    ///
    /// The position snapshot and tick state are journalled, so a failed burn
    /// leaves the position, pool liquidity and tick state exactly as they were.
    ///
    /// # Arguments
    /// * `position_id` — ID of the position to burn
    /// * `amount` — Amount of liquidity to remove
    ///
    /// # Returns
    /// (amount0, amount1) — Amounts of token0 and token1 returned
    pub fn burn(env: Env, position_id: u64, amount: u128) -> Result<(u128, u128), ClmmError> {
        Self::require_init(&env)?;

        let position: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(position_id))
            .ok_or(ClmmError::InvalidPosition)?;

        position.owner.require_auth();

        if amount == 0 || amount > position.liquidity {
            return Err(ClmmError::InsufficientLiquidity);
        }

        operation::require_idle(&env, &position.owner)?;

        let current_tick: i32 = env.storage().instance().get(&DataKey::CurrentTick).unwrap();
        let sqrt_price: u128 = env
            .storage()
            .instance()
            .get(&DataKey::SqrtPriceX96)
            .unwrap();

        // Calculate token amounts to return
        let (amount0, amount1) = math::get_amounts_for_liquidity(
            sqrt_price,
            position.tick_lower,
            position.tick_upper,
            amount,
        );

        let mut journal = PendingOperation {
            owner: position.owner.clone(),
            kind: OperationKind::Burn,
            step: operation::STEP_PREPARED,
            transfers_settled: 0,
            position_id,
            tick_lower: position.tick_lower,
            tick_upper: position.tick_upper,
            tick_lower_before: tick::get_tick(&env, position.tick_lower),
            tick_upper_before: tick::get_tick(&env, position.tick_upper),
            liquidity_before: env.storage().instance().get(&DataKey::Liquidity).unwrap(),
            position_before: position,
            has_position_before: true,
            amount_0: amount0,
            amount_1: amount1,
        };

        operation::begin(&env, journal.clone())?;

        match Self::execute_burn(&env, amount, current_tick, &mut journal) {
            Ok(result) => {
                operation::commit(&env, &journal);

                env.events().publish(
                    (symbol_short!("burn"),),
                    (position_id, amount, result.0, result.1),
                );

                Ok(result)
            }
            Err(err) => {
                operation::rollback(&env, &journal);
                Err(err)
            }
        }
    }

    /// Execute a swap between token0 and token1.
    ///
    /// # Arguments
    /// * `recipient` — Address to receive output tokens
    /// * `zero_for_one` — True if swapping token0 for token1
    /// * `amount_specified` — Amount to swap (positive for exact input, negative for exact output)
    /// * `sqrt_price_limit_x96` — Price limit to prevent excessive slippage
    ///
    /// # Returns
    /// (amount0, amount1) — Actual amounts swapped (negative = sent, positive = received)
    pub fn swap(
        env: Env,
        recipient: Address,
        zero_for_one: bool,
        amount_specified: i128,
        sqrt_price_limit_x96: u128,
    ) -> Result<(i128, i128), ClmmError> {
        Self::require_init(&env)?;
        recipient.require_auth();

        if amount_specified == 0 {
            return Err(ClmmError::InvalidAmount);
        }

        let mut sqrt_price: u128 = env
            .storage()
            .instance()
            .get(&DataKey::SqrtPriceX96)
            .unwrap();
        let mut current_tick: i32 = env.storage().instance().get(&DataKey::CurrentTick).unwrap();
        let mut liquidity: u128 = env.storage().instance().get(&DataKey::Liquidity).unwrap();

        // Validate price limit
        if zero_for_one {
            if sqrt_price_limit_x96 >= sqrt_price {
                return Err(ClmmError::PriceLimitExceeded);
            }
        } else if sqrt_price_limit_x96 <= sqrt_price {
            return Err(ClmmError::PriceLimitExceeded);
        }

        let exact_input = amount_specified > 0;
        let mut amount_remaining = amount_specified;
        let mut amount0 = 0i128;
        let mut amount1 = 0i128;

        // Swap loop: iterate through ticks until amount is satisfied
        while amount_remaining != 0 && sqrt_price != sqrt_price_limit_x96 {
            let sqrt_price_start = sqrt_price;

            // Get next tick boundary
            let tick_next = if zero_for_one {
                tick::get_next_initialized_tick_within_one_word(&env, current_tick, false)
                    .unwrap_or(tick::MIN_TICK)
            } else {
                tick::get_next_initialized_tick_within_one_word(&env, current_tick, true)
                    .unwrap_or(tick::MAX_TICK)
            };

            let sqrt_price_next = math::get_sqrt_ratio_at_tick(tick_next);

            // Compute swap step
            let sqrt_price_target = if zero_for_one {
                if sqrt_price_next < sqrt_price_limit_x96 {
                    sqrt_price_limit_x96
                } else {
                    sqrt_price_next
                }
            } else if sqrt_price_next > sqrt_price_limit_x96 {
                sqrt_price_limit_x96
            } else {
                sqrt_price_next
            };

            let (sqrt_price_new, amount_in, amount_out, fee_amount) = math::compute_swap_step(
                sqrt_price,
                sqrt_price_target,
                liquidity,
                amount_remaining,
                env.storage().instance().get(&DataKey::Fee).unwrap(),
            );

            sqrt_price = sqrt_price_new;

            if exact_input {
                amount_remaining -= (amount_in + fee_amount) as i128;
                if zero_for_one {
                    amount0 += (amount_in + fee_amount) as i128;
                    amount1 -= amount_out as i128;
                } else {
                    amount1 += (amount_in + fee_amount) as i128;
                    amount0 -= amount_out as i128;
                }
            } else {
                amount_remaining += amount_out as i128;
                if zero_for_one {
                    amount0 += amount_in as i128;
                    amount1 -= amount_out as i128;
                } else {
                    amount1 += amount_in as i128;
                    amount0 -= amount_out as i128;
                }
            }

            // Update fee growth
            if let Some(fee_growth_delta) = (fee_amount * math::Q128).checked_div(liquidity) {
                if zero_for_one {
                    let fg0: u128 = env
                        .storage()
                        .instance()
                        .get(&DataKey::FeeGrowthGlobal0X128)
                        .unwrap();
                    env.storage()
                        .instance()
                        .set(&DataKey::FeeGrowthGlobal0X128, &(fg0 + fee_growth_delta));
                } else {
                    let fg1: u128 = env
                        .storage()
                        .instance()
                        .get(&DataKey::FeeGrowthGlobal1X128)
                        .unwrap();
                    env.storage()
                        .instance()
                        .set(&DataKey::FeeGrowthGlobal1X128, &(fg1 + fee_growth_delta));
                }
            }

            // Cross tick if we reached the next tick
            if sqrt_price == sqrt_price_next {
                let tick_info = tick::get_tick(&env, tick_next);
                if tick_info.initialized {
                    liquidity = if zero_for_one {
                        liquidity - (tick_info.liquidity_net as u128)
                    } else {
                        liquidity + (tick_info.liquidity_net as u128)
                    };
                }
                current_tick = if zero_for_one {
                    tick_next - 1
                } else {
                    tick_next
                };
            } else {
                current_tick = math::get_tick_at_sqrt_ratio(sqrt_price);
            }

            // Safety: prevent infinite loops
            if sqrt_price == sqrt_price_start {
                break;
            }
        }

        // Update state
        env.storage()
            .instance()
            .set(&DataKey::SqrtPriceX96, &sqrt_price);
        env.storage()
            .instance()
            .set(&DataKey::CurrentTick, &current_tick);
        env.storage()
            .instance()
            .set(&DataKey::Liquidity, &liquidity);

        // Execute token transfers
        let token0_addr: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1_addr: Address = env.storage().instance().get(&DataKey::Token1).unwrap();

        if amount0 > 0 {
            let client0 = token::Client::new(&env, &token0_addr);
            client0.transfer(&recipient, &env.current_contract_address(), &amount0);
        } else if amount0 < 0 {
            let client0 = token::Client::new(&env, &token0_addr);
            client0.transfer(&env.current_contract_address(), &recipient, &(-amount0));
        }

        if amount1 > 0 {
            let client1 = token::Client::new(&env, &token1_addr);
            client1.transfer(&recipient, &env.current_contract_address(), &amount1);
        } else if amount1 < 0 {
            let client1 = token::Client::new(&env, &token1_addr);
            client1.transfer(&env.current_contract_address(), &recipient, &(-amount1));
        }

        env.events()
            .publish((symbol_short!("swap"),), (recipient, amount0, amount1));

        Ok((amount0, amount1))
    }

    /// Collect accumulated fees from a position.
    ///
    /// Each payout is settled through the operation journal. If the second
    /// token cannot be paid the first payout stays settled and only the unpaid
    /// balance is restored, so calling `collect` again pays the remainder
    /// exactly once.
    ///
    /// # Arguments
    /// * `position_id` — Position ID to collect from
    ///
    /// # Returns
    /// (amount0, amount1) — Fee amounts collected
    pub fn collect(env: Env, position_id: u64) -> Result<(u128, u128), ClmmError> {
        Self::require_init(&env)?;

        let position: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(position_id))
            .ok_or(ClmmError::InvalidPosition)?;

        position.owner.require_auth();
        operation::require_idle(&env, &position.owner)?;

        // Calculate fees earned
        let current_tick: i32 = env.storage().instance().get(&DataKey::CurrentTick).unwrap();
        let fee_growth_global_0: u128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeGrowthGlobal0X128)
            .unwrap();
        let fee_growth_global_1: u128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeGrowthGlobal1X128)
            .unwrap();

        let (fee_growth_inside_0, fee_growth_inside_1) = tick::get_fee_growth_inside(
            &env,
            position.tick_lower,
            position.tick_upper,
            current_tick,
            fee_growth_global_0,
            fee_growth_global_1,
        );

        let (fees_0, fees_1) = position::calculate_uncollected_fees(
            &env,
            &position,
            fee_growth_inside_0,
            fee_growth_inside_1,
        );

        let collect_0 = position.tokens_owed_0 + fees_0;
        let collect_1 = position.tokens_owed_1 + fees_1;

        let mut journal = PendingOperation {
            owner: position.owner.clone(),
            kind: OperationKind::Collect,
            step: operation::STEP_PREPARED,
            transfers_settled: 0,
            position_id,
            tick_lower: position.tick_lower,
            tick_upper: position.tick_upper,
            tick_lower_before: tick::get_tick(&env, position.tick_lower),
            tick_upper_before: tick::get_tick(&env, position.tick_upper),
            liquidity_before: env.storage().instance().get(&DataKey::Liquidity).unwrap(),
            position_before: position,
            has_position_before: true,
            amount_0: collect_0,
            amount_1: collect_1,
        };

        operation::begin(&env, journal.clone())?;

        match Self::execute_collect(&env, &mut journal, fee_growth_inside_0, fee_growth_inside_1) {
            Ok(result) => {
                operation::commit(&env, &journal);

                env.events().publish(
                    (symbol_short!("collect"),),
                    (position_id, result.0, result.1),
                );

                Ok(result)
            }
            Err(err) => {
                operation::rollback(&env, &journal);
                Err(err)
            }
        }
    }

    // ── View Functions ──────────────────────────────────────────────

    pub fn get_position(env: Env, position_id: u64) -> Result<Position, ClmmError> {
        env.storage()
            .persistent()
            .get(&DataKey::Position(position_id))
            .ok_or(ClmmError::InvalidPosition)
    }

    /// Read the journal entry for an in-flight operation, if one exists.
    ///
    /// `None` is the normal state between transactions: a failed operation is
    /// rolled back before the call returns. The entry is exposed so clients and
    /// token callbacks can observe that a settlement is still running.
    pub fn get_pending_operation(env: Env, owner: Address) -> Option<PendingOperation> {
        operation::load(&env, &owner)
    }

    pub fn get_current_tick(env: Env) -> i32 {
        env.storage()
            .instance()
            .get(&DataKey::CurrentTick)
            .unwrap_or(0)
    }

    pub fn get_sqrt_price(env: Env) -> u128 {
        env.storage()
            .instance()
            .get(&DataKey::SqrtPriceX96)
            .unwrap_or(0)
    }

    pub fn get_liquidity(env: Env) -> u128 {
        env.storage()
            .instance()
            .get(&DataKey::Liquidity)
            .unwrap_or(0)
    }

    // ── Internal Helpers ────────────────────────────────────────────

    fn require_init(env: &Env) -> Result<(), ClmmError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(ClmmError::NotInitialized);
        }
        Ok(())
    }

    fn validate_tick_range(env: &Env, tick_lower: i32, tick_upper: i32) -> Result<(), ClmmError> {
        if tick_lower >= tick_upper {
            return Err(ClmmError::InvalidTickRange);
        }

        let tick_spacing: i32 = env.storage().instance().get(&DataKey::TickSpacing).unwrap();

        if tick_lower % tick_spacing != 0 || tick_upper % tick_spacing != 0 {
            return Err(ClmmError::InvalidTick);
        }

        if tick_lower < tick::MIN_TICK || tick_upper > tick::MAX_TICK {
            return Err(ClmmError::InvalidTick);
        }

        Ok(())
    }

    /// Move tokens without trapping, so a failing token contract is reported as
    /// a recoverable error the journal can roll back.
    fn transfer_token(
        env: &Env,
        token_addr: &Address,
        from: &Address,
        to: &Address,
        amount: u128,
    ) -> Result<(), ClmmError> {
        if amount == 0 {
            return Ok(());
        }

        let client = token::Client::new(env, token_addr);
        match client.try_transfer(from, to, &(amount as i128)) {
            Ok(Ok(())) => Ok(()),
            _ => Err(ClmmError::TokenTransferFailed),
        }
    }

    fn execute_mint(
        env: &Env,
        owner: &Address,
        amount: u128,
        current_tick: i32,
        journal: &mut PendingOperation,
    ) -> Result<(u64, u128, u128), ClmmError> {
        // Update ticks
        tick::update_tick(env, journal.tick_lower, amount as i128, false)?;
        tick::update_tick(env, journal.tick_upper, -(amount as i128), false)?;
        operation::advance(env, journal, operation::STEP_TICKS_UPDATED);

        // Update global liquidity if position is active
        if journal.tick_lower <= current_tick && current_tick < journal.tick_upper {
            let liquidity: u128 = env.storage().instance().get(&DataKey::Liquidity).unwrap();
            env.storage()
                .instance()
                .set(&DataKey::Liquidity, &(liquidity + amount));
        }

        let fee_growth_global_0: u128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeGrowthGlobal0X128)
            .unwrap();
        let fee_growth_global_1: u128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeGrowthGlobal1X128)
            .unwrap();

        let (fee_growth_inside_0, fee_growth_inside_1) = tick::get_fee_growth_inside(
            env,
            journal.tick_lower,
            journal.tick_upper,
            current_tick,
            fee_growth_global_0,
            fee_growth_global_1,
        );

        // Create the position NFT (provisional until the mint commits)
        let position = Position {
            owner: owner.clone(),
            tick_lower: journal.tick_lower,
            tick_upper: journal.tick_upper,
            liquidity: amount,
            fee_growth_inside_0_last_x128: fee_growth_inside_0,
            fee_growth_inside_1_last_x128: fee_growth_inside_1,
            tokens_owed_0: 0,
            tokens_owed_1: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Position(journal.position_id), &position);
        operation::advance(env, journal, operation::STEP_ACCOUNTING_UPDATED);

        // Transfer tokens from owner, recording each settlement for rollback
        let token0_addr: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1_addr: Address = env.storage().instance().get(&DataKey::Token1).unwrap();
        let pool = env.current_contract_address();

        Self::transfer_token(env, &token0_addr, owner, &pool, journal.amount_0)?;
        if journal.amount_0 > 0 {
            operation::mark_settled(env, journal, operation::SETTLED_TOKEN_0);
        }

        Self::transfer_token(env, &token1_addr, owner, &pool, journal.amount_1)?;
        if journal.amount_1 > 0 {
            operation::mark_settled(env, journal, operation::SETTLED_TOKEN_1);
        }

        operation::advance(env, journal, operation::STEP_TRANSFERS_SETTLED);

        Ok((journal.position_id, journal.amount_0, journal.amount_1))
    }

    fn execute_burn(
        env: &Env,
        amount: u128,
        current_tick: i32,
        journal: &mut PendingOperation,
    ) -> Result<(u128, u128), ClmmError> {
        // Update ticks
        tick::update_tick(env, journal.tick_lower, -(amount as i128), true)?;
        tick::update_tick(env, journal.tick_upper, amount as i128, true)?;
        operation::advance(env, journal, operation::STEP_TICKS_UPDATED);

        // Update global liquidity if position is active
        if journal.tick_lower <= current_tick && current_tick < journal.tick_upper {
            let liquidity: u128 = env.storage().instance().get(&DataKey::Liquidity).unwrap();
            env.storage()
                .instance()
                .set(&DataKey::Liquidity, &(liquidity - amount));
        }

        // Update position
        let mut position: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(journal.position_id))
            .ok_or(ClmmError::InvalidPosition)?;

        position.liquidity -= amount;
        position.tokens_owed_0 += journal.amount_0;
        position.tokens_owed_1 += journal.amount_1;

        env.storage()
            .persistent()
            .set(&DataKey::Position(journal.position_id), &position);
        operation::advance(env, journal, operation::STEP_ACCOUNTING_UPDATED);

        Ok((journal.amount_0, journal.amount_1))
    }

    fn execute_collect(
        env: &Env,
        journal: &mut PendingOperation,
        fee_growth_inside_0: u128,
        fee_growth_inside_1: u128,
    ) -> Result<(u128, u128), ClmmError> {
        let mut position: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(journal.position_id))
            .ok_or(ClmmError::InvalidPosition)?;

        // Claim first: the advanced checkpoint and cleared owed balance make it
        // impossible to pay the same fees twice if the payout is retried.
        position.fee_growth_inside_0_last_x128 = fee_growth_inside_0;
        position.fee_growth_inside_1_last_x128 = fee_growth_inside_1;
        position.tokens_owed_0 = 0;
        position.tokens_owed_1 = 0;

        env.storage()
            .persistent()
            .set(&DataKey::Position(journal.position_id), &position);
        operation::advance(env, journal, operation::STEP_ACCOUNTING_UPDATED);

        let token0_addr: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1_addr: Address = env.storage().instance().get(&DataKey::Token1).unwrap();
        let pool = env.current_contract_address();
        let owner = position.owner.clone();

        Self::transfer_token(env, &token0_addr, &pool, &owner, journal.amount_0)?;
        if journal.amount_0 > 0 {
            operation::mark_settled(env, journal, operation::SETTLED_TOKEN_0);
        }

        Self::transfer_token(env, &token1_addr, &pool, &owner, journal.amount_1)?;
        if journal.amount_1 > 0 {
            operation::mark_settled(env, journal, operation::SETTLED_TOKEN_1);
        }

        operation::advance(env, journal, operation::STEP_TRANSFERS_SETTLED);

        Ok((journal.amount_0, journal.amount_1))
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
    use soroban_sdk::Env;

    fn setup_pool() -> (Env, ClmmCoreClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(ClmmCore, ());
        let client = ClmmCoreClient::new(&env, &contract_id);

        let token0_admin = Address::generate(&env);
        let token1_admin = Address::generate(&env);

        let token0_contract = env.register_stellar_asset_contract_v2(token0_admin.clone());
        let token1_contract = env.register_stellar_asset_contract_v2(token1_admin.clone());

        let token0 = token0_contract.address();
        let token1 = token1_contract.address();

        // Initialize pool with 1:1 price (sqrt(1) * 2^96 = 2^96)
        let sqrt_price = math::Q96;
        client.initialize(&token0, &token1, &3000, &60, &sqrt_price);

        (env, client, token0, token1)
    }

    fn mint_tokens(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
        let admin_client = StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    fn fund_and_mint(
        env: &Env,
        client: &ClmmCoreClient,
        owner: &Address,
        token0: &Address,
        token1: &Address,
        amount: u128,
    ) -> (u64, u128, u128) {
        mint_tokens(env, token0, owner, 1_000_000);
        mint_tokens(env, token1, owner, 1_000_000);
        client.mint(owner, &-60, &60, &amount, &1_000_000, &1_000_000)
    }

    #[test]
    fn test_initialize() {
        let (_, client, _token0, _token1) = setup_pool();

        assert_eq!(client.get_current_tick(), 0);
        assert_eq!(client.get_sqrt_price(), math::Q96);
        assert_eq!(client.get_liquidity(), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let (_env, client, token0, token1) = setup_pool();

        // Try to initialize again
        client.initialize(&token0, &token1, &3000, &60, &math::Q96);
    }

    #[test]
    fn test_mint_position() {
        let (env, client, token0, token1) = setup_pool();

        let user = Address::generate(&env);
        mint_tokens(&env, &token0, &user, 100_000);
        mint_tokens(&env, &token1, &user, 100_000);

        // Mint position with tick range [-60, 60] (smaller range, aligned to tick spacing)
        let (position_id, amount0, amount1) =
            client.mint(&user, &-60, &60, &100_000, &100_000, &100_000);

        assert_eq!(position_id, 1);

        // Verify position was created
        let position = client.get_position(&position_id);
        assert_eq!(position.owner, user);
        assert_eq!(position.liquidity, 100_000);

        // Deposits were pulled from the owner and parked in the pool
        assert_eq!(
            TokenClient::new(&env, &token0).balance(&user),
            100_000 - amount0 as i128
        );
        assert_eq!(
            TokenClient::new(&env, &token1).balance(&user),
            100_000 - amount1 as i128
        );

        // Nothing is left in flight once the mint commits
        assert_eq!(client.get_pending_operation(&user), None);
    }

    #[test]
    fn test_failed_deposit_rolls_back_and_retry_reuses_position_id() {
        let (env, client, token0, token1) = setup_pool();
        let user = Address::generate(&env);
        mint_tokens(&env, &token0, &user, 1_000_000);

        // token1 is never funded, so the second deposit cannot settle
        let failed = client.try_mint(&user, &-60, &60, &100_000, &1_000_000, &1_000_000);
        assert!(failed.is_err());

        // Accounting, ids and balances are back to their pre-call values
        assert_eq!(client.get_liquidity(), 0);
        assert!(client.try_get_position(&1).is_err());
        assert_eq!(client.get_pending_operation(&user), None);
        assert_eq!(TokenClient::new(&env, &token0).balance(&user), 1_000_000);
        assert_eq!(
            TokenClient::new(&env, &token1).balance(&client.address),
            0,
            "a failed deposit must not leave tokens in the pool"
        );

        // A funded retry reuses the reserved id instead of skipping it
        mint_tokens(&env, &token1, &user, 1_000_000);
        let (position_id, amount0, amount1) =
            client.mint(&user, &-60, &60, &100_000, &1_000_000, &1_000_000);

        assert_eq!(position_id, 1);
        assert_eq!(client.get_liquidity(), 100_000);
        assert_eq!(client.get_position(&position_id).liquidity, 100_000);
        assert_eq!(
            TokenClient::new(&env, &token0).balance(&user),
            1_000_000 - amount0 as i128
        );
        assert_eq!(
            TokenClient::new(&env, &token1).balance(&user),
            1_000_000 - amount1 as i128
        );
    }

    #[test]
    fn test_failed_mint_keeps_existing_position_and_liquidity() {
        let (env, client, token0, token1) = setup_pool();
        let alice = Address::generate(&env);
        let (position_id, _, _) = fund_and_mint(&env, &client, &alice, &token0, &token1, 50_000);

        let position_before = client.get_position(&position_id);
        let liquidity_before = client.get_liquidity();

        // Bob can pay token0 but not token1, so his mint must not touch the pool
        let bob = Address::generate(&env);
        mint_tokens(&env, &token0, &bob, 1_000_000);
        assert!(client
            .try_mint(&bob, &-60, &60, &100_000, &1_000_000, &1_000_000)
            .is_err());

        assert_eq!(client.get_position(&position_id), position_before);
        assert_eq!(client.get_liquidity(), liquidity_before);
        assert!(client.try_get_position(&2).is_err());
        assert_eq!(client.get_pending_operation(&bob), None);

        // Tick state was restored too: a funded retry enters the same range
        mint_tokens(&env, &token1, &bob, 1_000_000);
        let (bob_position_id, _, _) =
            client.mint(&bob, &-60, &60, &100_000, &1_000_000, &1_000_000);

        assert_eq!(bob_position_id, 2);
        assert_eq!(client.get_liquidity(), liquidity_before + 100_000);
    }

    #[test]
    fn test_burn_validation_failure_preserves_state() {
        let (env, client, token0, token1) = setup_pool();
        let user = Address::generate(&env);
        let (position_id, _, _) = fund_and_mint(&env, &client, &user, &token0, &token1, 50_000);

        let position_before = client.get_position(&position_id);
        let liquidity_before = client.get_liquidity();

        assert!(client.try_burn(&position_id, &0).is_err());
        assert!(client.try_burn(&position_id, &50_001).is_err());

        assert_eq!(client.get_position(&position_id), position_before);
        assert_eq!(client.get_liquidity(), liquidity_before);

        // The valid retry still works and accrues the payout on the position
        let (amount0, amount1) = client.burn(&position_id, &50_000);
        let after = client.get_position(&position_id);

        assert_eq!(after.liquidity, 0);
        assert_eq!(after.tokens_owed_0, amount0);
        assert_eq!(after.tokens_owed_1, amount1);
        assert_eq!(client.get_liquidity(), 0);
    }

    #[test]
    fn test_failed_collect_preserves_unpaid_balance_for_retry() {
        let (env, client, token0, token1) = setup_pool();
        let user = Address::generate(&env);
        let (position_id, deposited0, deposited1) =
            fund_and_mint(&env, &client, &user, &token0, &token1, 50_000);

        let (owed0, owed1) = client.burn(&position_id, &50_000);
        // The simplified amount math charges token1 for an in-range position.
        assert_eq!(owed0, 0);
        assert!(owed1 > 0);

        // Drain the pool's token1 balance so only the second payout can fail
        let pool = client.address.clone();
        TokenClient::new(&env, &token1).burn(&pool, &(owed1 as i128));

        assert!(client.try_collect(&position_id).is_err());

        let after_failure = client.get_position(&position_id);
        assert_eq!(
            after_failure.tokens_owed_1, owed1,
            "the unpaid payout must survive for a retry"
        );
        assert_eq!(
            TokenClient::new(&env, &token0).balance(&user),
            1_000_000 - deposited0 as i128 + owed0 as i128,
            "a failed payout must not move tokens"
        );
        assert_eq!(
            TokenClient::new(&env, &token1).balance(&user),
            1_000_000 - deposited1 as i128,
            "a failed payout must not credit the owner"
        );

        // Restoring the pool balance lets the retry settle the remainder once
        mint_tokens(&env, &token1, &pool, owed1 as i128);

        let (retry0, retry1) = client.collect(&position_id);
        assert_eq!(retry0, 0);
        assert_eq!(retry1, owed1);
        assert_eq!(client.get_pending_operation(&user), None);
        assert_eq!(
            TokenClient::new(&env, &token1).balance(&user),
            1_000_000 - deposited1 as i128 + owed1 as i128
        );

        let settled = client.get_position(&position_id);
        assert_eq!(settled.tokens_owed_0, 0);
        assert_eq!(settled.tokens_owed_1, 0);

        // Nothing more is owed, so another collect pays nothing
        assert_eq!(client.collect(&position_id), (0, 0));
    }
}
