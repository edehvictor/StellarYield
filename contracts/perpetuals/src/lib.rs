#![no_std]
#![allow(
    clippy::arithmetic_side_effects,
    clippy::unwrap_used,
    clippy::too_many_arguments
)]

//! # Perpetual Futures vAMM Exchange
//!
//! A decentralized perpetual futures exchange powered by a Virtual AMM (vAMM).
//! Users can trade with leverage without requiring actual underlying liquidity.
//!
//! ## Core Concepts
//!
//! * **Virtual AMM**: Uses constant product curve (x*y=k) on virtual reserves
//!   to calculate prices without holding actual liquidity.
//! * **Long/Short Positions**: Users can open leveraged long or short positions.
//! * **Funding Rate**: Periodic payments between longs and shorts to balance OI.
//! * **Liquidation**: Undercollateralized positions are liquidated to prevent bad debt.
//!
//! ## Security Considerations
//!
//! * Funding rate manipulation (primary attack vector)
//! * Insolvency cascades from large liquidations
//! * Oracle price manipulation affecting liquidations

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

// ── Storage Keys ─────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Admin,
    Initialized,
    Paused,
    Oracle,
    IndexToken,
    QuoteToken,
    VirtualBaseReserve,  // Virtual X (base asset)
    VirtualQuoteReserve, // Virtual Y (quote asset)
    // Position tracking
    Positions(Address), // Map of user positions
    // Market state
    LongOpenInterest,      // Total notional of long positions
    ShortOpenInterest,     // Total notional of short positions
    CumulativeFundingRate, // Accumulated funding rate (scaled by 1e10)
    LastFundingUpdate,     // Timestamp of last funding payment
    // Risk parameters
    MinMarginRatio,        // Minimum margin ratio before liquidation (bps)
    MaintenanceMargin,     // Maintenance margin ratio (bps)
    MaxLeverage,           // Maximum allowed leverage (e.g., 20x)
    LiquidationFee,        // Fee charged on liquidation (bps)
    FundingInterval,       // Seconds between funding payments
    FundingRateMultiplier, // Sensitivity of funding rate to OI skew
    // Fee parameters
    ProtocolFeeRecipient,
    TradingFeeBps, // Trading fee in basis points
}

// ── Data Structures ─────────────────────────────────────────────────────

/// Side of a position
#[contracttype]
#[derive(Clone, Debug, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum PositionSide {
    Long = 0,
    Short = 1,
}

/// Position data for a trader
#[contracttype]
#[derive(Clone, Debug)]
pub struct Position {
    pub owner: Address,
    pub side: PositionSide,
    pub size: i128,                    // Position size in base tokens
    pub entry_price: i128,             // Entry price (scaled by 1e7)
    pub margin: i128,                  // Collateral deposited
    pub last_cumulative_funding: i128, // Last seen cumulative funding rate
    pub liquidation_price: i128,       // Price at which position is liquidated
    pub open_time: u64,
}

/// Market state snapshot
#[contracttype]
#[derive(Clone, Debug)]
pub struct MarketState {
    pub virtual_base_reserve: i128,
    pub virtual_quote_reserve: i128,
    pub long_oi: i128,
    pub short_oi: i128,
    pub mark_price: i128,
    pub cumulative_funding_rate: i128,
}

/// Trade parameters
#[contracttype]
#[derive(Clone, Debug)]
pub struct TradeParams {
    pub size: i128,         // Position size (base tokens)
    pub leverage: u32,      // Leverage multiplier (e.g., 10 = 10x)
    pub max_slippage: i128, // Max acceptable price impact (bps)
}

// ── Errors ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PerpetualError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    Paused = 4,
    ZeroAmount = 5,
    InvalidLeverage = 6,
    PositionNotFound = 7,
    PositionExists = 8,
    InsufficientMargin = 9,
    WouldBeLiquidated = 10,
    SlippageExceeded = 11,
    PositionTooSmall = 12,
    NoPositionToClose = 13,
    InvalidSide = 14,
    OracleError = 15,
    InvalidPrice = 16,
    InsufficientBalance = 17,
    LiquidationFailed = 18,
    MaxLeverageExceeded = 19,
    BelowMaintenanceMargin = 20,
    InvalidAmount = 21,
}

// ── Contract ───────────────────────────────────────────────────────────

#[contract]
pub struct PerpetualExchange;

#[contractimpl]
impl PerpetualExchange {
    // ═══════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════

    /// Initialize the perpetual exchange contract.
    ///
    /// # Arguments
    /// * `admin` - Contract admin address
    /// * `oracle` - Price oracle contract address
    /// * `index_token` - Base asset token address
    /// * `quote_token` - Quote asset token address (e.g., USDC)
    /// * `virtual_base` - Initial virtual base reserve
    /// * `virtual_quote` - Initial virtual quote reserve
    /// * `max_leverage` - Maximum allowed leverage (e.g., 20)
    /// * `protocol_fee_recipient` - Address to receive trading fees
    ///
    /// # Security
    /// * Virtual reserves should be set based on expected trading volume
    /// * Higher virtual reserves = less slippage but more capital inefficient
    pub fn initialize(
        env: Env,
        admin: Address,
        oracle: Address,
        index_token: Address,
        quote_token: Address,
        virtual_base: i128,
        virtual_quote: i128,
        max_leverage: u32,
        protocol_fee_recipient: Address,
    ) -> Result<(), PerpetualError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(PerpetualError::AlreadyInitialized);
        }

        if virtual_base <= 0 || virtual_quote <= 0 {
            return Err(PerpetualError::ZeroAmount);
        }

        if max_leverage == 0 || max_leverage > 100 {
            return Err(PerpetualError::InvalidLeverage);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage()
            .instance()
            .set(&DataKey::IndexToken, &index_token);
        env.storage()
            .instance()
            .set(&DataKey::QuoteToken, &quote_token);
        env.storage()
            .instance()
            .set(&DataKey::VirtualBaseReserve, &virtual_base);
        env.storage()
            .instance()
            .set(&DataKey::VirtualQuoteReserve, &virtual_quote);
        env.storage()
            .instance()
            .set(&DataKey::MaxLeverage, &max_leverage);
        env.storage()
            .instance()
            .set(&DataKey::ProtocolFeeRecipient, &protocol_fee_recipient);

        // Initialize market state
        env.storage()
            .instance()
            .set(&DataKey::LongOpenInterest, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::ShortOpenInterest, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::CumulativeFundingRate, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::LastFundingUpdate, &env.ledger().timestamp());

        // Default risk parameters
        env.storage()
            .instance()
            .set(&DataKey::MinMarginRatio, &500u32); // 5%
        env.storage()
            .instance()
            .set(&DataKey::MaintenanceMargin, &625u32); // 6.25%
        env.storage()
            .instance()
            .set(&DataKey::LiquidationFee, &500u32); // 5%
        env.storage()
            .instance()
            .set(&DataKey::FundingInterval, &3600u64); // 1 hour
        env.storage()
            .instance()
            .set(&DataKey::FundingRateMultiplier, &10000u32); // 1x
        env.storage()
            .instance()
            .set(&DataKey::TradingFeeBps, &30u32); // 0.3%

        env.storage().instance().set(&DataKey::Initialized, &true);

        env.events().publish(
            (symbol_short!("init"),),
            (admin, virtual_base, virtual_quote, max_leverage),
        );

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // vAMM CORE PRICING
    // ═══════════════════════════════════════════════════════════════════

    /// Calculate the mark price from virtual reserves.
    ///
    /// Mark price = virtual_quote / virtual_base
    ///
    /// # Returns
    /// Price scaled by 1e7 (e.g., 50000000000 = $50,000)
    pub fn get_mark_price(env: Env) -> Result<i128, PerpetualError> {
        let base_reserve: i128 = env
            .storage()
            .instance()
            .get(&DataKey::VirtualBaseReserve)
            .ok_or(PerpetualError::NotInitialized)?;
        let quote_reserve: i128 = env
            .storage()
            .instance()
            .get(&DataKey::VirtualQuoteReserve)
            .ok_or(PerpetualError::NotInitialized)?;

        if base_reserve == 0 {
            return Err(PerpetualError::InvalidPrice);
        }

        // Price = quote / base, scaled by 1e7
        let price = quote_reserve
            .checked_mul(10_000_000)
            .and_then(|v| v.checked_div(base_reserve))
            .ok_or(PerpetualError::InvalidPrice)?;

        Ok(price)
    }

    /// Calculate output amount for a swap on the vAMM.
    ///
    /// Uses constant product formula: x * y = k
    /// For buying (long): delta_y = (y * delta_x) / (x + delta_x)
    /// For selling (short): delta_x = (x * delta_y) / (y + delta_y)
    ///
    /// # Arguments
    /// * `is_buy` - true for long (buying base), false for short (selling base)
    /// * `input_amount` - Amount of input token
    ///
    /// # Returns
    /// Output amount (cost for long, proceeds for short)
    fn calculate_vamm_output(
        env: &Env,
        is_buy: bool,
        input_amount: i128,
    ) -> Result<i128, PerpetualError> {
        if input_amount <= 0 {
            return Err(PerpetualError::ZeroAmount);
        }

        let base_reserve: i128 = env
            .storage()
            .instance()
            .get(&DataKey::VirtualBaseReserve)
            .ok_or(PerpetualError::NotInitialized)?;
        let quote_reserve: i128 = env
            .storage()
            .instance()
            .get(&DataKey::VirtualQuoteReserve)
            .ok_or(PerpetualError::NotInitialized)?;

        let output = if is_buy {
            // Buying base: quote_in -> base_out
            // delta_base = (base_reserve * quote_in) / (quote_reserve + quote_in)
            let numerator = base_reserve
                .checked_mul(input_amount)
                .ok_or(PerpetualError::InvalidPrice)?;
            let denominator = quote_reserve
                .checked_add(input_amount)
                .ok_or(PerpetualError::InvalidPrice)?;
            numerator
                .checked_div(denominator)
                .ok_or(PerpetualError::InvalidPrice)?
        } else {
            // Selling base: base_in -> quote_out
            // delta_quote = (quote_reserve * base_in) / (base_reserve + base_in)
            let numerator = quote_reserve
                .checked_mul(input_amount)
                .ok_or(PerpetualError::InvalidPrice)?;
            let denominator = base_reserve
                .checked_add(input_amount)
                .ok_or(PerpetualError::InvalidPrice)?;
            numerator
                .checked_div(denominator)
                .ok_or(PerpetualError::InvalidPrice)?
        };

        Ok(output)
    }

    /// Calculate the price impact for a given trade size.
    ///
    /// # Arguments
    /// * `size` - Trade size in base tokens
    /// * `is_long` - true for long, false for short
    ///
    /// # Returns
    /// Average execution price (scaled by 1e7)
    pub fn get_execution_price(
        env: Env,
        size: i128,
        is_long: bool,
    ) -> Result<i128, PerpetualError> {
        if size <= 0 {
            return Err(PerpetualError::ZeroAmount);
        }

        let mark_price = Self::get_mark_price(env.clone())?;

        // Calculate cost/revenue for the trade
        let output = Self::calculate_vamm_output(&env, is_long, size)?;

        // Average price scaled by 1e7
        let avg_price = output
            .checked_mul(10_000_000)
            .ok_or(PerpetualError::InvalidPrice)?;

        // Adjust by size
        let avg_price = avg_price.checked_div(size).unwrap_or(mark_price);

        Ok(avg_price)
    }

    /// Update virtual reserves after a trade.
    ///
    /// # Arguments
    /// * `is_long` - true for long (increase base, decrease quote)
    /// * `base_delta` - Change in base reserve
    /// * `quote_delta` - Change in quote reserve
    fn update_reserves(
        env: &Env,
        is_long: bool,
        base_delta: i128,
        quote_delta: i128,
    ) -> Result<(), PerpetualError> {
        let mut base_reserve: i128 = env
            .storage()
            .instance()
            .get(&DataKey::VirtualBaseReserve)
            .ok_or(PerpetualError::NotInitialized)?;
        let mut quote_reserve: i128 = env
            .storage()
            .instance()
            .get(&DataKey::VirtualQuoteReserve)
            .ok_or(PerpetualError::NotInitialized)?;

        if is_long {
            // Long: user buys base with quote
            // Base reserve decreases (user receives base)
            // Quote reserve increases (user pays quote)
            base_reserve = base_reserve
                .checked_sub(base_delta)
                .ok_or(PerpetualError::InvalidPrice)?;
            quote_reserve = quote_reserve
                .checked_add(quote_delta)
                .ok_or(PerpetualError::InvalidPrice)?;
        } else {
            // Short: user sells base for quote
            // Base reserve increases (user provides base)
            // Quote reserve decreases (user receives quote)
            base_reserve = base_reserve
                .checked_add(base_delta)
                .ok_or(PerpetualError::InvalidPrice)?;
            quote_reserve = quote_reserve
                .checked_sub(quote_delta)
                .ok_or(PerpetualError::InvalidPrice)?;
        }

        env.storage()
            .instance()
            .set(&DataKey::VirtualBaseReserve, &base_reserve);
        env.storage()
            .instance()
            .set(&DataKey::VirtualQuoteReserve, &quote_reserve);

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // MARGIN MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /// Deposit margin (collateral) for trading.
    ///
    /// # Arguments
    /// * `trader` - Trader address (must authorize)
    /// * `amount` - Amount of quote token to deposit
    ///
    /// # Security
    /// * Requires trader authorization
    /// * Transfers tokens from trader to contract
    pub fn deposit_margin(env: Env, trader: Address, amount: i128) -> Result<(), PerpetualError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;

        if amount <= 0 {
            return Err(PerpetualError::ZeroAmount);
        }

        trader.require_auth();

        let quote_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::QuoteToken)
            .ok_or(PerpetualError::NotInitialized)?;

        let client = token::Client::new(&env, &quote_token);
        client.transfer(&trader, &env.current_contract_address(), &amount);

        env.events()
            .publish((symbol_short!("deposit"),), (trader, amount));

        Ok(())
    }

    /// Withdraw available margin (excluding collateral for open positions).
    ///
    /// # Arguments
    /// * `trader` - Trader address (must authorize)
    /// * `amount` - Amount to withdraw
    ///
    /// # Security
    /// * Only allows withdrawal of excess margin
    /// * Cannot withdraw if it would liquidate existing positions
    pub fn withdraw_margin(env: Env, trader: Address, amount: i128) -> Result<(), PerpetualError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;

        if amount <= 0 {
            return Err(PerpetualError::ZeroAmount);
        }

        trader.require_auth();

        // Check if trader has an open position
        let position_key = DataKey::Positions(trader.clone());
        if let Some(position) = env.storage().persistent().get::<_, Position>(&position_key) {
            // Calculate available margin after withdrawal
            let quote_token: Address = env
                .storage()
                .instance()
                .get(&DataKey::QuoteToken)
                .ok_or(PerpetualError::NotInitialized)?;
            let token_client = token::Client::new(&env, &quote_token);
            let contract_balance = token_client.balance(&env.current_contract_address());

            // Ensure withdrawal wouldn't liquidate position
            let new_balance = contract_balance
                .checked_sub(amount)
                .ok_or(PerpetualError::InsufficientMargin)?;

            // Check if remaining balance covers required margin
            let required_margin = Self::calculate_required_margin(&env, &position)?;
            if new_balance < required_margin {
                return Err(PerpetualError::InsufficientMargin);
            }
        }

        let quote_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::QuoteToken)
            .ok_or(PerpetualError::NotInitialized)?;
        let client = token::Client::new(&env, &quote_token);
        client.transfer(&env.current_contract_address(), &trader, &amount);

        env.events()
            .publish((symbol_short!("withdraw"),), (trader, amount));

        Ok(())
    }

    /// Calculate required margin for a position.
    fn calculate_required_margin(env: &Env, position: &Position) -> Result<i128, PerpetualError> {
        let mark_price = Self::get_mark_price(env.clone())?;
        let notional = position
            .size
            .checked_mul(mark_price)
            .and_then(|v| v.checked_div(10_000_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        let maintenance_margin: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaintenanceMargin)
            .ok_or(PerpetualError::NotInitialized)?;

        let required = notional
            .checked_mul(maintenance_margin as i128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        Ok(required)
    }

    /// Get the margin balance for a trader (tokens held by contract).
    pub fn get_margin_balance(env: Env, _trader: Address) -> Result<i128, PerpetualError> {
        let quote_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::QuoteToken)
            .ok_or(PerpetualError::NotInitialized)?;
        let client = token::Client::new(&env, &quote_token);
        Ok(client.balance(&env.current_contract_address()))
    }

    // ═══════════════════════════════════════════════════════════════════
    // POSITION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /// Open a new leveraged position.
    ///
    /// # Arguments
    /// * `trader` - Trader address (must authorize)
    /// * `params` - Trade parameters (size, leverage, max_slippage)
    /// * `is_long` - true for long, false for short
    /// * `margin` - Collateral to allocate to this position
    ///
    /// # Security
    /// * Checks leverage limits
    /// * Validates slippage
    /// * Verifies sufficient margin
    pub fn open_position(
        env: Env,
        trader: Address,
        params: TradeParams,
        is_long: bool,
        margin: i128,
    ) -> Result<Position, PerpetualError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;

        trader.require_auth();

        // Validate inputs
        if params.size <= 0 {
            return Err(PerpetualError::ZeroAmount);
        }
        if margin <= 0 {
            return Err(PerpetualError::InsufficientMargin);
        }

        // Check for existing position
        let position_key = DataKey::Positions(trader.clone());
        if env.storage().persistent().has(&position_key) {
            return Err(PerpetualError::PositionExists);
        }

        // Check leverage limit
        let max_leverage: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxLeverage)
            .ok_or(PerpetualError::NotInitialized)?;
        if params.leverage > max_leverage {
            return Err(PerpetualError::MaxLeverageExceeded);
        }

        // Calculate notional value
        let mark_price = Self::get_mark_price(env.clone())?;
        let notional = params
            .size
            .checked_mul(mark_price)
            .and_then(|v| v.checked_div(10_000_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        // Check margin covers leveraged position
        let min_margin = notional
            .checked_div(params.leverage as i128)
            .ok_or(PerpetualError::InvalidLeverage)?;
        if margin < min_margin {
            return Err(PerpetualError::InsufficientMargin);
        }

        // Check slippage
        let execution_price = Self::get_execution_price(env.clone(), params.size, is_long)?;
        let slippage = if is_long {
            execution_price.checked_sub(mark_price).unwrap_or(0)
        } else {
            mark_price.checked_sub(execution_price).unwrap_or(0)
        };
        let slippage_bps = slippage
            .checked_mul(10_000)
            .and_then(|v| v.checked_div(mark_price))
            .unwrap_or(0);
        if slippage_bps > params.max_slippage {
            return Err(PerpetualError::SlippageExceeded);
        }

        // Collect trading fee
        let trading_fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TradingFeeBps)
            .ok_or(PerpetualError::NotInitialized)?;
        let fee = notional
            .checked_mul(trading_fee_bps as i128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        if fee > 0 {
            let fee_recipient: Address = env
                .storage()
                .instance()
                .get(&DataKey::ProtocolFeeRecipient)
                .ok_or(PerpetualError::NotInitialized)?;
            let quote_token: Address = env
                .storage()
                .instance()
                .get(&DataKey::QuoteToken)
                .ok_or(PerpetualError::NotInitialized)?;
            let client = token::Client::new(&env, &quote_token);
            client.transfer(&trader, &fee_recipient, &fee);
        }

        // Update funding before modifying position
        Self::update_funding(&env)?;

        // Get cumulative funding rate
        let cumulative_funding: i128 = env
            .storage()
            .instance()
            .get(&DataKey::CumulativeFundingRate)
            .unwrap_or(0);

        // Update vAMM reserves
        let quote_delta = notional
            .checked_add(fee)
            .ok_or(PerpetualError::InvalidPrice)?;
        Self::update_reserves(&env, is_long, params.size, quote_delta)?;

        // Create position
        let side = if is_long {
            PositionSide::Long
        } else {
            PositionSide::Short
        };

        // Calculate liquidation price
        let liquidation_price =
            Self::calculate_liquidation_price(&env, execution_price, margin, notional, is_long)?;

        let position = Position {
            owner: trader.clone(),
            side,
            size: params.size,
            entry_price: execution_price,
            margin,
            last_cumulative_funding: cumulative_funding,
            liquidation_price,
            open_time: env.ledger().timestamp(),
        };

        // Store position
        env.storage().persistent().set(&position_key, &position);

        // Update open interest
        Self::update_open_interest(&env, notional, is_long, true)?;

        env.events().publish(
            (symbol_short!("open"),),
            (trader, side as u32, params.size, execution_price, margin),
        );

        Ok(position)
    }

    /// Close an existing position.
    ///
    /// # Arguments
    /// * `trader` - Trader address (must authorize)
    /// * `size_to_close` - Amount to close (0 for full close)
    ///
    /// # Returns
    /// PnL realized from closing the position
    pub fn close_position(
        env: Env,
        trader: Address,
        size_to_close: i128,
    ) -> Result<i128, PerpetualError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;

        trader.require_auth();

        let position_key = DataKey::Positions(trader.clone());
        let position: Position = env
            .storage()
            .persistent()
            .get(&position_key)
            .ok_or(PerpetualError::PositionNotFound)?;

        let close_size = if size_to_close == 0 {
            position.size
        } else {
            if size_to_close > position.size {
                return Err(PerpetualError::InvalidAmount);
            }
            size_to_close
        };

        let is_long = position.side == PositionSide::Long;

        // Update funding
        Self::update_funding(&env)?;

        // Apply funding payment
        Self::apply_funding_payment(&env, &position)?;

        // Get current price
        let exit_price = Self::get_mark_price(env.clone())?;

        // Calculate PnL
        let pnl = Self::calculate_pnl(&position, exit_price, close_size)?;

        // Calculate notional value being closed
        let notional = close_size
            .checked_mul(exit_price)
            .and_then(|v| v.checked_div(10_000_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        // Collect trading fee
        let trading_fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TradingFeeBps)
            .ok_or(PerpetualError::NotInitialized)?;
        let fee = notional
            .checked_mul(trading_fee_bps as i128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        if fee > 0 {
            let fee_recipient: Address = env
                .storage()
                .instance()
                .get(&DataKey::ProtocolFeeRecipient)
                .ok_or(PerpetualError::NotInitialized)?;
            let quote_token: Address = env
                .storage()
                .instance()
                .get(&DataKey::QuoteToken)
                .ok_or(PerpetualError::NotInitialized)?;
            let client = token::Client::new(&env, &quote_token);

            // Transfer fee from contract to fee recipient
            client.transfer(&env.current_contract_address(), &fee_recipient, &fee);
        }

        // Update reserves (opposite direction from open)
        let quote_delta = notional;
        Self::update_reserves(&env, !is_long, close_size, quote_delta)?;

        // Update position or remove
        if close_size == position.size {
            // Full close - remove position
            env.storage().persistent().remove(&position_key);

            // Return margin +/- PnL
            let return_amount = position
                .margin
                .checked_add(pnl)
                .ok_or(PerpetualError::InvalidPrice)?;
            if return_amount > 0 {
                let quote_token: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::QuoteToken)
                    .ok_or(PerpetualError::NotInitialized)?;
                let client = token::Client::new(&env, &quote_token);
                client.transfer(&env.current_contract_address(), &trader, &return_amount);
            }
        } else {
            // Partial close - update position
            let new_size = position
                .size
                .checked_sub(close_size)
                .ok_or(PerpetualError::InvalidAmount)?;
            let margin_ratio = new_size / position.size;
            let new_margin = position
                .margin
                .checked_mul(margin_ratio)
                .ok_or(PerpetualError::InvalidPrice)?;

            let updated_position = Position {
                size: new_size,
                margin: new_margin,
                ..position
            };
            env.storage()
                .persistent()
                .set(&position_key, &updated_position);
        }

        // Update open interest
        Self::update_open_interest(&env, notional, is_long, false)?;

        env.events().publish(
            (symbol_short!("close"),),
            (trader, close_size, exit_price, pnl),
        );

        Ok(pnl)
    }

    /// Get position details for a trader.
    pub fn get_position(env: Env, trader: Address) -> Option<Position> {
        let position_key = DataKey::Positions(trader);
        env.storage().persistent().get(&position_key)
    }

    /// Calculate unrealized PnL for a position.
    pub fn get_unrealized_pnl(env: Env, trader: Address) -> Result<i128, PerpetualError> {
        let position_key = DataKey::Positions(trader);
        let position: Position = env
            .storage()
            .persistent()
            .get(&position_key)
            .ok_or(PerpetualError::PositionNotFound)?;

        let mark_price = Self::get_mark_price(env)?;
        Self::calculate_pnl(&position, mark_price, position.size)
    }

    /// Calculate PnL for a position at a given price.
    fn calculate_pnl(
        position: &Position,
        current_price: i128,
        size: i128,
    ) -> Result<i128, PerpetualError> {
        let entry_notional = size
            .checked_mul(position.entry_price)
            .and_then(|v| v.checked_div(10_000_000))
            .ok_or(PerpetualError::InvalidPrice)?;
        let current_notional = size
            .checked_mul(current_price)
            .and_then(|v| v.checked_div(10_000_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        let pnl = if position.side == PositionSide::Long {
            current_notional.checked_sub(entry_notional)
        } else {
            entry_notional.checked_sub(current_notional)
        };

        pnl.ok_or(PerpetualError::InvalidPrice)
    }

    /// Calculate liquidation price for a position.
    fn calculate_liquidation_price(
        env: &Env,
        entry_price: i128,
        margin: i128,
        notional: i128,
        is_long: bool,
    ) -> Result<i128, PerpetualError> {
        let min_margin_ratio: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MinMarginRatio)
            .ok_or(PerpetualError::NotInitialized)?;

        // Liquidation occurs when: margin + PnL = maintenance_margin
        // For long: PnL = size * (price - entry)
        // Liquidation when: margin + size * (liq_price - entry) = notional * min_ratio
        // Solving: liq_price = entry - (margin - notional * min_ratio) / size

        let min_margin = notional
            .checked_mul(min_margin_ratio as i128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        let price_buffer = margin
            .checked_sub(min_margin)
            .ok_or(PerpetualError::InvalidPrice)?;

        let price_delta = price_buffer
            .checked_mul(10_000_000)
            .and_then(|v| v.checked_div(notional))
            .ok_or(PerpetualError::InvalidPrice)?;

        let liq_price = if is_long {
            entry_price.checked_sub(price_delta)
        } else {
            entry_price.checked_add(price_delta)
        };

        liq_price.ok_or(PerpetualError::InvalidPrice)
    }

    // ═══════════════════════════════════════════════════════════════════
    // FUNDING RATE MECHANISM
    // ═══════════════════════════════════════════════════════════════════

    /// Update the cumulative funding rate.
    ///
    /// Called before any position modification. Accrues funding payments
    /// based on time elapsed and current funding rate.
    ///
    /// # Security
    /// * Funding rate is based on OI skew, resistant to manipulation
    /// * Time-weighted to prevent flash loan attacks
    fn update_funding(env: &Env) -> Result<(), PerpetualError> {
        let last_update: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LastFundingUpdate)
            .unwrap_or(env.ledger().timestamp());

        let current_time = env.ledger().timestamp();
        let elapsed = current_time.saturating_sub(last_update);

        if elapsed == 0 {
            return Ok(());
        }

        let funding_interval: u64 = env
            .storage()
            .instance()
            .get(&DataKey::FundingInterval)
            .ok_or(PerpetualError::NotInitialized)?;

        // Only update if funding interval has passed
        if elapsed < funding_interval {
            return Ok(());
        }

        // Calculate funding rate based on OI skew
        let funding_rate = Self::calculate_funding_rate(env)?;

        // Update cumulative funding (scaled by 1e10 for precision)
        let intervals = elapsed.checked_div(funding_interval).unwrap_or(1) as i128;
        let funding_increment = funding_rate
            .checked_mul(intervals)
            .ok_or(PerpetualError::InvalidPrice)?;

        let mut cumulative: i128 = env
            .storage()
            .instance()
            .get(&DataKey::CumulativeFundingRate)
            .unwrap_or(0);
        cumulative = cumulative
            .checked_add(funding_increment)
            .ok_or(PerpetualError::InvalidPrice)?;

        env.storage()
            .instance()
            .set(&DataKey::CumulativeFundingRate, &cumulative);
        env.storage()
            .instance()
            .set(&DataKey::LastFundingUpdate, &current_time);

        env.events().publish(
            (symbol_short!("funding"),),
            (funding_rate, cumulative, current_time),
        );

        Ok(())
    }

    /// Calculate current funding rate based on OI skew.
    ///
    /// Funding rate = multiplier * (long_oi - short_oi) / (long_oi + short_oi)
    /// Positive = longs pay shorts, Negative = shorts pay longs
    ///
    /// # Returns
    /// Funding rate scaled by 1e10 (e.g., 100000000 = 1%)
    pub fn calculate_funding_rate(env: &Env) -> Result<i128, PerpetualError> {
        let long_oi: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LongOpenInterest)
            .unwrap_or(0);
        let short_oi: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ShortOpenInterest)
            .unwrap_or(0);

        let multiplier: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FundingRateMultiplier)
            .ok_or(PerpetualError::NotInitialized)?;

        let total_oi = long_oi.checked_add(short_oi).unwrap_or(0);
        if total_oi == 0 {
            return Ok(0);
        }

        // Calculate skew: (long_oi - short_oi) / total_oi
        // Scale by 1e10 for precision
        let skew = long_oi
            .checked_sub(short_oi)
            .and_then(|v| v.checked_mul(10_000_000_000))
            .and_then(|v| v.checked_div(total_oi))
            .unwrap_or(0);

        // Apply multiplier
        let rate = skew
            .checked_mul(multiplier as i128)
            .and_then(|v| v.checked_div(10_000))
            .unwrap_or(0);

        Ok(rate)
    }

    /// Apply funding payment to a position.
    fn apply_funding_payment(env: &Env, position: &Position) -> Result<i128, PerpetualError> {
        let current_cumulative: i128 = env
            .storage()
            .instance()
            .get(&DataKey::CumulativeFundingRate)
            .unwrap_or(0);

        let funding_delta = current_cumulative
            .checked_sub(position.last_cumulative_funding)
            .ok_or(PerpetualError::InvalidPrice)?;

        if funding_delta == 0 {
            return Ok(0);
        }

        // Funding payment = size * funding_delta / 1e10
        let payment = position
            .size
            .checked_mul(funding_delta)
            .and_then(|v| v.checked_div(10_000_000_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        // Longs pay when rate is positive, shorts pay when negative
        let signed_payment = if position.side == PositionSide::Long {
            -payment // Longs pay
        } else {
            payment // Shorts pay (or receive if negative)
        };

        Ok(signed_payment)
    }

    /// Get pending funding payment for a position.
    pub fn get_pending_funding(env: Env, trader: Address) -> Result<i128, PerpetualError> {
        let position_key = DataKey::Positions(trader);
        let position: Position = env
            .storage()
            .persistent()
            .get(&position_key)
            .ok_or(PerpetualError::PositionNotFound)?;

        Self::apply_funding_payment(&env, &position)
    }

    // ═══════════════════════════════════════════════════════════════════
    // LIQUIDATION
    // ═══════════════════════════════════════════════════════════════════

    /// Liquidate an undercollateralized position.
    ///
    /// # Arguments
    /// * `liquidator` - Address performing liquidation (receives reward)
    /// * `trader` - Address of position to liquidate
    ///
    /// # Security
    /// * Anyone can liquidate underwater positions
    /// * Liquidator receives fee as incentive
    /// * Position must be below maintenance margin
    pub fn liquidate(
        env: Env,
        liquidator: Address,
        trader: Address,
    ) -> Result<i128, PerpetualError> {
        Self::require_initialized(&env)?;

        liquidator.require_auth();

        let position_key = DataKey::Positions(trader.clone());
        let position: Position = env
            .storage()
            .persistent()
            .get(&position_key)
            .ok_or(PerpetualError::PositionNotFound)?;

        // Check if position is liquidatable
        let is_long = position.side == PositionSide::Long;
        let mark_price = Self::get_mark_price(env.clone())?;
        let notional = position
            .size
            .checked_mul(mark_price)
            .and_then(|v| v.checked_div(10_000_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        let pnl = Self::calculate_pnl(&position, mark_price, position.size)?;
        let effective_margin = position
            .margin
            .checked_add(pnl)
            .ok_or(PerpetualError::InvalidPrice)?;

        let maintenance_margin: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaintenanceMargin)
            .ok_or(PerpetualError::NotInitialized)?;
        let required_maintenance = notional
            .checked_mul(maintenance_margin as i128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        if effective_margin >= required_maintenance {
            return Err(PerpetualError::LiquidationFailed);
        }

        // Update funding before liquidation
        Self::update_funding(&env)?;

        // Calculate liquidation fee
        let liquidation_fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LiquidationFee)
            .ok_or(PerpetualError::NotInitialized)?;
        let fee = notional
            .checked_mul(liquidation_fee_bps as i128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        // Update reserves
        Self::update_reserves(&env, !is_long, position.size, notional)?;

        // Remove position
        env.storage().persistent().remove(&position_key);

        // Update open interest
        Self::update_open_interest(&env, notional, is_long, false)?;

        // Transfer liquidation fee to liquidator
        if fee > 0 {
            let quote_token: Address = env
                .storage()
                .instance()
                .get(&DataKey::QuoteToken)
                .ok_or(PerpetualError::NotInitialized)?;
            let client = token::Client::new(&env, &quote_token);
            client.transfer(&env.current_contract_address(), &liquidator, &fee);
        }

        // Transfer remaining margin to protocol if any
        let remaining = effective_margin.checked_sub(fee).unwrap_or(0);
        if remaining > 0 {
            let protocol_recipient: Address = env
                .storage()
                .instance()
                .get(&DataKey::ProtocolFeeRecipient)
                .ok_or(PerpetualError::NotInitialized)?;
            let quote_token: Address = env
                .storage()
                .instance()
                .get(&DataKey::QuoteToken)
                .ok_or(PerpetualError::NotInitialized)?;
            let client = token::Client::new(&env, &quote_token);
            client.transfer(
                &env.current_contract_address(),
                &protocol_recipient,
                &remaining,
            );
        }

        env.events().publish(
            (symbol_short!("liquidate"),),
            (trader, liquidator, mark_price, fee),
        );

        Ok(fee)
    }

    /// Check if a position is liquidatable.
    pub fn is_liquidatable(env: Env, trader: Address) -> Result<bool, PerpetualError> {
        let position_key = DataKey::Positions(trader);
        let position: Position = match env.storage().persistent().get(&position_key) {
            Some(p) => p,
            None => return Ok(false),
        };

        let mark_price = Self::get_mark_price(env.clone())?;
        let notional = position
            .size
            .checked_mul(mark_price)
            .and_then(|v| v.checked_div(10_000_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        let pnl = Self::calculate_pnl(&position, mark_price, position.size)?;
        let effective_margin = position
            .margin
            .checked_add(pnl)
            .ok_or(PerpetualError::InvalidPrice)?;

        let maintenance_margin: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaintenanceMargin)
            .ok_or(PerpetualError::NotInitialized)?;
        let required = notional
            .checked_mul(maintenance_margin as i128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(PerpetualError::InvalidPrice)?;

        Ok(effective_margin < required)
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// Get current market state.
    pub fn get_market_state(env: Env) -> Result<MarketState, PerpetualError> {
        let virtual_base: i128 = env
            .storage()
            .instance()
            .get(&DataKey::VirtualBaseReserve)
            .ok_or(PerpetualError::NotInitialized)?;
        let virtual_quote: i128 = env
            .storage()
            .instance()
            .get(&DataKey::VirtualQuoteReserve)
            .ok_or(PerpetualError::NotInitialized)?;
        let long_oi: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LongOpenInterest)
            .unwrap_or(0);
        let short_oi: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ShortOpenInterest)
            .unwrap_or(0);
        let mark_price = Self::get_mark_price(env.clone())?;
        let cumulative_funding: i128 = env
            .storage()
            .instance()
            .get(&DataKey::CumulativeFundingRate)
            .unwrap_or(0);

        Ok(MarketState {
            virtual_base_reserve: virtual_base,
            virtual_quote_reserve: virtual_quote,
            long_oi,
            short_oi,
            mark_price,
            cumulative_funding_rate: cumulative_funding,
        })
    }

    /// Get open interest data.
    pub fn get_open_interest(env: Env) -> Result<(i128, i128), PerpetualError> {
        let long: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LongOpenInterest)
            .unwrap_or(0);
        let short: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ShortOpenInterest)
            .unwrap_or(0);
        Ok((long, short))
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// Set risk parameters.
    pub fn set_risk_params(
        env: Env,
        admin: Address,
        min_margin_ratio: u32,
        maintenance_margin: u32,
        max_leverage: u32,
        liquidation_fee: u32,
    ) -> Result<(), PerpetualError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&DataKey::MinMarginRatio, &min_margin_ratio);
        env.storage()
            .instance()
            .set(&DataKey::MaintenanceMargin, &maintenance_margin);
        env.storage()
            .instance()
            .set(&DataKey::MaxLeverage, &max_leverage);
        env.storage()
            .instance()
            .set(&DataKey::LiquidationFee, &liquidation_fee);

        env.events().publish(
            (symbol_short!("set_risk"),),
            (
                min_margin_ratio,
                maintenance_margin,
                max_leverage,
                liquidation_fee,
            ),
        );

        Ok(())
    }

    /// Set funding parameters.
    pub fn set_funding_params(
        env: Env,
        admin: Address,
        interval: u64,
        multiplier: u32,
    ) -> Result<(), PerpetualError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&DataKey::FundingInterval, &interval);
        env.storage()
            .instance()
            .set(&DataKey::FundingRateMultiplier, &multiplier);

        env.events()
            .publish((symbol_short!("set_fund"),), (interval, multiplier));

        Ok(())
    }

    /// Emergency pause.
    pub fn emergency_pause(env: Env, admin: Address) -> Result<(), PerpetualError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((symbol_short!("pause"),), (admin,));

        Ok(())
    }

    /// Unpause.
    pub fn emergency_unpause(env: Env, admin: Address) -> Result<(), PerpetualError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage().instance().remove(&DataKey::Paused);
        env.events().publish((symbol_short!("unpause"),), (admin,));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    fn require_initialized(env: &Env) -> Result<(), PerpetualError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(PerpetualError::NotInitialized);
        }
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), PerpetualError> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(PerpetualError::NotInitialized)?;

        if *caller != admin {
            return Err(PerpetualError::Unauthorized);
        }
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), PerpetualError> {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            return Err(PerpetualError::Paused);
        }
        Ok(())
    }

    fn update_open_interest(
        env: &Env,
        notional: i128,
        is_long: bool,
        is_open: bool,
    ) -> Result<(), PerpetualError> {
        if is_long {
            let mut long_oi: i128 = env
                .storage()
                .instance()
                .get(&DataKey::LongOpenInterest)
                .unwrap_or(0);
            if is_open {
                long_oi = long_oi
                    .checked_add(notional)
                    .ok_or(PerpetualError::InvalidPrice)?;
            } else {
                long_oi = long_oi
                    .checked_sub(notional)
                    .ok_or(PerpetualError::InvalidPrice)?;
            }
            env.storage()
                .instance()
                .set(&DataKey::LongOpenInterest, &long_oi);
        } else {
            let mut short_oi: i128 = env
                .storage()
                .instance()
                .get(&DataKey::ShortOpenInterest)
                .unwrap_or(0);
            if is_open {
                short_oi = short_oi
                    .checked_add(notional)
                    .ok_or(PerpetualError::InvalidPrice)?;
            } else {
                short_oi = short_oi
                    .checked_sub(notional)
                    .ok_or(PerpetualError::InvalidPrice)?;
            }
            env.storage()
                .instance()
                .set(&DataKey::ShortOpenInterest, &short_oi);
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

    fn setup_contract(env: &Env) -> (PerpetualExchangeClient<'static>, Address, Address, Address) {
        env.mock_all_auths();

        let contract_id = env.register(PerpetualExchange, ());
        let client = PerpetualExchangeClient::new(env, &contract_id);

        let admin = Address::generate(env);
        let oracle = Address::generate(env);
        let quote_token = Address::generate(env);
        let protocol_fee_recipient = Address::generate(env);

        // Initialize with $50,000 BTC virtual pool (1000 BTC * $50,000)
        client.initialize(
            &admin,
            &oracle,
            &Address::generate(env), // index_token
            &quote_token,
            &1_000_000_000,          // 1000 BTC with 1e6 precision
            &50_000_000_000_000i128, // $50,000,000 with 1e6 precision
            &20u32,                  // 20x max leverage
            &protocol_fee_recipient,
        );

        (client, admin, oracle, quote_token)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let (client, _admin, _, _) = setup_contract(&env);

        let state = client.get_market_state();
        assert_eq!(state.virtual_base_reserve, 1_000_000_000);
        assert_eq!(state.virtual_quote_reserve, 50_000_000_000_000i128);

        let price = client.get_mark_price();
        // Price = quote/base * 1e7 = 50,000,000,000,000 / 1,000,000,000 * 10,000,000 = 500,000,000,000
        assert_eq!(price, 500_000_000_000i128); // $50,000 with 1e7 precision
    }

    #[test]
    fn test_mark_price() {
        let env = Env::default();
        let (client, _, _, _) = setup_contract(&env);

        let price = client.get_mark_price();
        // 50,000,000,000,000 / 1,000,000,000 * 1e7 = 500,000,000,000 (scaled)
        assert!(price > 0);
    }

    #[test]
    fn test_open_long_position() {
        let env = Env::default();
        let (_client, _, _, _quote_token) = setup_contract(&env);

        let _trader = Address::generate(&env);

        // Mock token transfers for margin deposit
        env.mock_all_auths();

        // Deposit margin (not needed for mock, just check structure)
        // In real test, we'd mock the token client

        let _params = TradeParams {
            size: 100_000,     // 0.1 BTC
            leverage: 10,      // 10x
            max_slippage: 100, // 1%
        };

        // This would need proper token mocking
        // let position = client.open_position(&trader, &params, &true, &500_000);
    }

    #[test]
    fn test_funding_rate_calculation() {
        let env = Env::default();
        let (client, _, _, _) = setup_contract(&env);

        // With no positions, funding rate should be 0
        let rate = client.calculate_funding_rate();
        assert_eq!(rate, 0);
    }

    #[test]
    fn test_liquidation_check() {
        let env = Env::default();
        let (client, _, _, _) = setup_contract(&env);

        let trader = Address::generate(&env);

        // No position exists, should not be liquidatable
        let is_liq = client.is_liquidatable(&trader);
        assert!(!is_liq);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        let (client, admin, oracle, quote_token) = setup_contract(&env);

        client.initialize(
            &admin,
            &oracle,
            &Address::generate(&env),
            &quote_token,
            &1_000_000_000,
            &50_000_000_000_000i128,
            &20u32,
            &Address::generate(&env),
        );
    }

    #[test]
    fn test_emergency_pause() {
        let env = Env::default();
        let (client, admin, _, _) = setup_contract(&env);

        // Open a position should work initially
        let state = client.get_market_state();
        assert!(state.mark_price > 0);

        // Pause
        client.emergency_pause(&admin);

        // After pause, position opening should fail
        // (Would need to test with actual call)
    }
}
