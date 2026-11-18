#![no_std]
// Contract entry points are generated as flat argument lists (`mint` carries
// the deposit, its two caps and the operation identity), matching the other
// contracts in this workspace.
#![allow(clippy::too_many_arguments)]

//! # CLMM Core — Concentrated Liquidity Market Maker Engine
//!
//! Implements Uniswap V3-style concentrated liquidity with tick-based math,
//! custom price ranges, and NFT-style position tracking for capital efficiency.

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
#[derive(Clone, Debug)]
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
        owner.require_auth();

        if amount == 0 {
            return Err(ClmmError::InvalidAmount);
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
            math::get_amounts_for_liquidity(sqrt_price, tick_lower, tick_upper, amount);

        if amount0 > amount0_max || amount1 > amount1_max {
            return Err(ClmmError::InvalidAmount);
        }

        // Update ticks
        tick::update_tick(&env, tick_lower, amount as i128, false)?;
        tick::update_tick(&env, tick_upper, -(amount as i128), false)?;

        // Update global liquidity if position is active
        if tick_lower <= current_tick && current_tick < tick_upper {
            let liquidity: u128 = env.storage().instance().get(&DataKey::Liquidity).unwrap();
            env.storage()
                .instance()
                .set(&DataKey::Liquidity, &(liquidity + amount));
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
        let position_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextPositionId)
            .unwrap();

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
        };

        env.storage()
            .persistent()
            .set(&DataKey::Position(position_id), &position);
        env.storage()
            .instance()
            .set(&DataKey::NextPositionId, &(position_id + 1));

        Self::record_operation(&env, &operation_key);

        env.events().publish(
            (symbol_short!("mint"),),
            (position_id, owner.clone(), tick_lower, tick_upper, amount),
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
    /// * `operation_id` — Caller-generated identity for this submission,
    ///   scoped to the position owner, the operation kind and the position.
    ///
    /// # Returns
    /// (amount0, amount1) — Amounts of token0 and token1 returned
    pub fn burn(
        env: Env,
        position_id: u64,
        amount: u128,
        operation_id: BytesN<32>,
    ) -> Result<(u128, u128), ClmmError> {
        Self::require_init(&env)?;

        let mut position: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(position_id))
            .ok_or(ClmmError::InvalidPosition)?;

        position.owner.require_auth();

        if amount == 0 || amount > position.liquidity {
            return Err(ClmmError::InsufficientLiquidity);
        }

        let operation_key = Self::operation_key(
            &env,
            &position.owner,
            symbol_short!("burn"),
            position_id,
            &operation_id,
        );
        Self::require_new_operation(&env, &operation_key)?;

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

        // Update ticks
        tick::update_tick(&env, position.tick_lower, -(amount as i128), true)?;
        tick::update_tick(&env, position.tick_upper, amount as i128, true)?;

        // Update global liquidity if position is active
        if position.tick_lower <= current_tick && current_tick < position.tick_upper {
            let liquidity: u128 = env.storage().instance().get(&DataKey::Liquidity).unwrap();
            env.storage()
                .instance()
                .set(&DataKey::Liquidity, &(liquidity - amount));
        }

        // Update position
        position.liquidity -= amount;
        position.tokens_owed_0 += amount0;
        position.tokens_owed_1 += amount1;

        env.storage()
            .persistent()
            .set(&DataKey::Position(position_id), &position);

        Self::record_operation(&env, &operation_key);

        env.events().publish(
            (symbol_short!("burn"),),
            (position_id, amount, amount0, amount1),
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
    /// The swap math is intentionally left as-is in this change; the guarded
    /// fee-growth division is covered by the `liquidity > 0` branch.
    #[allow(clippy::manual_checked_ops)]
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
            if liquidity > 0 {
                let fee_growth_delta = (fee_amount * math::Q128) / liquidity;
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
    /// # Arguments
    /// * `position_id` — Position ID to collect from
    /// * `operation_id` — Caller-generated identity for this submission,
    ///   scoped to the position owner, the operation kind and the position.
    ///
    /// # Returns
    /// (amount0, amount1) — Fee amounts collected
    pub fn collect(
        env: Env,
        position_id: u64,
        operation_id: BytesN<32>,
    ) -> Result<(u128, u128), ClmmError> {
        Self::require_init(&env)?;

        let mut position: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(position_id))
            .ok_or(ClmmError::InvalidPosition)?;

        position.owner.require_auth();

        let operation_key = Self::operation_key(
            &env,
            &position.owner,
            symbol_short!("collect"),
            position_id,
            &operation_id,
        );
        Self::require_new_operation(&env, &operation_key)?;

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

        let fees_0 = ((fee_growth_inside_0 - position.fee_growth_inside_0_last_x128)
            * position.liquidity)
            / math::Q128;
        let fees_1 = ((fee_growth_inside_1 - position.fee_growth_inside_1_last_x128)
            * position.liquidity)
            / math::Q128;

        let collect_0 = position.tokens_owed_0 + fees_0;
        let collect_1 = position.tokens_owed_1 + fees_1;

        // Transfer fees to owner
        let token0_addr: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1_addr: Address = env.storage().instance().get(&DataKey::Token1).unwrap();

        if collect_0 > 0 {
            let client0 = token::Client::new(&env, &token0_addr);
            client0.transfer(
                &env.current_contract_address(),
                &position.owner,
                &(collect_0 as i128),
            );
        }
        if collect_1 > 0 {
            let client1 = token::Client::new(&env, &token1_addr);
            client1.transfer(
                &env.current_contract_address(),
                &position.owner,
                &(collect_1 as i128),
            );
        }

        // Update position
        position.fee_growth_inside_0_last_x128 = fee_growth_inside_0;
        position.fee_growth_inside_1_last_x128 = fee_growth_inside_1;
        position.tokens_owed_0 = 0;
        position.tokens_owed_1 = 0;

        env.storage()
            .persistent()
            .set(&DataKey::Position(position_id), &position);

        Self::record_operation(&env, &operation_key);

        env.events().publish(
            (symbol_short!("collect"),),
            (position_id, collect_0, collect_1),
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
        env.storage()
            .persistent()
            .get(&DataKey::Position(position_id))
            .ok_or(ClmmError::InvalidPosition)
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
        mint_tokens(&env, &token0, &user, 100_000);
        mint_tokens(&env, &token1, &user, 100_000);

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

        client.burn(&position_id, &40_000, &id);
        let after = client.get_position(&position_id);
        let liquidity = client.get_liquidity();
        let owner0 = balance(&env, &token0, &owner);
        let owner1 = balance(&env, &token1, &owner);

        let retry = client.try_burn(&position_id, &40_000, &id);
        assert_eq!(retry, Err(Ok(ClmmError::DuplicateOperation)));

        let now = client.get_position(&position_id);
        assert_eq!(now.liquidity, after.liquidity);
        assert_eq!(now.tokens_owed_0, after.tokens_owed_0);
        assert_eq!(now.tokens_owed_1, after.tokens_owed_1);
        assert_eq!(client.get_liquidity(), liquidity);
        assert_eq!(balance(&env, &token0, &owner), owner0);
        assert_eq!(balance(&env, &token1, &owner), owner1);
    }

    #[test]
    fn test_failed_burn_does_not_consume_the_operation_id() {
        let (env, client, token0, token1) = setup_pool();
        let (_owner, position_id) = open_position(&env, &client, &token0, &token1);
        let id = operation_id(&env, 3);

        let failed = client.try_burn(&position_id, &100_001, &id);
        assert_eq!(failed, Err(Ok(ClmmError::InsufficientLiquidity)));
        assert_eq!(client.get_position(&position_id).liquidity, 100_000);

        client.burn(&position_id, &40_000, &id);
        assert_eq!(client.get_position(&position_id).liquidity, 60_000);
    }

    #[test]
    fn test_duplicate_collect_is_rejected_and_pays_once() {
        let (env, client, token0, token1) = setup_pool();
        let (owner, position_id) = open_position(&env, &client, &token0, &token1);
        let id = operation_id(&env, 4);

        assert_eq!(client.collect(&position_id, &id), (0, 0));
        let owner0 = balance(&env, &token0, &owner);
        let owner1 = balance(&env, &token1, &owner);

        let retry = client.try_collect(&position_id, &id);
        assert_eq!(retry, Err(Ok(ClmmError::DuplicateOperation)));
        assert_eq!(balance(&env, &token0, &owner), owner0);
        assert_eq!(balance(&env, &token1, &owner), owner1);

        // A fresh identity collects later without re-applying the first effect.
        assert_eq!(client.collect(&position_id, &operation_id(&env, 5)), (0, 0));
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
        client.burn(&position_id, &1_000, &id);
        assert!(client.try_collect(&position_id, &id).is_ok());

        let owner_now = client.get_position(&position_id);
        assert_eq!(owner_now.owner, owner);
        assert_eq!(owner_now.liquidity, 99_000);
    }
}
