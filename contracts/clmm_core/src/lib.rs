#![no_std]
// Contract entry points are generated as flat argument lists (`mint` carries
// the deposit, its two caps and the operation identity), matching the other
// contracts in this workspace.
#![allow(clippy::too_many_arguments)]

//! # CLMM Core - Concentrated Liquidity Market Maker Engine
//!
//! Implements Uniswap V3-style concentrated liquidity with tick-based math,
//! custom price ranges, and NFT-style position tracking for capital efficiency.
//!
//! ## Boundary validation
//!
//! Every value that crosses the contract boundary — initialization parameters,
//! mint/burn/swap arguments, and position records read back from persistent
//! storage — is validated before it is used for accounting. Invalid values return
//! a typed [`ClmmError`] and never mutate pool state, tick state, position records,
//! or token balances.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, xdr::ToXdr, Address,
    Bytes, BytesN, Env, Symbol,
};

mod math;
mod position;
mod tick;

/// Domain separator for position operation identities.
const OPERATION_DOMAIN: &[u8] = b"stellaryield_clmm_op_v1";
/// Refresh an operation receipt once less than ~1 day of ledgers remains.
const OPERATION_TTL_THRESHOLD: u32 = 17_280;
/// Keep consumed operation identities for ~30 days of ledgers, so a delayed
/// retry is still rejected instead of being applied a second time.
const OPERATION_TTL_EXTEND_TO: u32 = 518_400;
/// Maximum supported swap fee, in basis points (100%).
pub const MAX_FEE_BPS: u32 = 10_000;
/// Maximum supported tick spacing. Bounds the tick search loop and rejects
/// malformed pool configuration read from storage.
pub const MAX_TICK_SPACING: i32 = 16_384;

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
    PositionConfigFingerprint(u64),
    ConfigFingerprint,
    NextPositionId,
    /// Marks a domain-separated position operation identity as consumed.
    Operation(BytesN<32>),
}

// ── Data Structures ─────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
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
    pub sequence: u64,
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
    DuplicateOperation = 10,
    ConcurrentModification = 11,
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

        // Validate untrusted configuration before writing any state.
        if fee > MAX_FEE_BPS {
            return Err(ClmmError::InvalidFee);
        }
        if tick_spacing <= 0 || tick_spacing > MAX_TICK_SPACING {
            return Err(ClmmError::InvalidTickSpacing);
        }
        if sqrt_price_x96 < math::MIN_SQRT_RATIO || sqrt_price_x96 > math::MAX_SQRT_RATIO {
            return Err(ClmmError::InvalidSqrtPrice);
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
        let fingerprint = Self::configuration_fingerprint(&env);
        env.storage()
            .instance()
            .set(&DataKey::ConfigFingerprint, &fingerprint);

        env.events().publish(
            (symbol_short!("init"),),
            (token0, token1, fee, tick_spacing, sqrt_price_x96),
        );

        Ok(())
    }

    /// Mint a new liquidity position with custom price range.
    ///
    /// # Arguments
    /// * `owner` — Position owner address
    /// * `tick_lower` — Lower tick boundary
    /// * `tick_upper` — Upper tick boundary
    /// * `amount` — Liquidity amount to add
    /// * `amount0_max` — Maximum token0 to deposit
    /// * `amount1_max` — Maximum token1 to deposit
    /// * `operation_id` — Caller-generated identity for this submission. A
    ///   retry that reuses an identity already consumed by a successful mint
    ///   is rejected with `DuplicateOperation`; a call that fails does not
    ///   consume the identity, so it can be retried safely.
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
        operation_id: BytesN<32>,
    ) -> Result<(u64, u128, u128), ClmmError> {
        Self::require_init(&env)?;
        Self::validate_configuration(&env, None)?;
        owner.require_auth();

        if amount == 0 {
            return Err(ClmmError::InvalidAmount);
        }

        // Liquidity is stored and later converted to `i128` for tick accounting.
        if amount > i128::MAX as u128 {
            return Err(ClmmError::MathOverflow);
        }

        Self::validate_tick_range(&env, tick_lower, tick_upper)?;

        // Mint has no position id yet, so its identity is scoped to the owner
        // and the position id is fixed at zero.
        let operation_key =
            Self::operation_key(&env, &owner, symbol_short!("mint"), 0, &operation_id);
        Self::require_new_operation(&env, &operation_key)?;

        let current_tick: i32 = env.storage().instance().get(&DataKey::CurrentTick).unwrap();
        let sqrt_price: u128 = env
            .storage()
            .instance()
            .get(&DataKey::SqrtPriceX96)
            .unwrap();

        // Calculate required token amounts
        let (amount0, amount1) =
            math::get_amounts_for_liquidity(sqrt_price, tick_lower, tick_upper, amount)?;

        if amount0 > amount0_max || amount1 > amount1_max {
            return Err(ClmmError::InvalidAmount);
        }

        // Compute the next position id up front so an exhausted counter fails
        // before any token transfer or storage write.
        let position_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextPositionId)
            .unwrap_or(1);
        let next_position_id = position_id.checked_add(1).ok_or(ClmmError::MathOverflow)?;

        // Update ticks. Both boundaries add gross liquidity; the `upper` flag
        // records the opposite sign in `liquidity_net`.
        tick::update_tick(&env, tick_lower, amount as i128, false)?;
        tick::update_tick(&env, tick_upper, amount as i128, true)?;

        // Update global liquidity if position is active
        if tick_lower <= current_tick && current_tick < tick_upper {
            let liquidity: u128 = env.storage().instance().get(&DataKey::Liquidity).unwrap();
            let new_liquidity = liquidity
                .checked_add(amount)
                .ok_or(ClmmError::MathOverflow)?;
            env.storage()
                .instance()
                .set(&DataKey::Liquidity, &new_liquidity);
        }

        // Transfer tokens from owner
        let token0_addr: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1_addr: Address = env.storage().instance().get(&DataKey::Token1).unwrap();

        if amount0 > 0 {
            let client0 = token::Client::new(&env, &token0_addr);
            client0.transfer(&owner, &env.current_contract_address(), &(amount0 as i128));
        }
        if amount1 > 0 {
            let client1 = token::Client::new(&env, &token1_addr);
            client1.transfer(&owner, &env.current_contract_address(), &(amount1 as i128));
        }

        // Create position NFT
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
            tick_lower,
            tick_upper,
            current_tick,
            fee_growth_global_0,
            fee_growth_global_1,
        );

        let position = Position {
            owner: owner.clone(),
            tick_lower,
            tick_upper,
            liquidity: amount,
            fee_growth_inside_0_last_x128: fee_growth_inside_0,
            fee_growth_inside_1_last_x128: fee_growth_inside_1,
            tokens_owed_0: 0,
            tokens_owed_1: 0,
            sequence: 1,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Position(position_id), &position);
        let fingerprint = Self::configuration_fingerprint(&env);
        env.storage().persistent().set(
            &DataKey::PositionConfigFingerprint(position_id),
            &fingerprint,
        );
        env.storage()
            .instance()
            .set(&DataKey::NextPositionId, &next_position_id);

        Self::record_operation(&env, &operation_key);

        env.events().publish(
            (symbol_short!("mint"),),
            (position_id, owner.clone(), tick_lower, tick_upper, amount),
        );
        env.events().publish(
            (symbol_short!("pos_seq"),),
            (position_id, position.sequence),
        );
        Self::publish_operation(
            &env,
            &owner,
            symbol_short!("mint"),
            position_id,
            &operation_id,
        );

        Ok((position_id, amount0, amount1))
    }

    /// Burn liquidity from an existing position and collect tokens.
    ///
    /// # Arguments
    /// * `position_id` — ID of the position to burn
    /// * `amount` — Amount of liquidity to remove
    /// * `expected_sequence` — Monotonically increasing sequence number observed
    ///   by the caller. If concurrent operations have modified the position,
    ///   the call fails with `ConcurrentModification` before any ticks, balances
    ///   or state are mutated.
    /// * `operation_id` — Caller-generated identity for this submission,
    ///   scoped to the position owner, the operation kind and the position.
    ///
    /// # Returns
    /// (amount0, amount1) — Amounts of token0 and token1 returned
    pub fn burn(
        env: Env,
        position_id: u64,
        amount: u128,
        expected_sequence: u64,
        operation_id: BytesN<32>,
    ) -> Result<(u128, u128), ClmmError> {
        Self::require_init(&env)?;

        // Treat the persisted record as untrusted: validate its fields before
        // any accounting or state mutation.
        let mut position = position::load_validated_position(&env, position_id)?;

        Self::validate_configuration(&env, Some(position_id))?;

        position.owner.require_auth();

        let operation_key = Self::operation_key(
            &env,
            &position.owner,
            symbol_short!("burn"),
            position_id,
            &operation_id,
        );
        Self::require_new_operation(&env, &operation_key)?;

        if position.sequence != expected_sequence {
            return Err(ClmmError::ConcurrentModification);
        }

        if amount == 0 || amount > position.liquidity {
            return Err(ClmmError::InsufficientLiquidity);
        }
        if amount > i128::MAX as u128 {
            return Err(ClmmError::ArithmeticError);
        }

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
        )?;

        // Compute the resulting balances before mutating anything.
        let remaining_liquidity = position
            .liquidity
            .checked_sub(amount)
            .ok_or(ClmmError::InsufficientLiquidity)?;
        let owed_0 = position
            .tokens_owed_0
            .checked_add(amount0)
            .ok_or(ClmmError::MathOverflow)?;
        let owed_1 = position
            .tokens_owed_1
            .checked_add(amount1)
            .ok_or(ClmmError::MathOverflow)?;

        // Update ticks. Both boundaries remove gross liquidity; the `upper` flag
        // records the opposite sign in `liquidity_net`.
        tick::update_tick(&env, position.tick_lower, -(amount as i128), false)?;
        tick::update_tick(&env, position.tick_upper, -(amount as i128), true)?;

        // Update global liquidity if position is active
        if position.tick_lower <= current_tick && current_tick < position.tick_upper {
            let liquidity: u128 = env.storage().instance().get(&DataKey::Liquidity).unwrap();
            let new_liquidity = liquidity
                .checked_sub(amount)
                .ok_or(ClmmError::InsufficientLiquidity)?;
            env.storage()
                .instance()
                .set(&DataKey::Liquidity, &new_liquidity);
        }

        // Update position
        position.liquidity -= amount;
        position.tokens_owed_0 += amount0;
        position.tokens_owed_1 += amount1;
        position.sequence = position
            .sequence
            .checked_add(1)
            .ok_or(ClmmError::InvalidPosition)?;

        env.storage()
            .persistent()
            .set(&DataKey::Position(position_id), &position);

        Self::record_operation(&env, &operation_key);

        env.events().publish(
            (symbol_short!("burn"),),
            (position_id, amount, amount0, amount1),
        );
        env.events().publish(
            (symbol_short!("pos_seq"),),
            (position_id, position.sequence),
        );
        Self::publish_operation(
            &env,
            &position.owner,
            symbol_short!("burn"),
            position_id,
            &operation_id,
        );

        Ok((amount0, amount1))
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
    ///
    /// Swap accounting uses checked arithmetic: an amount or liquidity that
    /// cannot be represented returns [`ClmmError::MathOverflow`] rather than
    /// aborting the call or wrapping a balance.
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
            .ok_or(ClmmError::NotInitialized)?;
        let mut current_tick: i32 = env
            .storage()
            .instance()
            .get(&DataKey::CurrentTick)
            .ok_or(ClmmError::NotInitialized)?;
        let mut liquidity: u128 = env
            .storage()
            .instance()
            .get(&DataKey::Liquidity)
            .ok_or(ClmmError::NotInitialized)?;

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

            let fee_bps: u32 = env
                .storage()
                .instance()
                .get(&DataKey::Fee)
                .ok_or(ClmmError::NotInitialized)?;
            let (sqrt_price_new, amount_in, amount_out, fee_amount) = math::compute_swap_step(
                sqrt_price,
                sqrt_price_target,
                liquidity,
                amount_remaining,
                fee_bps,
            )?;

            sqrt_price = sqrt_price_new;

            // `amount_in + fee_amount` is an untrusted-derived u128; convert it
            // with a typed error instead of a wrapping `as i128` cast.
            let input_delta = i128::try_from(
                amount_in
                    .checked_add(fee_amount)
                    .ok_or(ClmmError::MathOverflow)?,
            )
            .map_err(|_| ClmmError::MathOverflow)?;
            let output_delta = i128::try_from(amount_out).map_err(|_| ClmmError::MathOverflow)?;

            if exact_input {
                amount_remaining = amount_remaining
                    .checked_sub(input_delta)
                    .ok_or(ClmmError::MathOverflow)?;
                if zero_for_one {
                    amount0 = amount0
                        .checked_add(input_delta)
                        .ok_or(ClmmError::MathOverflow)?;
                    amount1 = amount1
                        .checked_sub(output_delta)
                        .ok_or(ClmmError::MathOverflow)?;
                } else {
                    amount1 = amount1
                        .checked_add(input_delta)
                        .ok_or(ClmmError::MathOverflow)?;
                    amount0 = amount0
                        .checked_sub(output_delta)
                        .ok_or(ClmmError::MathOverflow)?;
                }
            } else {
                amount_remaining = amount_remaining
                    .checked_add(output_delta)
                    .ok_or(ClmmError::MathOverflow)?;
                if zero_for_one {
                    amount0 = amount0
                        .checked_add(input_delta)
                        .ok_or(ClmmError::MathOverflow)?;
                    amount1 = amount1
                        .checked_sub(output_delta)
                        .ok_or(ClmmError::MathOverflow)?;
                } else {
                    amount1 = amount1
                        .checked_add(input_delta)
                        .ok_or(ClmmError::MathOverflow)?;
                    amount0 = amount0
                        .checked_sub(output_delta)
                        .ok_or(ClmmError::MathOverflow)?;
                }
            }

            // Update fee growth
            if liquidity > 0 {
                let fee_growth_delta = fee_amount
                    .checked_mul(math::Q128)
                    .ok_or(ClmmError::MathOverflow)?
                    .checked_div(liquidity)
                    .ok_or(ClmmError::MathOverflow)?;
                if zero_for_one {
                    let fg0: u128 = env
                        .storage()
                        .instance()
                        .get(&DataKey::FeeGrowthGlobal0X128)
                        .unwrap_or(0);
                    let new_fg0 = fg0
                        .checked_add(fee_growth_delta)
                        .ok_or(ClmmError::MathOverflow)?;
                    env.storage()
                        .instance()
                        .set(&DataKey::FeeGrowthGlobal0X128, &new_fg0);
                } else {
                    let fg1: u128 = env
                        .storage()
                        .instance()
                        .get(&DataKey::FeeGrowthGlobal1X128)
                        .unwrap_or(0);
                    let new_fg1 = fg1
                        .checked_add(fee_growth_delta)
                        .ok_or(ClmmError::MathOverflow)?;
                    env.storage()
                        .instance()
                        .set(&DataKey::FeeGrowthGlobal1X128, &new_fg1);
                }
            }

            // Cross tick if we reached the next tick
            if sqrt_price == sqrt_price_next {
                let tick_info = tick::get_tick(&env, tick_next);
                if tick_info.initialized {
                    // `liquidity_net` is signed; never cast it directly to u128.
                    liquidity = Self::apply_liquidity_net(
                        liquidity,
                        tick_info.liquidity_net,
                        !zero_for_one,
                    )?;
                }
                current_tick = if zero_for_one {
                    // Clamp instead of panicking at the minimum tick.
                    tick_next.saturating_sub(1).max(tick::MIN_TICK)
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
    /// # Arguments
    /// * `position_id` — Position ID to collect from
    /// * `expected_sequence` — Monotonically increasing sequence number observed
    ///   by the caller. If concurrent operations have modified the position,
    ///   the call fails with `ConcurrentModification` before any checkpoints,
    ///   balances or state are mutated.
    /// * `operation_id` — Caller-generated identity for this submission,
    ///   scoped to the position owner, the operation kind and the position.
    ///
    /// # Returns
    /// (amount0, amount1) — Fee amounts collected
    pub fn collect(
        env: Env,
        position_id: u64,
        expected_sequence: u64,
        operation_id: BytesN<32>,
    ) -> Result<(u128, u128), ClmmError> {
        Self::require_init(&env)?;

        // Validate the persisted record before computing or transferring fees.
        let mut position = position::load_validated_position(&env, position_id)?;

        Self::validate_configuration(&env, Some(position_id))?;

        position.owner.require_auth();

        let operation_key = Self::operation_key(
            &env,
            &position.owner,
            symbol_short!("collect"),
            position_id,
            &operation_id,
        );
        Self::require_new_operation(&env, &operation_key)?;

        if position.sequence != expected_sequence {
            return Err(ClmmError::ConcurrentModification);
        }

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
        )?;

        let collect_0 = position
            .tokens_owed_0
            .checked_add(fees_0)
            .ok_or(ClmmError::MathOverflow)?;
        let collect_1 = position
            .tokens_owed_1
            .checked_add(fees_1)
            .ok_or(ClmmError::MathOverflow)?;

        // Token transfers take `i128`; reject totals outside that domain with a
        // typed error instead of wrapping.
        let payout_0 = i128::try_from(collect_0).map_err(|_| ClmmError::MathOverflow)?;
        let payout_1 = i128::try_from(collect_1).map_err(|_| ClmmError::MathOverflow)?;

        // Transfer fees to owner
        let token0_addr: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1_addr: Address = env.storage().instance().get(&DataKey::Token1).unwrap();

        if collect_0 > 0 {
            let client0 = token::Client::new(&env, &token0_addr);
            client0.transfer(&env.current_contract_address(), &position.owner, &payout_0);
        }
        if collect_1 > 0 {
            let client1 = token::Client::new(&env, &token1_addr);
            client1.transfer(&env.current_contract_address(), &position.owner, &payout_1);
        }

        // Update position
        position.fee_growth_inside_0_last_x128 = fee_growth_inside_0;
        position.fee_growth_inside_1_last_x128 = fee_growth_inside_1;
        position.tokens_owed_0 = 0;
        position.tokens_owed_1 = 0;
        position.sequence = position
            .sequence
            .checked_add(1)
            .ok_or(ClmmError::InvalidPosition)?;

        env.storage()
            .persistent()
            .set(&DataKey::Position(position_id), &position);

        Self::record_operation(&env, &operation_key);

        env.events().publish(
            (symbol_short!("collect"),),
            (position_id, collect_0, collect_1),
        );
        env.events().publish(
            (symbol_short!("pos_seq"),),
            (position_id, position.sequence),
        );
        Self::publish_operation(
            &env,
            &position.owner,
            symbol_short!("collect"),
            position_id,
            &operation_id,
        );

        Ok((collect_0, collect_1))
    }

    // ── View Functions ──────────────────────────────────────────────

    pub fn get_position(env: Env, position_id: u64) -> Result<Position, ClmmError> {
        position::load_validated_position(&env, position_id)
    }

    pub fn get_position_sequence(env: Env, position_id: u64) -> Result<u64, ClmmError> {
        let position: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(position_id))
            .ok_or(ClmmError::InvalidPosition)?;
        Ok(position.sequence)
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

    /// Domain-separated identity of one position operation.
    ///
    /// The preimage binds the deployment, owner, operation kind, position and
    /// caller-supplied id, so the same id cannot be replayed across accounts,
    /// operations or deployments, and an unrelated caller cannot consume it.
    fn operation_key(
        env: &Env,
        owner: &Address,
        kind: Symbol,
        position_id: u64,
        operation_id: &BytesN<32>,
    ) -> BytesN<32> {
        let mut preimage = Bytes::from_slice(env, OPERATION_DOMAIN);
        preimage.append(
            &(
                env.current_contract_address(),
                owner.clone(),
                kind,
                position_id,
                operation_id.clone(),
            )
                .to_xdr(env),
        );
        env.crypto().sha256(&preimage).to_bytes()
    }

    /// Reject an identity already consumed by a successful operation.
    fn require_new_operation(env: &Env, key: &BytesN<32>) -> Result<(), ClmmError> {
        if env.storage().persistent().has(key) {
            return Err(ClmmError::DuplicateOperation);
        }
        Ok(())
    }

    /// Mark an identity consumed once its effect is durable, and keep the
    /// receipt alive long enough that a delayed retry is still rejected.
    fn record_operation(env: &Env, key: &BytesN<32>) {
        env.storage().persistent().set(key, &true);
        env.storage().persistent().extend_ttl(
            key,
            OPERATION_TTL_THRESHOLD,
            OPERATION_TTL_EXTEND_TO,
        );
    }

    /// Emit the retry-correlation event for a consumed operation identity.
    fn publish_operation(
        env: &Env,
        owner: &Address,
        kind: Symbol,
        position_id: u64,
        operation_id: &BytesN<32>,
    ) {
        env.events().publish(
            (symbol_short!("op"),),
            (owner.clone(), kind, position_id, operation_id.clone()),
        );
    }

    fn require_init(env: &Env) -> Result<(), ClmmError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(ClmmError::NotInitialized);
        }
        Ok(())
    }

    /// Apply a signed tick liquidity delta to the pool's active liquidity.
    ///
    /// `add` selects the direction (add when crossing upward, subtract when
    /// crossing downward) and `net` supplies the magnitude and sign. Returns a
    /// typed error instead of wrapping on underflow, which is what the previous
    /// `liquidity_net as u128` cast did for negative net liquidity.
    fn apply_liquidity_net(liquidity: u128, net: i128, add: bool) -> Result<u128, ClmmError> {
        let magnitude = net.unsigned_abs();
        let increasing = add == (net >= 0);

        if increasing {
            liquidity
                .checked_add(magnitude)
                .ok_or(ClmmError::MathOverflow)
        } else {
            liquidity
                .checked_sub(magnitude)
                .ok_or(ClmmError::InsufficientLiquidity)
        }
    }

    fn validate_tick_range(env: &Env, tick_lower: i32, tick_upper: i32) -> Result<(), ClmmError> {
        if tick_lower >= tick_upper {
            return Err(ClmmError::InvalidTickRange);
        }

        // Read through the validating accessor: persisted configuration is
        // untrusted, and a zero spacing would otherwise panic on `%`.
        let tick_spacing = tick::get_tick_spacing(env)?;

        if tick_lower % tick_spacing != 0 || tick_upper % tick_spacing != 0 {
            return Err(ClmmError::InvalidTick);
        }

        if tick_lower < tick::MIN_TICK || tick_upper > tick::MAX_TICK {
            return Err(ClmmError::InvalidTick);
        }

        Ok(())
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
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
        let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    fn balance(env: &Env, token_addr: &Address, who: &Address) -> i128 {
        soroban_sdk::token::Client::new(env, token_addr).balance(who)
    }

    /// Deterministic caller-generated operation identity for tests.
    fn operation_id(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &[seed; 32])
    }

    /// Open a position of 100_000 liquidity over [-60, 60] and return its owner.
    fn open_position(
        env: &Env,
        client: &ClmmCoreClient<'static>,
        token0: &Address,
        token1: &Address,
    ) -> (Address, u64) {
        let owner = Address::generate(env);
        mint_tokens(env, token0, &owner, 100_000);
        mint_tokens(env, token1, &owner, 100_000);
        let (position_id, ..) = client.mint(
            &owner,
            &-60,
            &60,
            &100_000,
            &100_000,
            &100_000,
            &operation_id(env, 1),
        );
        (owner, position_id)
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
        mint_tokens(&env, &token0, &user, 1_000_000_000_000_000_000);
        mint_tokens(&env, &token1, &user, 1_000_000_000_000_000_000);

        // Mint position with tick range [-60, 60] (smaller range, aligned to tick spacing)
        let (position_id, amount0, amount1) = client.mint(
            &user,
            &-60,
            &60,
            &100_000,
            &100_000,
            &100_000,
            &operation_id(&env, 1),
        );

        assert_eq!(position_id, 1);
        assert!(amount1 > 0);

        // Verify position was created and the pool received the reported deposit
        let position = client.get_position(&position_id);
        assert_eq!(position.owner, user);
        assert_eq!(position.liquidity, 100_000);
        assert_eq!(balance(&env, &token0, &client.address), amount0 as i128);
        assert_eq!(balance(&env, &token1, &client.address), amount1 as i128);
    }

    #[test]
    fn test_duplicate_mint_is_rejected_and_state_is_preserved() {
        let (env, client, token0, token1) = setup_pool();
        let user = Address::generate(&env);
        mint_tokens(&env, &token0, &user, 100_000);
        mint_tokens(&env, &token1, &user, 100_000);
        let id = operation_id(&env, 7);

        let (position_id, ..) = client.mint(&user, &-60, &60, &100_000, &100_000, &100_000, &id);
        let user0 = balance(&env, &token0, &user);
        let user1 = balance(&env, &token1, &user);
        let pool0 = balance(&env, &token0, &client.address);
        let pool1 = balance(&env, &token1, &client.address);
        let liquidity = client.get_liquidity();

        // The same submission again must not create a second position or move funds.
        let retry = client.try_mint(&user, &-60, &60, &100_000, &100_000, &100_000, &id);
        assert_eq!(retry, Err(Ok(ClmmError::DuplicateOperation)));

        assert_eq!(balance(&env, &token0, &user), user0);
        assert_eq!(balance(&env, &token1, &user), user1);
        assert_eq!(balance(&env, &token0, &client.address), pool0);
        assert_eq!(balance(&env, &token1, &client.address), pool1);
        assert_eq!(client.get_liquidity(), liquidity);

        // A distinct id still mints normally, so the rejected retry consumed nothing.
        let (next_id, ..) = client.mint(
            &user,
            &-60,
            &60,
            &1_000,
            &100_000,
            &100_000,
            &operation_id(&env, 8),
        );
        assert_eq!(next_id, position_id + 1);
    }

    #[test]
    fn test_failed_mint_does_not_consume_the_operation_id() {
        let (env, client, token0, token1) = setup_pool();
        let user = Address::generate(&env);
        mint_tokens(&env, &token0, &user, 100_000);
        mint_tokens(&env, &token1, &user, 100_000);
        let id = operation_id(&env, 9);

        // Rejected before any transfer: the caps cannot cover the deposit.
        let failed = client.try_mint(&user, &-60, &60, &100_000, &0, &0, &id);
        assert_eq!(failed, Err(Ok(ClmmError::InvalidAmount)));
        assert_eq!(balance(&env, &token0, &user), 100_000);
        assert_eq!(balance(&env, &token1, &user), 100_000);

        // The same identity is still valid for a retry.
        let (position_id, ..) = client.mint(&user, &-60, &60, &100_000, &100_000, &100_000, &id);
        assert_eq!(position_id, 1);
        assert_eq!(client.get_position(&position_id).liquidity, 100_000);
    }

    #[test]
    fn test_duplicate_burn_is_rejected_and_liquidity_is_preserved() {
        let (env, client, token0, token1) = setup_pool();
        let (owner, position_id) = open_position(&env, &client, &token0, &token1);
        let id = operation_id(&env, 2);

        client.burn(&position_id, &40_000, &1, &id);
        let after = client.get_position(&position_id);
        assert_eq!(after.sequence, 2);
        let liquidity = client.get_liquidity();
        let owner0 = balance(&env, &token0, &owner);
        let owner1 = balance(&env, &token1, &owner);

        let retry = client.try_burn(&position_id, &40_000, &2, &id);
        assert_eq!(retry, Err(Ok(ClmmError::DuplicateOperation)));

        let now = client.get_position(&position_id);
        assert_eq!(now.liquidity, after.liquidity);
        assert_eq!(now.tokens_owed_0, after.tokens_owed_0);
        assert_eq!(now.tokens_owed_1, after.tokens_owed_1);
        assert_eq!(now.sequence, after.sequence);
        assert_eq!(client.get_liquidity(), liquidity);
        assert_eq!(balance(&env, &token0, &owner), owner0);
        assert_eq!(balance(&env, &token1, &owner), owner1);
    }

    #[test]
    fn test_failed_burn_does_not_consume_the_operation_id() {
        let (env, client, token0, token1) = setup_pool();
        let (_owner, position_id) = open_position(&env, &client, &token0, &token1);
        let id = operation_id(&env, 3);

        let failed = client.try_burn(&position_id, &100_001, &1, &id);
        assert_eq!(failed, Err(Ok(ClmmError::InsufficientLiquidity)));
        assert_eq!(client.get_position(&position_id).liquidity, 100_000);
        assert_eq!(client.get_position(&position_id).sequence, 1);

        client.burn(&position_id, &40_000, &1, &id);
        assert_eq!(client.get_position(&position_id).liquidity, 60_000);
        assert_eq!(client.get_position(&position_id).sequence, 2);
    }

    #[test]
    fn test_duplicate_collect_is_rejected_and_pays_once() {
        let (env, client, token0, token1) = setup_pool();
        let (owner, position_id) = open_position(&env, &client, &token0, &token1);
        let id = operation_id(&env, 4);

        assert_eq!(client.collect(&position_id, &1, &id), (0, 0));
        assert_eq!(client.get_position(&position_id).sequence, 2);
        let owner0 = balance(&env, &token0, &owner);
        let owner1 = balance(&env, &token1, &owner);

        let retry = client.try_collect(&position_id, &2, &id);
        assert_eq!(retry, Err(Ok(ClmmError::DuplicateOperation)));
        assert_eq!(balance(&env, &token0, &owner), owner0);
        assert_eq!(balance(&env, &token1, &owner), owner1);

        // A fresh identity collects later without re-applying the first effect.
        assert_eq!(
            client.collect(&position_id, &2, &operation_id(&env, 5)),
            (0, 0)
        );
        assert_eq!(client.get_position(&position_id).sequence, 3);
    }

    #[test]
    fn test_operation_ids_are_scoped_to_the_owner() {
        let (env, client, token0, token1) = setup_pool();
        let id = operation_id(&env, 11);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        mint_tokens(&env, &token0, &alice, 50_000);
        mint_tokens(&env, &token1, &alice, 50_000);
        mint_tokens(&env, &token0, &bob, 50_000);
        mint_tokens(&env, &token1, &bob, 50_000);

        let (alice_position, ..) = client.mint(&alice, &-60, &60, &10_000, &50_000, &50_000, &id);
        let (bob_position, ..) = client.mint(&bob, &-60, &60, &10_000, &50_000, &50_000, &id);

        assert_ne!(alice_position, bob_position);
        // Alice's id is consumed for her; Bob's identical id was never hers to spend.
        let replay = client.try_mint(&alice, &-60, &60, &10_000, &50_000, &50_000, &id);
        assert_eq!(replay, Err(Ok(ClmmError::DuplicateOperation)));
    }

    #[test]
    fn test_operation_ids_are_scoped_to_the_operation_kind() {
        let (env, client, token0, token1) = setup_pool();
        let (owner, position_id) = open_position(&env, &client, &token0, &token1);
        let id = operation_id(&env, 12);

        // The mint above used id 1; the same value is free for a burn and a collect.
        client.burn(&position_id, &1_000, &1, &id);
        assert!(client.try_collect(&position_id, &2, &id).is_ok());

        let owner_now = client.get_position(&position_id);
        assert_eq!(owner_now.owner, owner);
        assert_eq!(owner_now.liquidity, 99_000);
        assert_eq!(owner_now.sequence, 3);
    }

    #[test]
    fn test_normal_operation_sequence_lifecycle() {
        let (env, client, token0, token1) = setup_pool();
        let (_owner, position_id) = open_position(&env, &client, &token0, &token1);

        // Initial sequence after mint is 1
        assert_eq!(client.get_position(&position_id).sequence, 1);
        assert_eq!(client.get_position_sequence(&position_id), 1);

        // Burn with matching sequence 1 advances sequence to 2
        let (b0, b1) = client.burn(&position_id, &25_000, &1, &operation_id(&env, 20));
        assert!(b0 > 0 || b1 > 0);
        assert_eq!(client.get_position(&position_id).sequence, 2);
        assert_eq!(client.get_position_sequence(&position_id), 2);
        assert_eq!(client.get_position(&position_id).liquidity, 75_000);

        // Collect with matching sequence 2 advances sequence to 3
        let (c0, c1) = client.collect(&position_id, &2, &operation_id(&env, 21));
        assert_eq!(c0, b0);
        assert_eq!(c1, b1);
        assert_eq!(client.get_position(&position_id).sequence, 3);
        assert_eq!(client.get_position_sequence(&position_id), 3);

        // Second burn with matching sequence 3 advances sequence to 4
        client.burn(&position_id, &25_000, &3, &operation_id(&env, 22));
        assert_eq!(client.get_position(&position_id).sequence, 4);
        assert_eq!(client.get_position_sequence(&position_id), 4);
        assert_eq!(client.get_position(&position_id).liquidity, 50_000);
    }

    #[test]
    fn test_burn_with_stale_sequence_is_rejected_and_preserves_state() {
        let (env, client, token0, token1) = setup_pool();
        let (owner, position_id) = open_position(&env, &client, &token0, &token1);

        let initial_position = client.get_position(&position_id);
        assert_eq!(initial_position.sequence, 1);
        let pool_liquidity = client.get_liquidity();
        let owner_balance_0 = balance(&env, &token0, &owner);
        let owner_balance_1 = balance(&env, &token1, &owner);
        let pool_balance_0 = balance(&env, &token0, &client.address);
        let pool_balance_1 = balance(&env, &token1, &client.address);

        // Attempt burn with stale / mismatched sequence (e.g., 0, 2, 99)
        let stale_res = client.try_burn(&position_id, &30_000, &0, &operation_id(&env, 30));
        assert_eq!(stale_res, Err(Ok(ClmmError::ConcurrentModification)));

        let mismatched_res = client.try_burn(&position_id, &30_000, &99, &operation_id(&env, 31));
        assert_eq!(mismatched_res, Err(Ok(ClmmError::ConcurrentModification)));

        // Verify position state is completely preserved
        let position_after = client.get_position(&position_id);
        assert_eq!(position_after, initial_position);
        assert_eq!(client.get_position_sequence(&position_id), 1);

        // Verify pool liquidity and balances are untouched
        assert_eq!(client.get_liquidity(), pool_liquidity);
        assert_eq!(balance(&env, &token0, &owner), owner_balance_0);
        assert_eq!(balance(&env, &token1, &owner), owner_balance_1);
        assert_eq!(balance(&env, &token0, &client.address), pool_balance_0);
        assert_eq!(balance(&env, &token1, &client.address), pool_balance_1);
    }

    #[test]
    fn test_collect_with_stale_sequence_is_rejected_and_preserves_state() {
        let (env, client, token0, token1) = setup_pool();
        let (owner, position_id) = open_position(&env, &client, &token0, &token1);

        // Burn 20_000 to accrue tokens_owed on the position; sequence becomes 2
        client.burn(&position_id, &20_000, &1, &operation_id(&env, 40));
        let position_before = client.get_position(&position_id);
        assert_eq!(position_before.sequence, 2);
        assert!(position_before.tokens_owed_0 > 0 || position_before.tokens_owed_1 > 0);

        let owner_balance_0 = balance(&env, &token0, &owner);
        let owner_balance_1 = balance(&env, &token1, &owner);
        let pool_balance_0 = balance(&env, &token0, &client.address);
        let pool_balance_1 = balance(&env, &token1, &client.address);

        // Attempt collect with stale sequence 1
        let stale_res = client.try_collect(&position_id, &1, &operation_id(&env, 41));
        assert_eq!(stale_res, Err(Ok(ClmmError::ConcurrentModification)));

        // Attempt collect with future sequence 99
        let future_res = client.try_collect(&position_id, &99, &operation_id(&env, 42));
        assert_eq!(future_res, Err(Ok(ClmmError::ConcurrentModification)));

        // Verify tokens owed and fee checkpoints are preserved
        let position_after = client.get_position(&position_id);
        assert_eq!(position_after, position_before);
        assert_eq!(position_after.sequence, 2);

        // Balances remain untouched
        assert_eq!(balance(&env, &token0, &owner), owner_balance_0);
        assert_eq!(balance(&env, &token1, &owner), owner_balance_1);
        assert_eq!(balance(&env, &token0, &client.address), pool_balance_0);
        assert_eq!(balance(&env, &token1, &client.address), pool_balance_1);
    }

    #[test]
    fn test_concurrent_state_collision_and_safe_retry() {
        let (env, client, token0, token1) = setup_pool();
        let (_owner, position_id) = open_position(&env, &client, &token0, &token1);

        // Two callers (or concurrent workers) both observed sequence 1
        let seq_snapshot = client.get_position_sequence(&position_id);
        assert_eq!(seq_snapshot, 1);

        let id_worker_a = operation_id(&env, 50);
        let id_worker_b = operation_id(&env, 51);

        // Worker A executes first and succeeds, bumping sequence to 2
        client.burn(&position_id, &20_000, &seq_snapshot, &id_worker_a);
        assert_eq!(client.get_position_sequence(&position_id), 2);
        assert_eq!(client.get_position(&position_id).liquidity, 80_000);

        // Worker B's transaction arrives with the now-stale snapshot (sequence 1)
        let collision_res = client.try_burn(&position_id, &30_000, &seq_snapshot, &id_worker_b);
        assert_eq!(collision_res, Err(Ok(ClmmError::ConcurrentModification)));

        // State was not corrupted by Worker B's failed attempt
        assert_eq!(client.get_position(&position_id).liquidity, 80_000);
        assert_eq!(client.get_position_sequence(&position_id), 2);

        // Worker B re-reads the position, obtains updated sequence 2, and retries safely
        let updated_seq = client.get_position_sequence(&position_id);
        assert_eq!(updated_seq, 2);

        let (b0, b1) = client.burn(&position_id, &30_000, &updated_seq, &id_worker_b);
        assert!(b0 > 0 || b1 > 0);
        assert_eq!(client.get_position(&position_id).liquidity, 50_000);
        assert_eq!(client.get_position_sequence(&position_id), 3);
    }

    #[test]
    fn test_concurrent_burn_and_collect_collision_and_safe_retry() {
        let (env, client, token0, token1) = setup_pool();
        let (owner, position_id) = open_position(&env, &client, &token0, &token1);

        // Both burn and collect are initiated concurrently based on sequence 1
        let seq_snapshot = client.get_position_sequence(&position_id);
        assert_eq!(seq_snapshot, 1);

        let id_burn = operation_id(&env, 60);
        let id_collect = operation_id(&env, 61);

        // Burn lands first, advancing sequence to 2
        client.burn(&position_id, &15_000, &seq_snapshot, &id_burn);
        assert_eq!(client.get_position_sequence(&position_id), 2);

        // Concurrent collect with stale sequence 1 is rejected
        let collect_res = client.try_collect(&position_id, &seq_snapshot, &id_collect);
        assert_eq!(collect_res, Err(Ok(ClmmError::ConcurrentModification)));

        let bal_before_0 = balance(&env, &token0, &owner);
        let bal_before_1 = balance(&env, &token1, &owner);

        // Collect refreshes to sequence 2 and retries safely
        let refreshed_seq = client.get_position_sequence(&position_id);
        assert_eq!(refreshed_seq, 2);

        let (collected_0, collected_1) = client.collect(&position_id, &refreshed_seq, &id_collect);
        assert!(collected_0 > 0 || collected_1 > 0);
        assert_eq!(client.get_position_sequence(&position_id), 3);
        assert_eq!(client.get_position(&position_id).tokens_owed_0, 0);
        assert_eq!(client.get_position(&position_id).tokens_owed_1, 0);
        assert_eq!(
            balance(&env, &token0, &owner),
            bal_before_0 + collected_0 as i128
        );
        assert_eq!(
            balance(&env, &token1, &owner),
            bal_before_1 + collected_1 as i128
        );
    }

    #[test]
    fn test_failed_concurrency_check_does_not_consume_the_operation_id() {
        let (env, client, token0, token1) = setup_pool();
        let (_owner, position_id) = open_position(&env, &client, &token0, &token1);
        let id = operation_id(&env, 70);

        // Rejected due to sequence mismatch: operation id is NOT consumed
        let failed = client.try_burn(&position_id, &10_000, &99, &id);
        assert_eq!(failed, Err(Ok(ClmmError::ConcurrentModification)));

        // Safe retry with correct sequence using the SAME operation id succeeds
        client.burn(&position_id, &10_000, &1, &id);
        assert_eq!(client.get_position_sequence(&position_id), 2);

        // Once consumed, submitting the same operation id again is rejected with DuplicateOperation
        let duplicate = client.try_burn(&position_id, &10_000, &2, &id);
        assert_eq!(duplicate, Err(Ok(ClmmError::DuplicateOperation)));
    }

    /// Write a position record directly into persistent storage, simulating
    /// malformed external data (or a legacy/corrupt record) reconstructed by the
    /// indexer.
    fn write_position(env: &Env, contract_id: &Address, position_id: u64, position: &Position) {
        env.as_contract(contract_id, || {
            env.storage()
                .persistent()
                .set(&DataKey::Position(position_id), position);
        });
    }

    #[test]
    fn test_initialize_rejects_malformed_config() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(ClmmCore, ());
        let client = ClmmCoreClient::new(&env, &contract_id);

        let token0 = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let token1 = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();

        // Fee above 100% is rejected.
        assert_eq!(
            client.try_initialize(&token0, &token1, &10_001, &60, &math::Q96),
            Err(Ok(ClmmError::InvalidFee))
        );

        // Zero and negative tick spacing are rejected (zero would panic on `%`).
        assert_eq!(
            client.try_initialize(&token0, &token1, &3000, &0, &math::Q96),
            Err(Ok(ClmmError::InvalidTickSpacing))
        );
        assert_eq!(
            client.try_initialize(&token0, &token1, &3000, &-60, &math::Q96),
            Err(Ok(ClmmError::InvalidTickSpacing))
        );

        // sqrt price below the representable minimum is rejected.
        assert_eq!(
            client.try_initialize(&token0, &token1, &3000, &60, &1u128),
            Err(Ok(ClmmError::InvalidSqrtPrice))
        );

        // A failed initialize must leave the pool uninitialized.
        assert_eq!(
            client.try_mint(
                &Address::generate(&env),
                &-60,
                &60,
                &1,
                &1,
                &1,
                &operation_id(&env, 20),
            ),
            Err(Ok(ClmmError::NotInitialized))
        );

        // Safe retry with valid configuration succeeds.
        assert!(client
            .try_initialize(&token0, &token1, &3000, &60, &math::Q96)
            .is_ok());
        assert_eq!(client.get_sqrt_price(), math::Q96);
    }

    #[test]
    fn test_mint_rejects_invalid_fields_without_state_change() {
        let (env, client, token0, token1) = setup_pool();

        let user = Address::generate(&env);
        mint_tokens(&env, &token0, &user, 1_000_000);
        mint_tokens(&env, &token1, &user, 1_000_000);
        let id = operation_id(&env, 21);

        // Ticks not aligned with the pool tick spacing.
        assert_eq!(
            client.try_mint(&user, &-61, &60, &1_000, &u128::MAX, &u128::MAX, &id),
            Err(Ok(ClmmError::InvalidTick))
        );
        // Inverted range.
        assert_eq!(
            client.try_mint(&user, &60, &-60, &1_000, &u128::MAX, &u128::MAX, &id),
            Err(Ok(ClmmError::InvalidTickRange))
        );
        // Aligned but outside the supported tick domain.
        assert_eq!(
            client.try_mint(&user, &-60, &887_280, &1_000, &u128::MAX, &u128::MAX, &id),
            Err(Ok(ClmmError::InvalidTick))
        );
        // Zero liquidity.
        assert_eq!(
            client.try_mint(&user, &-60, &60, &0, &u128::MAX, &u128::MAX, &id),
            Err(Ok(ClmmError::InvalidAmount))
        );
        // Liquidity larger than i128 cannot be represented in tick accounting.
        assert_eq!(
            client.try_mint(&user, &-60, &60, &u128::MAX, &u128::MAX, &u128::MAX, &id),
            Err(Ok(ClmmError::MathOverflow))
        );

        // No position was created, no liquidity was added, and no funds moved.
        assert_eq!(client.get_liquidity(), 0);
        assert_eq!(
            client.try_get_position(&1),
            Err(Ok(ClmmError::InvalidPosition))
        );
        assert_eq!(balance(&env, &token0, &user), 1_000_000);
        assert_eq!(balance(&env, &token1, &user), 1_000_000);
        assert_eq!(balance(&env, &token0, &client.address), 0);
        assert_eq!(balance(&env, &token1, &client.address), 0);

        // Safe retry with the same operation identity succeeds: the failed
        // validation pass did not consume it.
        let (position_id, amount0, amount1) =
            client.mint(&user, &-60, &60, &100_000, &u128::MAX, &u128::MAX, &id);
        assert_eq!(position_id, 1);
        assert_eq!(client.get_position(&position_id).liquidity, 100_000);
        assert_eq!(client.get_liquidity(), 100_000);
        assert_eq!(balance(&env, &token0, &client.address), amount0 as i128);
        assert_eq!(balance(&env, &token1, &client.address), amount1 as i128);
    }

    #[test]
    fn test_burn_and_collect_preserve_accounting() {
        let (env, client, token0, token1) = setup_pool();
        let (owner, position_id) = open_position(&env, &client, &token0, &token1);
        let pool0 = balance(&env, &token0, &client.address);
        let pool1 = balance(&env, &token1, &client.address);

        // Burning half returns exactly the pro-rata share tracked by the position.
        let (burned0, burned1) = client.burn(&position_id, &50_000, &operation_id(&env, 22));
        let position = client.get_position(&position_id);

        assert_eq!(position.liquidity, 50_000);
        assert_eq!(position.tokens_owed_0, burned0);
        assert_eq!(position.tokens_owed_1, burned1);
        assert_eq!(client.get_liquidity(), 50_000);
        // Burning accrues tokens owed; it does not move pool balances.
        assert_eq!(balance(&env, &token0, &client.address), pool0);
        assert_eq!(balance(&env, &token1, &client.address), pool1);

        // A zero-amount burn is rejected with a typed error, and the safe
        // retry leaves the remaining position intact.
        let retry_id = operation_id(&env, 23);
        assert_eq!(
            client.try_burn(&position_id, &0, &retry_id),
            Err(Ok(ClmmError::InvalidAmount))
        );
        assert_eq!(client.get_position(&position_id).liquidity, 50_000);
        let (reburned0, reburned1) = client.burn(&position_id, &10_000, &retry_id);
        assert_eq!(client.get_position(&position_id).liquidity, 40_000);

        // Collect pays the recorded tokens once and zeroes the owed balances.
        let owner0 = balance(&env, &token0, &owner);
        let owner1 = balance(&env, &token1, &owner);
        let (collected0, collected1) = client.collect(&position_id, &operation_id(&env, 24));
        assert_eq!(collected0, burned0 + reburned0);
        assert_eq!(collected1, burned1 + reburned1);
        assert_eq!(client.get_position(&position_id).tokens_owed_0, 0);
        assert_eq!(client.get_position(&position_id).tokens_owed_1, 0);
        assert_eq!(balance(&env, &token0, &owner), owner0 + collected0 as i128);
        assert_eq!(balance(&env, &token1, &owner), owner1 + collected1 as i128);
    }

    #[test]
    fn test_corrupted_position_is_rejected_without_mutation() {
        let (env, client, token0, token1) = setup_pool();
        let (_owner, position_id) = open_position(&env, &client, &token0, &token1);

        let good_position = client.get_position(&position_id);
        let pool0 = balance(&env, &token0, &client.address);
        let pool1 = balance(&env, &token1, &client.address);

        // Malformed record: inverted range and liquidity that cannot fit in i128.
        let mut bad_position = good_position.clone();
        bad_position.tick_lower = 60;
        bad_position.tick_upper = -60;
        bad_position.liquidity = u128::MAX;
        write_position(&env, &client.address, position_id, &bad_position);

        assert_eq!(
            client.try_get_position(&position_id),
            Err(Ok(ClmmError::CorruptedPosition))
        );
        assert_eq!(
            client.try_burn(&position_id, &1_000, &operation_id(&env, 25)),
            Err(Ok(ClmmError::CorruptedPosition))
        );
        assert_eq!(
            client.try_collect(&position_id, &operation_id(&env, 26)),
            Err(Ok(ClmmError::CorruptedPosition))
        );

        // Pool state and balances are untouched by the rejected calls.
        assert_eq!(client.get_liquidity(), 100_000);
        assert_eq!(balance(&env, &token0, &client.address), pool0);
        assert_eq!(balance(&env, &token1, &client.address), pool1);

        // Restoring a valid record makes the operation retryable.
        write_position(&env, &client.address, position_id, &good_position);
        assert_eq!(client.get_position(&position_id).liquidity, 100_000);
        client.burn(&position_id, &10_000, &operation_id(&env, 27));
        assert_eq!(client.get_position(&position_id).liquidity, 90_000);
    }

    #[test]
    fn test_collect_rejects_inconsistent_fee_growth() {
        let (env, client, token0, token1) = setup_pool();
        let (_owner, position_id) = open_position(&env, &client, &token0, &token1);
        let good_position = client.get_position(&position_id);

        let pool0 = balance(&env, &token0, &client.address);
        let pool1 = balance(&env, &token1, &client.address);

        // A stored "last" fee growth greater than the current growth used to
        // underflow and panic inside `collect`.
        let mut bad_position = good_position.clone();
        bad_position.fee_growth_inside_0_last_x128 = u128::MAX;
        write_position(&env, &client.address, position_id, &bad_position);

        let id = operation_id(&env, 28);
        assert_eq!(
            client.try_collect(&position_id, &id),
            Err(Ok(ClmmError::CorruptedPosition))
        );
        assert_eq!(balance(&env, &token0, &client.address), pool0);
        assert_eq!(balance(&env, &token1, &client.address), pool1);

        // Safe retry with the same identity after the record is repaired.
        write_position(&env, &client.address, position_id, &good_position);
        assert_eq!(client.collect(&position_id, &id), (0, 0));
        assert_eq!(client.get_position(&position_id).liquidity, 100_000);
    }

    #[test]
    fn test_malformed_tick_spacing_is_rejected() {
        let (env, client, token0, token1) = setup_pool();
        let (owner, position_id) = open_position(&env, &client, &token0, &token1);

        // Corrupt the persisted pool configuration.
        env.as_contract(&client.address, || {
            env.storage().instance().set(&DataKey::TickSpacing, &0i32);
        });

        assert_eq!(
            client.try_mint(
                &owner,
                &-60,
                &60,
                &1_000,
                &u128::MAX,
                &u128::MAX,
                &operation_id(&env, 29)
            ),
            Err(Ok(ClmmError::InvalidTickSpacing))
        );
        assert_eq!(
            client.try_get_position(&position_id),
            Err(Ok(ClmmError::InvalidTickSpacing))
        );

        // Repair configuration: the same calls now succeed.
        env.as_contract(&client.address, || {
            env.storage().instance().set(&DataKey::TickSpacing, &60i32);
        });
        assert_eq!(client.get_position(&position_id).liquidity, 100_000);
        client.mint(
            &owner,
            &-120,
            &120,
            &10_000,
            &u128::MAX,
            &u128::MAX,
            &operation_id(&env, 30),
        );
    }

    #[test]
    fn stale_configuration_preserves_position_and_allows_retry() {
        let (env, client, token0, token1) = setup_pool();
        let owner = Address::generate(&env);
        mint_tokens(&env, &token0, &owner, 1_000_000_000_000_000_000);
        mint_tokens(&env, &token1, &owner, 1_000_000_000_000_000_000);
        let (position_id, _, _) = client.mint(
            &owner,
            &-60,
            &60,
            &100_000,
            &1_000_000_000_000_000_000,
            &1_000_000_000_000_000_000,
        );
        let contract_id = client.address.clone();

        env.as_contract(&contract_id, || {
            let original = env
                .storage()
                .instance()
                .get::<_, u32>(&DataKey::Fee)
                .unwrap();
            let position_before: Position = env
                .storage()
                .persistent()
                .get(&DataKey::Position(position_id))
                .unwrap();
            env.storage().instance().set(&DataKey::Fee, &(original + 1));
            assert_eq!(
                ClmmCore::validate_configuration(&env, Some(position_id)),
                Err(ClmmError::StaleConfiguration)
            );
            let position_after: Position = env
                .storage()
                .persistent()
                .get(&DataKey::Position(position_id))
                .unwrap();
            assert_eq!(position_after.liquidity, position_before.liquidity);
            assert_eq!(position_after.tokens_owed_0, position_before.tokens_owed_0);
            assert_eq!(position_after.tokens_owed_1, position_before.tokens_owed_1);
            env.storage().instance().set(&DataKey::Fee, &original);
            assert_eq!(
                ClmmCore::validate_configuration(&env, Some(position_id)),
                Ok(())
            );
        });

        let (amount0, amount1) = client.burn(&position_id, &100_000);
        assert_eq!(client.get_position(&position_id).liquidity, 0);
        assert!(amount0 > 0 || amount1 > 0);
    }
}
