#![no_std]

//! # DeltaNeutralStrategy — Basis Trading Yield Contract
//!
//! Generates yield regardless of market direction by executing a delta-neutral
//! basis trade:
//!   - **Spot Long**: Uses half the USDC deposit to buy the spot asset on the AMM.
//!   - **Perp Short**: Uses the other half as collateral for a 1x short on the
//!     perpetuals exchange.
//!
//! The two legs cancel out directional price exposure (delta ≈ 0), leaving the
//! strategy to collect the perpetual funding rate as pure yield.
//!
//! ## Security Considerations
//! - Slippage protection via `min_spot_out` parameter on `open_position`.
//! - Rebalance threshold prevents excessive gas spend on tiny deviations.
//! - Admin-gated pause mechanism for emergency stops.
//! - Oracle price used to calculate delta deviation; must be a trusted feed.

use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, token, Address, Env};

mod interfaces;
mod storage;
#[cfg(test)]
mod tests;

use interfaces::{AmmRouterClient, OracleClient, PerpExchangeClient};
use storage::{
    is_initialized, is_paused, read_admin, read_amm_router, read_oracle, read_perp_exchange,
    read_position, read_rebalance_threshold_bps, read_spot_token, read_total_deposited,
    read_usdc_token, set_initialized, set_paused, write_admin, write_amm_router, write_oracle,
    write_perp_exchange, write_position, write_rebalance_threshold_bps, write_spot_token,
    write_total_deposited, write_usdc_token, Position,
};

/// Precision scalar — all prices and rates are scaled by 1e7.
const SCALE: i128 = 10_000_000;

// ── Errors ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StrategyError {
    /// Contract has not been initialised yet.
    NotInitialized = 1,
    /// Contract has already been initialised.
    AlreadyInitialized = 2,
    /// Caller is not the admin.
    Unauthorized = 3,
    /// Deposit amount must be greater than zero.
    ZeroAmount = 4,
    /// No open position found for this user.
    NoPosition = 5,
    /// Position is already open; close it first.
    PositionAlreadyOpen = 6,
    /// Contract is paused.
    Paused = 7,
    /// Rebalance not needed; delta deviation is within threshold.
    RebalanceNotNeeded = 8,
    /// Oracle returned an invalid (zero or negative) price.
    InvalidPrice = 9,
    /// Slippage exceeded — spot output below minimum.
    SlippageExceeded = 10,
    /// Rebalance threshold value out of allowed range (1–10000 bps).
    InvalidThreshold = 11,
}

// ── Contract ─────────────────────────────────────────────────────────────

#[contract]
pub struct DeltaNeutralStrategy;

#[contractimpl]
impl DeltaNeutralStrategy {
    // ── Initialisation ────────────────────────────────────────────────

    /// Initialise the strategy contract.
    ///
    /// Must be called once before any other function. Sets up all external
    /// contract addresses and the admin key.
    ///
    /// # Arguments
    /// * `admin`        — Address that can pause/unpause and set parameters.
    /// * `usdc_token`   — SAC address of the USDC deposit token.
    /// * `spot_token`   — SAC address of the spot asset (e.g. XLM).
    /// * `amm_router`   — Address of the AMM router for spot swaps.
    /// * `perp_exchange`— Address of the perpetuals exchange contract.
    /// * `oracle`       — Address of the price oracle contract.
    pub fn initialize(
        env: Env,
        admin: Address,
        usdc_token: Address,
        spot_token: Address,
        amm_router: Address,
        perp_exchange: Address,
        oracle: Address,
    ) -> Result<(), StrategyError> {
        if is_initialized(&env) {
            return Err(StrategyError::AlreadyInitialized);
        }

        write_admin(&env, &admin);
        write_usdc_token(&env, &usdc_token);
        write_spot_token(&env, &spot_token);
        write_amm_router(&env, &amm_router);
        write_perp_exchange(&env, &perp_exchange);
        write_oracle(&env, &oracle);
        set_initialized(&env);

        env.events()
            .publish((symbol_short!("init"),), (admin.clone(),));

        Ok(())
    }

    // ── Position Management ───────────────────────────────────────────

    /// Open a delta-neutral position by depositing USDC.
    ///
    /// Splits the deposit 50/50:
    ///   - Half is swapped for the spot asset on the AMM (long leg).
    ///   - Half is used as collateral to open a 1x short on the perp exchange.
    ///
    /// # Arguments
    /// * `depositor`    — The user opening the position (must authorise).
    /// * `usdc_amount`  — Total USDC to deposit (must be > 0 and even).
    /// * `min_spot_out` — Minimum spot tokens to receive from the AMM swap
    ///                    (slippage protection; set to 0 to disable).
    ///
    /// # Returns
    /// The spot asset amount received from the AMM swap.
    pub fn open_position(
        env: Env,
        depositor: Address,
        usdc_amount: i128,
        min_spot_out: i128,
    ) -> Result<i128, StrategyError> {
        Self::require_init(&env)?;
        Self::require_not_paused(&env)?;
        depositor.require_auth();

        if usdc_amount <= 0 {
            return Err(StrategyError::ZeroAmount);
        }

        // Reject if user already has an open position
        if let Some(pos) = read_position(&env, &depositor) {
            if pos.is_open {
                return Err(StrategyError::PositionAlreadyOpen);
            }
        }

        let usdc_addr = read_usdc_token(&env);
        let spot_addr = read_spot_token(&env);
        let amm_addr = read_amm_router(&env);
        let perp_addr = read_perp_exchange(&env);
        let oracle_addr = read_oracle(&env);

        // Pull USDC from depositor into this contract
        let usdc_client = token::Client::new(&env, &usdc_addr);
        usdc_client.transfer(&depositor, &env.current_contract_address(), &usdc_amount);

        let half = usdc_amount / 2;

        // ── Leg 1: Spot Long via AMM ──────────────────────────────────
        // Approve AMM to spend half the USDC, then swap
        usdc_client.approve(
            &env.current_contract_address(),
            &amm_addr,
            &half,
            &(env.ledger().sequence() + 100),
        );

        let amm_client = AmmRouterClient::new(&env, &amm_addr);
        let spot_received = amm_client.swap_exact_tokens_for_tokens(
            &env.current_contract_address(),
            &half,
            &min_spot_out,
            &usdc_addr,
            &spot_addr,
        );

        if spot_received < min_spot_out {
            return Err(StrategyError::SlippageExceeded);
        }

        // ── Leg 2: 1x Short on Perp Exchange ─────────────────────────
        usdc_client.approve(
            &env.current_contract_address(),
            &perp_addr,
            &half,
            &(env.ledger().sequence() + 100),
        );

        let perp_client = PerpExchangeClient::new(&env, &perp_addr);
        let perp_notional = perp_client.open_short(
            &env.current_contract_address(),
            &half,
            &spot_addr,
        );

        // ── Record entry price from oracle ────────────────────────────
        let oracle_client = OracleClient::new(&env, &oracle_addr);
        let entry_price = oracle_client.get_price(&spot_addr);
        if entry_price <= 0 {
            return Err(StrategyError::InvalidPrice);
        }

        // ── Persist position ──────────────────────────────────────────
        let position = Position {
            owner: depositor.clone(),
            usdc_deposited: usdc_amount,
            spot_amount: spot_received,
            perp_notional,
            entry_price,
            funding_collected: 0,
            is_open: true,
        };
        write_position(&env, &depositor, &position);

        let new_total = read_total_deposited(&env) + usdc_amount;
        write_total_deposited(&env, new_total);

        env.events().publish(
            (symbol_short!("open"), depositor.clone()),
            (usdc_amount, spot_received, perp_notional, entry_price),
        );

        Ok(spot_received)
    }

    /// Close an existing delta-neutral position and return funds to the user.
    ///
    /// Unwinds both legs:
    ///   - Sells the spot asset back to USDC on the AMM.
    ///   - Closes the short position on the perp exchange.
    ///   - Collects any remaining funding before closing.
    ///
    /// # Arguments
    /// * `depositor` — The user closing their position (must authorise).
    ///
    /// # Returns
    /// Total USDC returned to the user (spot proceeds + perp proceeds + funding).
    pub fn close_position(env: Env, depositor: Address) -> Result<i128, StrategyError> {
        Self::require_init(&env)?;
        depositor.require_auth();

        let mut position = read_position(&env, &depositor)
            .filter(|p| p.is_open)
            .ok_or(StrategyError::NoPosition)?;

        let usdc_addr = read_usdc_token(&env);
        let spot_addr = read_spot_token(&env);
        let amm_addr = read_amm_router(&env);
        let perp_addr = read_perp_exchange(&env);

        let usdc_client = token::Client::new(&env, &usdc_addr);
        let spot_client = token::Client::new(&env, &spot_addr);
        let amm_client = AmmRouterClient::new(&env, &amm_addr);
        let perp_client = PerpExchangeClient::new(&env, &perp_addr);

        // ── Collect pending funding ───────────────────────────────────
        let funding = perp_client.collect_funding(&env.current_contract_address(), &spot_addr);
        position.funding_collected += funding;

        // ── Close short leg ───────────────────────────────────────────
        let perp_proceeds = perp_client.close_short(&env.current_contract_address(), &spot_addr);

        // ── Sell spot leg back to USDC ────────────────────────────────
        spot_client.approve(
            &env.current_contract_address(),
            &amm_addr,
            &position.spot_amount,
            &(env.ledger().sequence() + 100),
        );
        let spot_proceeds = amm_client.swap_exact_tokens_for_tokens(
            &env.current_contract_address(),
            &position.spot_amount,
            &0, // no min on close; user accepts market price
            &spot_addr,
            &usdc_addr,
        );

        let total_usdc = spot_proceeds + perp_proceeds + funding;

        // ── Return USDC to user ───────────────────────────────────────
        usdc_client.transfer(&env.current_contract_address(), &depositor, &total_usdc);

        // ── Update state ──────────────────────────────────────────────
        let prev_total = read_total_deposited(&env);
        write_total_deposited(&env, (prev_total - position.usdc_deposited).max(0));

        position.is_open = false;
        write_position(&env, &depositor, &position);

        env.events().publish(
            (symbol_short!("close"), depositor.clone()),
            (total_usdc, spot_proceeds, perp_proceeds, funding),
        );

        Ok(total_usdc)
    }

    // ── Rebalancing ───────────────────────────────────────────────────────

    /// Rebalance a user's position to restore delta-neutrality.
    ///
    /// When the spot price moves significantly from the entry price, the spot
    /// leg and perp leg become unequal in notional value, creating net delta
    /// exposure. This function:
    ///   1. Fetches the current oracle price.
    ///   2. Calculates the delta deviation as a percentage.
    ///   3. If deviation exceeds `rebalance_threshold_bps`, adjusts the spot
    ///      leg by buying or selling the difference on the AMM.
    ///
    /// Can be called by the position owner or the admin (keeper bot).
    ///
    /// # Arguments
    /// * `caller`    — Must be the position owner or admin.
    /// * `depositor` — The user whose position to rebalance.
    ///
    /// # Returns
    /// The absolute delta deviation in basis points at the time of rebalance.
    pub fn auto_rebalance(
        env: Env,
        caller: Address,
        depositor: Address,
    ) -> Result<i128, StrategyError> {
        Self::require_init(&env)?;
        Self::require_not_paused(&env)?;
        caller.require_auth();

        // Only the position owner or admin may trigger a rebalance
        let admin = read_admin(&env);
        if caller != depositor && caller != admin {
            return Err(StrategyError::Unauthorized);
        }

        let mut position = read_position(&env, &depositor)
            .filter(|p| p.is_open)
            .ok_or(StrategyError::NoPosition)?;

        let spot_addr = read_spot_token(&env);
        let usdc_addr = read_usdc_token(&env);
        let oracle_addr = read_oracle(&env);
        let amm_addr = read_amm_router(&env);

        let oracle_client = OracleClient::new(&env, &oracle_addr);
        let current_price = oracle_client.get_price(&spot_addr);
        if current_price <= 0 {
            return Err(StrategyError::InvalidPrice);
        }

        // Delta deviation = |current_price - entry_price| / entry_price (in bps)
        let price_diff = (current_price - position.entry_price).abs();
        let deviation_bps = (price_diff * 10_000) / position.entry_price;

        let threshold = read_rebalance_threshold_bps(&env);
        if deviation_bps < threshold {
            return Err(StrategyError::RebalanceNotNeeded);
        }

        // Target spot notional = perp_notional (keep 1:1 ratio)
        // Current spot notional = spot_amount * current_price / SCALE
        let current_spot_notional = (position.spot_amount * current_price) / SCALE;
        let target_spot_notional = position.perp_notional;

        let amm_client = AmmRouterClient::new(&env, &amm_addr);
        let usdc_client = token::Client::new(&env, &usdc_addr);
        let spot_client = token::Client::new(&env, &spot_addr);

        if current_spot_notional > target_spot_notional {
            // Spot leg is too large → sell excess spot for USDC
            let excess_notional = current_spot_notional - target_spot_notional;
            let excess_spot = (excess_notional * SCALE) / current_price;

            spot_client.approve(
                &env.current_contract_address(),
                &amm_addr,
                &excess_spot,
                &(env.ledger().sequence() + 100),
            );
            amm_client.swap_exact_tokens_for_tokens(
                &env.current_contract_address(),
                &excess_spot,
                &0,
                &spot_addr,
                &usdc_addr,
            );

            position.spot_amount -= excess_spot;
        } else {
            // Spot leg is too small → buy more spot with USDC
            let deficit_notional = target_spot_notional - current_spot_notional;

            usdc_client.approve(
                &env.current_contract_address(),
                &amm_addr,
                &deficit_notional,
                &(env.ledger().sequence() + 100),
            );
            let extra_spot = amm_client.swap_exact_tokens_for_tokens(
                &env.current_contract_address(),
                &deficit_notional,
                &0,
                &usdc_addr,
                &spot_addr,
            );

            position.spot_amount += extra_spot;
        }

        // Update entry price to current after rebalance
        position.entry_price = current_price;
        write_position(&env, &depositor, &position);

        env.events().publish(
            (symbol_short!("rebal"), depositor.clone()),
            (deviation_bps, current_price, position.spot_amount),
        );

        Ok(deviation_bps)
    }

    /// Collect accrued funding rate for a user's position.
    ///
    /// Funding is paid by traders who are long on the perp exchange to those
    /// who are short (when the perp price trades above spot). This is the
    /// primary yield source of the strategy.
    ///
    /// # Arguments
    /// * `depositor` — The user collecting funding (must authorise).
    ///
    /// # Returns
    /// The USDC amount of funding collected.
    pub fn collect_funding(env: Env, depositor: Address) -> Result<i128, StrategyError> {
        Self::require_init(&env)?;
        Self::require_not_paused(&env)?;
        depositor.require_auth();

        let mut position = read_position(&env, &depositor)
            .filter(|p| p.is_open)
            .ok_or(StrategyError::NoPosition)?;

        let spot_addr = read_spot_token(&env);
        let usdc_addr = read_usdc_token(&env);
        let perp_addr = read_perp_exchange(&env);

        let perp_client = PerpExchangeClient::new(&env, &perp_addr);
        let funding = perp_client.collect_funding(&env.current_contract_address(), &spot_addr);

        if funding > 0 {
            let usdc_client = token::Client::new(&env, &usdc_addr);
            usdc_client.transfer(&env.current_contract_address(), &depositor, &funding);
            position.funding_collected += funding;
            write_position(&env, &depositor, &position);
        }

        env.events().publish(
            (symbol_short!("fund"), depositor.clone()),
            (funding,),
        );

        Ok(funding)
    }

    // ── View Functions ────────────────────────────────────────────────────

    /// Returns the current position data for a user.
    ///
    /// # Arguments
    /// * `depositor` — The user to query.
    pub fn get_position(env: Env, depositor: Address) -> Option<Position> {
        read_position(&env, &depositor)
    }

    /// Returns the total USDC deposited across all open positions.
    pub fn get_total_deposited(env: Env) -> i128 {
        read_total_deposited(&env)
    }

    /// Returns the current rebalance threshold in basis points.
    pub fn get_rebalance_threshold(env: Env) -> i128 {
        read_rebalance_threshold_bps(&env)
    }

    // ── Admin Functions ───────────────────────────────────────────────────

    /// Pause the contract. Only callable by admin.
    ///
    /// # Arguments
    /// * `admin` — Must be the current admin address.
    pub fn pause(env: Env, admin: Address) -> Result<(), StrategyError> {
        Self::require_init(&env)?;
        admin.require_auth();
        if admin != read_admin(&env) {
            return Err(StrategyError::Unauthorized);
        }
        set_paused(&env, true);
        env.events().publish((symbol_short!("pause"),), ());
        Ok(())
    }

    /// Unpause the contract. Only callable by admin.
    ///
    /// # Arguments
    /// * `admin` — Must be the current admin address.
    pub fn unpause(env: Env, admin: Address) -> Result<(), StrategyError> {
        Self::require_init(&env)?;
        admin.require_auth();
        if admin != read_admin(&env) {
            return Err(StrategyError::Unauthorized);
        }
        set_paused(&env, false);
        env.events().publish((symbol_short!("unpause"),), ());
        Ok(())
    }

    /// Update the rebalance threshold. Only callable by admin.
    ///
    /// # Arguments
    /// * `admin`         — Must be the current admin address.
    /// * `threshold_bps` — New threshold in basis points (1–10000).
    pub fn set_rebalance_threshold(
        env: Env,
        admin: Address,
        threshold_bps: i128,
    ) -> Result<(), StrategyError> {
        Self::require_init(&env)?;
        admin.require_auth();
        if admin != read_admin(&env) {
            return Err(StrategyError::Unauthorized);
        }
        if threshold_bps < 1 || threshold_bps > 10_000 {
            return Err(StrategyError::InvalidThreshold);
        }
        write_rebalance_threshold_bps(&env, threshold_bps);
        Ok(())
    }

    // ── Internal Helpers ──────────────────────────────────────────────────

    fn require_init(env: &Env) -> Result<(), StrategyError> {
        if !is_initialized(env) {
            return Err(StrategyError::NotInitialized);
        }
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), StrategyError> {
        if is_paused(env) {
            return Err(StrategyError::Paused);
        }
        Ok(())
    }
}
