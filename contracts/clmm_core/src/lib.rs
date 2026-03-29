#![allow(clippy::too_many_arguments)]
#![no_std]

//! # CLMM Core — Concentrated Liquidity Market Maker Engine
//!
//! Implements Uniswap V3-style concentrated liquidity with tick-based math,
//! custom price ranges, and NFT-style position tracking for capital efficiency.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

mod math;
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
}

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct ClmmCore;

#[contractimpl]
#[allow(clippy::too_many_arguments)]
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

        env.events().publish(
            (symbol_short!("mint"),),
            (position_id, owner, tick_lower, tick_upper, amount),
        );

        Ok((position_id, amount0, amount1))
    }

    /// Burn liquidity from an existing position and collect tokens.
    ///
    /// # Arguments
    /// * `position_id` — ID of the position to burn
    /// * `amount` — Amount of liquidity to remove
    ///
    /// # Returns
    /// (amount0, amount1) — Amounts of token0 and token1 returned
    pub fn burn(env: Env, position_id: u64, amount: u128) -> Result<(u128, u128), ClmmError> {
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

        env.events().publish(
            (symbol_short!("burn"),),
            (position_id, amount, amount0, amount1),
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
    ///
    /// # Returns
    /// (amount0, amount1) — Fee amounts collected
    pub fn collect(env: Env, position_id: u64) -> Result<(u128, u128), ClmmError> {
        Self::require_init(&env)?;

        let mut position: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(position_id))
            .ok_or(ClmmError::InvalidPosition)?;

        position.owner.require_auth();

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

        env.events().publish(
            (symbol_short!("collect"),),
            (position_id, collect_0, collect_1),
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
    }
}
