#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

const BPS_DENOMINATOR: i128 = 10_000;
/// Fixed-point scale of the borrow index (1.0 = `INDEX_SCALE`).
const INDEX_SCALE: i128 = 1_000_000_000;
/// Interest rates are parts per billion of the index, per ledger.
const RATE_SCALE: i128 = 1_000_000_000;

#[contracttype]
#[derive(Clone)]
pub enum FactoryDataKey {
    Admin,
    PairCount,
    PairById(u32),
    PairByTokens(Address, Address),
}

#[contracttype]
#[derive(Clone)]
pub struct PairConfig {
    pub pair_id: u32,
    pub collateral_token: Address,
    pub debt_token: Address,
    pub collateral_factor_bps: u32,
}

/// Borrow eligibility policy for oracle quotes.
#[contracttype]
#[derive(Clone)]
pub struct OraclePolicyConfig {
    pub min_confidence_bps: u32,
    pub max_age_ledgers: u32,
}

/// Latest quote pushed by the configured oracle.
#[contracttype]
#[derive(Clone)]
pub struct OracleQuoteData {
    pub price_bps: u32,
    pub confidence_bps: u32,
    pub ledger: u32,
}

/// Health-factor components of a position, valued exactly as `liquidate`
/// values them: it is liquidatable once
/// `debt_value > collateral_value * threshold_bps / 10_000`.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HealthFactor {
    /// Debt including interest accrued up to `ledger`, in debt-token units.
    pub debt_value: i128,
    /// Collateral at the collateral price, in debt-token units.
    pub collateral_value: i128,
    /// Collateral factor in bps; the liquidation threshold.
    pub threshold_bps: u32,
    /// Ledger sequence the components were calculated at.
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum PairDataKey {
    Initialized,
    Admin,
    CollateralToken,
    DebtToken,
    CollateralFactorBps,
    TotalSupplied,
    TotalDebt,
    Supply(Address),
    Collateral(Address),
    Debt(Address),
    /// Debt written off after collateral ran out (debt-token units).
    BadDebt,
    /// Price of one collateral unit in debt-token units, in bps (10_000 = par).
    CollateralPriceBps,
    /// Share of total supply kept out of borrowing, in bps.
    ReserveBps,
    /// Sum of all queued withdrawals.
    PendingWithdrawals,
    PendingWithdrawal(Address),
    /// Marks a (borrower, liquidation id) pair as already settled.
    Liquidation(Address, u64),
    /// Max share of a borrower's debt one liquidation may repay, in bps.
    CloseFactorBps,
    /// Global borrow index; debts are scaled by it (see `DebtIndex`).
    BorrowIndex,
    LastAccrualLedger,
    /// Interest per ledger in parts per billion of the borrow index.
    InterestRatePerLedger,
    /// Borrow index at the time a borrower's debt was last written.
    DebtIndex(Address),
    /// Share of accrued interest owed to the protocol, in bps.
    ProtocolFeeBps,
    /// Accrued protocol fees not yet claimed (debt-token units).
    ProtocolFees,
    Oracle,
    OraclePolicy,
    OracleQuote,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum IsolatedLendingError {
    Unauthorized = 1,
    PairAlreadyExists = 2,
    PairNotFound = 3,
    InvalidConfig = 4,
    NotInitialized = 5,
    InvalidAmount = 6,
    InsufficientLiquidity = 7,
    InsufficientCollateral = 8,
    PositionStillBacked = 9,
    MathOverflow = 10,
    AlreadyLiquidated = 11,
    OracleQuoteMissing = 12,
    OracleQuoteStale = 13,
    OracleConfidenceTooLow = 14,
}

#[contract]
pub struct IsolatedLendingFactory;

#[contractimpl]
impl IsolatedLendingFactory {
    pub fn initialize_factory(env: Env, admin: Address) {
        if env.storage().instance().has(&FactoryDataKey::Admin) {
            return;
        }
        env.storage().instance().set(&FactoryDataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&FactoryDataKey::PairCount, &0_u32);
    }

    pub fn create_pair(
        env: Env,
        admin: Address,
        collateral_token: Address,
        debt_token: Address,
        collateral_factor_bps: u32,
    ) -> Result<PairConfig, IsolatedLendingError> {
        admin.require_auth();
        let factory_admin: Address = env
            .storage()
            .instance()
            .get(&FactoryDataKey::Admin)
            .ok_or(IsolatedLendingError::Unauthorized)?;
        if admin != factory_admin {
            return Err(IsolatedLendingError::Unauthorized);
        }
        if collateral_token == debt_token
            || collateral_factor_bps == 0
            || collateral_factor_bps > 10_000
        {
            return Err(IsolatedLendingError::InvalidConfig);
        }

        let pair_key = FactoryDataKey::PairByTokens(collateral_token.clone(), debt_token.clone());
        if env.storage().instance().has(&pair_key) {
            return Err(IsolatedLendingError::PairAlreadyExists);
        }

        let mut pair_count: u32 = env
            .storage()
            .instance()
            .get(&FactoryDataKey::PairCount)
            .unwrap_or(0);
        pair_count = pair_count
            .checked_add(1)
            .ok_or(IsolatedLendingError::MathOverflow)?;

        let config = PairConfig {
            pair_id: pair_count,
            collateral_token: collateral_token.clone(),
            debt_token: debt_token.clone(),
            collateral_factor_bps,
        };

        env.storage()
            .instance()
            .set(&FactoryDataKey::PairCount, &pair_count);
        env.storage()
            .instance()
            .set(&FactoryDataKey::PairById(pair_count), &config);
        env.storage().instance().set(&pair_key, &pair_count);
        env.events().publish(
            (symbol_short!("pair_new"),),
            (
                pair_count,
                collateral_token,
                debt_token,
                collateral_factor_bps,
            ),
        );
        Ok(config)
    }

    pub fn get_pair_by_id(env: Env, pair_id: u32) -> Result<PairConfig, IsolatedLendingError> {
        env.storage()
            .instance()
            .get(&FactoryDataKey::PairById(pair_id))
            .ok_or(IsolatedLendingError::PairNotFound)
    }

    pub fn get_pair_by_tokens(
        env: Env,
        collateral_token: Address,
        debt_token: Address,
    ) -> Result<PairConfig, IsolatedLendingError> {
        let pair_id: u32 = env
            .storage()
            .instance()
            .get(&FactoryDataKey::PairByTokens(collateral_token, debt_token))
            .ok_or(IsolatedLendingError::PairNotFound)?;
        Self::get_pair_by_id(env, pair_id)
    }
}

#[contract]
pub struct IsolatedLendingPair;

#[contractimpl]
impl IsolatedLendingPair {
    pub fn initialize(
        env: Env,
        admin: Address,
        collateral_token: Address,
        debt_token: Address,
        collateral_factor_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        if env.storage().instance().has(&PairDataKey::Initialized) {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        if collateral_token == debt_token
            || collateral_factor_bps == 0
            || collateral_factor_bps > 10_000
        {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::Initialized, &true);
        env.storage().instance().set(&PairDataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&PairDataKey::CollateralToken, &collateral_token);
        env.storage()
            .instance()
            .set(&PairDataKey::DebtToken, &debt_token);
        env.storage()
            .instance()
            .set(&PairDataKey::CollateralFactorBps, &collateral_factor_bps);
        env.storage()
            .instance()
            .set(&PairDataKey::TotalSupplied, &0_i128);
        env.storage()
            .instance()
            .set(&PairDataKey::TotalDebt, &0_i128);
        Ok(())
    }

    pub fn supply(env: Env, user: Address, amount: i128) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;
        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        token::Client::new(&env, &debt_token).transfer(
            &user,
            &env.current_contract_address(),
            &amount,
        );

        let key = PairDataKey::Supply(user.clone());
        let old_supply: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_supply = old_supply
            .checked_add(amount)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        env.storage().persistent().set(&key, &new_supply);

        let total_supplied: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalSupplied)
            .unwrap_or(0);
        env.storage().instance().set(
            &PairDataKey::TotalSupplied,
            &total_supplied
                .checked_add(amount)
                .ok_or(IsolatedLendingError::MathOverflow)?,
        );
        Ok(())
    }

    pub fn withdraw(env: Env, user: Address, amount: i128) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;

        Self::accrue(&env)?;

        let key = PairDataKey::Supply(user.clone());
        let old_supply: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if old_supply < amount {
            return Err(IsolatedLendingError::InsufficientLiquidity);
        }
        // Accrued protocol fees are owed to the protocol, not to suppliers.
        if Self::redeemable_cash(&env)? < amount {
            return Err(IsolatedLendingError::InsufficientLiquidity);
        }
        env.storage().persistent().set(&key, &(old_supply - amount));
        Self::consume_pending_withdrawal(&env, &user, amount);

        let total_supplied: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalSupplied)
            .unwrap_or(0);
        env.storage().instance().set(
            &PairDataKey::TotalSupplied,
            &total_supplied
                .checked_sub(amount)
                .ok_or(IsolatedLendingError::MathOverflow)?,
        );

        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        token::Client::new(&env, &debt_token).transfer(
            &env.current_contract_address(),
            &user,
            &amount,
        );
        Ok(())
    }

    pub fn post_collateral(
        env: Env,
        user: Address,
        amount: i128,
    ) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;
        let collateral_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralToken)
            .unwrap();
        token::Client::new(&env, &collateral_token).transfer(
            &user,
            &env.current_contract_address(),
            &amount,
        );

        let key = PairDataKey::Collateral(user.clone());
        let old_collateral: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(
            &key,
            &old_collateral
                .checked_add(amount)
                .ok_or(IsolatedLendingError::MathOverflow)?,
        );
        Ok(())
    }

    pub fn borrow(env: Env, user: Address, amount: i128) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;
        Self::check_oracle(&env)?;
        let index = Self::accrue(&env)?;

        let collateral_factor_bps: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralFactorBps)
            .unwrap();
        let collateral: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::Collateral(user.clone()))
            .unwrap_or(0);
        let current_debt = Self::debt_at(&env, &user, index)?;

        let new_debt = current_debt
            .checked_add(amount)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let borrow_limit = collateral
            .checked_mul(collateral_factor_bps as i128)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?;

        if new_debt > borrow_limit {
            return Err(IsolatedLendingError::InsufficientCollateral);
        }

        let total_debt: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalDebt)
            .unwrap_or(0);
        if Self::spendable_liquidity(&env)? < amount {
            return Err(IsolatedLendingError::InsufficientLiquidity);
        }

        Self::store_debt(&env, &user, new_debt, index);
        env.storage().instance().set(
            &PairDataKey::TotalDebt,
            &total_debt
                .checked_add(amount)
                .ok_or(IsolatedLendingError::MathOverflow)?,
        );

        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        token::Client::new(&env, &debt_token).transfer(
            &env.current_contract_address(),
            &user,
            &amount,
        );
        Ok(())
    }

    pub fn repay(env: Env, user: Address, amount: i128) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        Self::repay_debt(&env, &user, &user, amount)
    }

    /// Repay `borrower`'s debt from `payer`'s balance. Any account may repay
    /// on behalf of a borrower; only the borrower's debt and the market total
    /// change, the payer gains no claim on the position.
    pub fn repay_for(
        env: Env,
        payer: Address,
        borrower: Address,
        amount: i128,
    ) -> Result<(), IsolatedLendingError> {
        payer.require_auth();
        Self::repay_debt(&env, &payer, &borrower, amount)
    }

    pub fn withdraw_collateral(
        env: Env,
        user: Address,
        amount: i128,
    ) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;

        let collateral_key = PairDataKey::Collateral(user.clone());
        let old_collateral: i128 = env.storage().persistent().get(&collateral_key).unwrap_or(0);
        if old_collateral < amount {
            return Err(IsolatedLendingError::InsufficientCollateral);
        }

        let index = Self::accrue(&env)?;
        let current_debt = Self::debt_at(&env, &user, index)?;
        let remaining_collateral = old_collateral - amount;
        let collateral_factor_bps: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralFactorBps)
            .unwrap();
        let borrow_limit = remaining_collateral
            .checked_mul(collateral_factor_bps as i128)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?;

        if current_debt > borrow_limit {
            return Err(IsolatedLendingError::PositionStillBacked);
        }

        env.storage()
            .persistent()
            .set(&collateral_key, &remaining_collateral);
        let collateral_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralToken)
            .unwrap();
        token::Client::new(&env, &collateral_token).transfer(
            &env.current_contract_address(),
            &user,
            &amount,
        );
        Ok(())
    }

    /// Queue a withdrawal. Queued amounts are excluded from borrowable liquidity
    /// until the supplier calls `withdraw`.
    pub fn queue_withdrawal(
        env: Env,
        user: Address,
        amount: i128,
    ) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;

        let supply: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::Supply(user.clone()))
            .unwrap_or(0);
        let key = PairDataKey::PendingWithdrawal(user);
        let pending: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_pending = pending
            .checked_add(amount)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        if new_pending > supply {
            return Err(IsolatedLendingError::InsufficientLiquidity);
        }
        env.storage().persistent().set(&key, &new_pending);

        let total_pending: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::PendingWithdrawals)
            .unwrap_or(0);
        env.storage().instance().set(
            &PairDataKey::PendingWithdrawals,
            &total_pending
                .checked_add(amount)
                .ok_or(IsolatedLendingError::MathOverflow)?,
        );
        Ok(())
    }

    /// Set the share of total supply (bps) that cannot be borrowed. Admin only.
    pub fn set_reserve_bps(
        env: Env,
        admin: Address,
        reserve_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if reserve_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::ReserveBps, &reserve_bps);
        Ok(())
    }

    /// Update the collateral factor. Admin only. Lowering it can make existing
    /// positions liquidatable.
    pub fn set_collateral_factor(
        env: Env,
        admin: Address,
        collateral_factor_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if collateral_factor_bps == 0 || collateral_factor_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::CollateralFactorBps, &collateral_factor_bps);
        Ok(())
    }

    /// Set the collateral price in debt-token units (bps, 10_000 = par). Admin
    /// only. Used when valuing collateral for liquidation; defaults to par.
    pub fn set_collateral_price(
        env: Env,
        admin: Address,
        price_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if price_bps == 0 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::CollateralPriceBps, &price_bps);
        Ok(())
    }

    /// Liquidate an unhealthy position. The liquidator repays up to
    /// `repay_amount` of the borrower's debt and receives collateral of equal
    /// value. `liquidation_id` identifies the liquidation: reusing it for the
    /// same borrower fails, so a retried call cannot seize collateral twice.
    /// A call that reverts (e.g. a rejected token transfer) does not consume the
    /// id. If the collateral runs out, the remaining debt is written off to bad debt.
    /// Returns the collateral seized.
    ///
    /// ## Market isolation (#1478)
    /// A pair is one market. Everything a liquidation touches belongs to that
    /// market alone: the borrower's position and the liquidation id are read
    /// from this pair's storage, the liquidator repays in this pair's debt
    /// token, and the seized collateral is paid out of this pair's own holdings
    /// of this pair's collateral token. Another market's debt, collateral,
    /// liquidity or bad debt can never be used to settle this one, even when
    /// markets share a token, because each market's balance is held by its own
    /// contract. Before paying out, the pair checks that it really holds the
    /// collateral it is about to seize, so a position that is not backed by
    /// this market's funds fails with `InsufficientCollateral` instead of
    /// reaching for anything else.
    pub fn liquidate(
        env: Env,
        liquidator: Address,
        borrower: Address,
        liquidation_id: u64,
        repay_amount: i128,
    ) -> Result<i128, IsolatedLendingError> {
        liquidator.require_auth();
        if repay_amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;
        let index = Self::accrue(&env)?;

        let liquidation_key = PairDataKey::Liquidation(borrower.clone(), liquidation_id);
        if env.storage().persistent().has(&liquidation_key) {
            return Err(IsolatedLendingError::AlreadyLiquidated);
        }

        let collateral_key = PairDataKey::Collateral(borrower.clone());
        let collateral: i128 = env.storage().persistent().get(&collateral_key).unwrap_or(0);
        let debt = Self::debt_at(&env, &borrower, index)?;
        let collateral_factor_bps: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralFactorBps)
            .unwrap();
        let price_bps = Self::collateral_price_bps(&env) as i128;

        let collateral_value = Self::collateral_value(collateral, price_bps)?;
        let borrow_limit = collateral_value
            .checked_mul(collateral_factor_bps as i128)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        if debt <= borrow_limit {
            return Err(IsolatedLendingError::PositionStillBacked);
        }

        // One liquidation may repay at most the close factor's share of the debt.
        let close_factor_bps: i128 = env
            .storage()
            .instance()
            .get::<_, u32>(&PairDataKey::CloseFactorBps)
            .unwrap_or(10_000) as i128;
        let max_repay = debt
            .checked_mul(close_factor_bps)
            .and_then(|v| v.checked_add(BPS_DENOMINATOR - 1))
            .and_then(|v| v.checked_div(BPS_DENOMINATOR))
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let mut repaid = if repay_amount < max_repay {
            repay_amount
        } else {
            max_repay
        };
        let mut seized = repaid
            .checked_mul(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(price_bps)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        if seized > collateral {
            // Collateral cannot cover this repayment: take all of it and credit
            // only its value against the debt.
            seized = collateral;
            repaid = collateral_value;
        }
        if repaid <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }

        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        let collateral_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralToken)
            .unwrap();
        // Isolation guard (#1478): only this market's own holdings can be paid out.
        if token::Client::new(&env, &collateral_token).balance(&env.current_contract_address())
            < seized
        {
            return Err(IsolatedLendingError::InsufficientCollateral);
        }

        token::Client::new(&env, &debt_token).transfer(
            &liquidator,
            &env.current_contract_address(),
            &repaid,
        );
        token::Client::new(&env, &collateral_token).transfer(
            &env.current_contract_address(),
            &liquidator,
            &seized,
        );

        let remaining_collateral = collateral - seized;
        let mut remaining_debt = debt - repaid;
        let mut total_debt_reduction = repaid;
        if remaining_collateral == 0 && remaining_debt > 0 {
            let bad_debt: i128 = env
                .storage()
                .instance()
                .get(&PairDataKey::BadDebt)
                .unwrap_or(0);
            env.storage().instance().set(
                &PairDataKey::BadDebt,
                &bad_debt
                    .checked_add(remaining_debt)
                    .ok_or(IsolatedLendingError::MathOverflow)?,
            );
            total_debt_reduction = debt;
            remaining_debt = 0;
        }

        env.storage()
            .persistent()
            .set(&collateral_key, &remaining_collateral);
        Self::store_debt(&env, &borrower, remaining_debt, index);
        Self::reduce_total_debt(&env, total_debt_reduction);
        env.storage().persistent().set(&liquidation_key, &true);
        Ok(seized)
    }

    /// Cap the share of a borrower's debt one liquidation may repay (bps,
    /// default 10_000 = the whole debt). Admin only.
    pub fn set_close_factor(
        env: Env,
        admin: Address,
        close_factor_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if close_factor_bps == 0 || close_factor_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::CloseFactorBps, &close_factor_bps);
        Ok(())
    }

    /// Set the interest rate per ledger, in parts per billion of the borrow
    /// index. Interest up to this ledger accrues at the old rate. Admin only.
    pub fn set_interest_rate(
        env: Env,
        admin: Address,
        rate_per_ledger: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        Self::accrue(&env)?;
        env.storage()
            .instance()
            .set(&PairDataKey::InterestRatePerLedger, &rate_per_ledger);
        Ok(())
    }

    /// Set the share of accrued interest (bps) owed to the protocol. Admin only.
    pub fn set_protocol_fee_bps(
        env: Env,
        admin: Address,
        fee_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if fee_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        Self::accrue(&env)?;
        env.storage()
            .instance()
            .set(&PairDataKey::ProtocolFeeBps, &fee_bps);
        Ok(())
    }

    /// Pay accrued protocol fees to `to`, limited by the pair's token balance.
    /// Admin only. Returns the amount paid.
    pub fn claim_protocol_fees(
        env: Env,
        admin: Address,
        to: Address,
    ) -> Result<i128, IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        Self::accrue(&env)?;
        let fees: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::ProtocolFees)
            .unwrap_or(0);
        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        let token_client = token::Client::new(&env, &debt_token);
        let cash = token_client.balance(&env.current_contract_address());
        let paid = if fees < cash { fees } else { cash };
        if paid > 0 {
            env.storage()
                .instance()
                .set(&PairDataKey::ProtocolFees, &(fees - paid));
            token_client.transfer(&env.current_contract_address(), &to, &paid);
        }
        Ok(paid)
    }

    /// Configure the oracle allowed to push quotes. Admin only.
    pub fn set_oracle(
        env: Env,
        admin: Address,
        oracle: Address,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&PairDataKey::Oracle, &oracle);
        Ok(())
    }

    /// Require borrows to be backed by an oracle quote with at least
    /// `min_confidence_bps` confidence that is at most `max_age_ledgers` old.
    /// Admin only. Until set, borrowing does not consult the oracle.
    pub fn set_oracle_policy(
        env: Env,
        admin: Address,
        min_confidence_bps: u32,
        max_age_ledgers: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if min_confidence_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage().instance().set(
            &PairDataKey::OraclePolicy,
            &OraclePolicyConfig {
                min_confidence_bps,
                max_age_ledgers,
            },
        );
        Ok(())
    }

    /// Record a quote observed at the current ledger. Only the configured oracle may call.
    pub fn push_oracle_quote(
        env: Env,
        oracle: Address,
        price_bps: u32,
        confidence_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_init(&env)?;
        oracle.require_auth();
        let configured: Option<Address> = env.storage().instance().get(&PairDataKey::Oracle);
        if configured != Some(oracle) {
            return Err(IsolatedLendingError::Unauthorized);
        }
        if price_bps == 0 || confidence_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage().instance().set(
            &PairDataKey::OracleQuote,
            &OracleQuoteData {
                price_bps,
                confidence_bps,
                ledger: env.ledger().sequence(),
            },
        );
        Ok(())
    }

    /// Protocol fees accrued up to the current ledger and not yet claimed.
    pub fn get_protocol_fees(env: Env) -> Result<i128, IsolatedLendingError> {
        Self::require_init(&env)?;
        let (_, _, interest) = Self::pending_interest(&env)?;
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::ProtocolFeeBps)
            .unwrap_or(0);
        let fees: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::ProtocolFees)
            .unwrap_or(0);
        interest
            .checked_mul(fee_bps as i128)
            .and_then(|v| v.checked_div(BPS_DENOMINATOR))
            .and_then(|v| v.checked_add(fees))
            .ok_or(IsolatedLendingError::MathOverflow)
    }

    /// Liquidity available to borrow: supply minus debt, queued withdrawals
    /// and the reserve requirement.
    pub fn get_available_liquidity(env: Env) -> Result<i128, IsolatedLendingError> {
        Self::spendable_liquidity(&env)
    }

    /// Debt written off after liquidations left it uncovered by collateral.
    pub fn get_bad_debt(env: Env) -> Result<i128, IsolatedLendingError> {
        Self::require_init(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&PairDataKey::BadDebt)
            .unwrap_or(0))
    }

    /// Returns `(collateral, debt)` for a borrower.
    pub fn get_position(env: Env, user: Address) -> Result<(i128, i128), IsolatedLendingError> {
        Self::require_init(&env)?;
        let (_, index, _) = Self::pending_interest(&env)?;
        Ok((
            env.storage()
                .persistent()
                .get(&PairDataKey::Collateral(user.clone()))
                .unwrap_or(0),
            Self::debt_at(&env, &user, index)?,
        ))
    }

    /// Health-factor components of `user`'s position for client previews.
    /// Under an oracle policy, fails with the error `borrow` would raise when
    /// the quote is missing, stale or below the required confidence.
    pub fn get_health_factor(
        env: Env,
        user: Address,
    ) -> Result<HealthFactor, IsolatedLendingError> {
        Self::require_init(&env)?;
        Self::check_oracle(&env)?;
        let (_, index, _) = Self::pending_interest(&env)?;
        let collateral: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::Collateral(user.clone()))
            .unwrap_or(0);
        Ok(HealthFactor {
            debt_value: Self::debt_at(&env, &user, index)?,
            collateral_value: Self::collateral_value(
                collateral,
                Self::collateral_price_bps(&env) as i128,
            )?,
            threshold_bps: env
                .storage()
                .instance()
                .get(&PairDataKey::CollateralFactorBps)
                .unwrap(),
            ledger: env.ledger().sequence(),
        })
    }

    pub fn get_totals(env: Env) -> Result<(i128, i128), IsolatedLendingError> {
        Self::require_init(&env)?;
        Ok((
            env.storage()
                .instance()
                .get(&PairDataKey::TotalSupplied)
                .unwrap_or(0),
            Self::total_debt_now(&env)?,
        ))
    }

    fn require_admin(env: &Env, admin: &Address) -> Result<(), IsolatedLendingError> {
        Self::require_init(env)?;
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&PairDataKey::Admin).unwrap();
        if *admin != stored {
            return Err(IsolatedLendingError::Unauthorized);
        }
        Ok(())
    }

    fn collateral_price_bps(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&PairDataKey::CollateralPriceBps)
            .unwrap_or(10_000)
    }

    /// `collateral` valued in debt-token units at `price_bps`.
    fn collateral_value(collateral: i128, price_bps: i128) -> Result<i128, IsolatedLendingError> {
        collateral
            .checked_mul(price_bps)
            .and_then(|v| v.checked_div(BPS_DENOMINATOR))
            .ok_or(IsolatedLendingError::MathOverflow)
    }

    fn spendable_liquidity(env: &Env) -> Result<i128, IsolatedLendingError> {
        Self::require_init(env)?;
        let total_supplied: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalSupplied)
            .unwrap_or(0);
        let total_debt = Self::total_debt_now(env)?;
        let pending: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::PendingWithdrawals)
            .unwrap_or(0);
        let reserve_bps: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::ReserveBps)
            .unwrap_or(0);
        let reserve = total_supplied
            .checked_mul(reserve_bps as i128)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let available = total_supplied
            .checked_sub(total_debt)
            .and_then(|v| v.checked_sub(pending))
            .and_then(|v| v.checked_sub(reserve))
            .ok_or(IsolatedLendingError::MathOverflow)?;
        Ok(if available < 0 { 0 } else { available })
    }

    fn consume_pending_withdrawal(env: &Env, user: &Address, amount: i128) {
        let key = PairDataKey::PendingWithdrawal(user.clone());
        let pending: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if pending == 0 {
            return;
        }
        let consumed = if pending < amount { pending } else { amount };
        env.storage().persistent().set(&key, &(pending - consumed));
        let total: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::PendingWithdrawals)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&PairDataKey::PendingWithdrawals, &(total - consumed));
    }

    fn repay_debt(
        env: &Env,
        payer: &Address,
        borrower: &Address,
        amount: i128,
    ) -> Result<(), IsolatedLendingError> {
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(env)?;
        let index = Self::accrue(env)?;

        let old_debt = Self::debt_at(env, borrower, index)?;
        if old_debt < amount {
            return Err(IsolatedLendingError::InvalidAmount);
        }

        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        token::Client::new(env, &debt_token).transfer(
            payer,
            &env.current_contract_address(),
            &amount,
        );

        Self::store_debt(env, borrower, old_debt - amount, index);
        Self::reduce_total_debt(env, amount);
        Ok(())
    }

    /// Interest accrued since the last touch, as `(old_index, new_index, interest)`.
    /// Simple interest on the index for the elapsed ledgers; nothing accrues
    /// within the same ledger, so repeated touches are idempotent.
    fn pending_interest(env: &Env) -> Result<(i128, i128, i128), IsolatedLendingError> {
        let now = env.ledger().sequence();
        let index: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::BorrowIndex)
            .unwrap_or(INDEX_SCALE);
        let last: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::LastAccrualLedger)
            .unwrap_or(now);
        let rate: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::InterestRatePerLedger)
            .unwrap_or(0);
        let elapsed = now.saturating_sub(last) as i128;
        let growth = index
            .checked_mul(rate as i128)
            .and_then(|v| v.checked_mul(elapsed))
            .and_then(|v| v.checked_div(RATE_SCALE))
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let new_index = index
            .checked_add(growth)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let total_debt: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalDebt)
            .unwrap_or(0);
        let interest = total_debt
            .checked_mul(new_index - index)
            .and_then(|v| v.checked_div(index))
            .ok_or(IsolatedLendingError::MathOverflow)?;
        Ok((index, new_index, interest))
    }

    /// Apply pending interest to the market totals and protocol fees, and
    /// return the current borrow index.
    fn accrue(env: &Env) -> Result<i128, IsolatedLendingError> {
        let (index, new_index, interest) = Self::pending_interest(env)?;
        if new_index != index {
            let total_debt: i128 = env
                .storage()
                .instance()
                .get(&PairDataKey::TotalDebt)
                .unwrap_or(0);
            env.storage().instance().set(
                &PairDataKey::TotalDebt,
                &total_debt
                    .checked_add(interest)
                    .ok_or(IsolatedLendingError::MathOverflow)?,
            );
            let fee_bps: u32 = env
                .storage()
                .instance()
                .get(&PairDataKey::ProtocolFeeBps)
                .unwrap_or(0);
            let fee = interest
                .checked_mul(fee_bps as i128)
                .and_then(|v| v.checked_div(BPS_DENOMINATOR))
                .ok_or(IsolatedLendingError::MathOverflow)?;
            let fees: i128 = env
                .storage()
                .instance()
                .get(&PairDataKey::ProtocolFees)
                .unwrap_or(0);
            env.storage().instance().set(
                &PairDataKey::ProtocolFees,
                &fees
                    .checked_add(fee)
                    .ok_or(IsolatedLendingError::MathOverflow)?,
            );
            env.storage()
                .instance()
                .set(&PairDataKey::BorrowIndex, &new_index);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::LastAccrualLedger, &env.ledger().sequence());
        Ok(new_index)
    }

    fn total_debt_now(env: &Env) -> Result<i128, IsolatedLendingError> {
        let (_, _, interest) = Self::pending_interest(env)?;
        let total_debt: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalDebt)
            .unwrap_or(0);
        total_debt
            .checked_add(interest)
            .ok_or(IsolatedLendingError::MathOverflow)
    }

    /// A borrower's debt grown to `index`.
    fn debt_at(env: &Env, user: &Address, index: i128) -> Result<i128, IsolatedLendingError> {
        let debt: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::Debt(user.clone()))
            .unwrap_or(0);
        if debt == 0 {
            return Ok(0);
        }
        let snapshot: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::DebtIndex(user.clone()))
            .unwrap_or(INDEX_SCALE);
        debt.checked_mul(index)
            .and_then(|v| v.checked_div(snapshot))
            .ok_or(IsolatedLendingError::MathOverflow)
    }

    fn store_debt(env: &Env, user: &Address, debt: i128, index: i128) {
        env.storage()
            .persistent()
            .set(&PairDataKey::Debt(user.clone()), &debt);
        env.storage()
            .persistent()
            .set(&PairDataKey::DebtIndex(user.clone()), &index);
    }

    /// Per-borrower rounding can leave the total a few units below the sum of
    /// debts, so the total floors at zero instead of reverting.
    fn reduce_total_debt(env: &Env, amount: i128) {
        let total_debt: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalDebt)
            .unwrap_or(0);
        let remaining = if total_debt > amount {
            total_debt - amount
        } else {
            0
        };
        env.storage()
            .instance()
            .set(&PairDataKey::TotalDebt, &remaining);
    }

    /// Debt-token balance held by the pair, less fees owed to the protocol.
    fn redeemable_cash(env: &Env) -> Result<i128, IsolatedLendingError> {
        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        let cash = token::Client::new(env, &debt_token).balance(&env.current_contract_address());
        let fees: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::ProtocolFees)
            .unwrap_or(0);
        cash.checked_sub(fees)
            .ok_or(IsolatedLendingError::MathOverflow)
    }

    /// Borrowing is allowed only against a fresh, confident oracle quote when
    /// an oracle policy is configured.
    fn check_oracle(env: &Env) -> Result<(), IsolatedLendingError> {
        let policy: Option<OraclePolicyConfig> =
            env.storage().instance().get(&PairDataKey::OraclePolicy);
        let Some(policy) = policy else {
            return Ok(());
        };
        let quote: OracleQuoteData = env
            .storage()
            .instance()
            .get(&PairDataKey::OracleQuote)
            .ok_or(IsolatedLendingError::OracleQuoteMissing)?;
        if env.ledger().sequence().saturating_sub(quote.ledger) > policy.max_age_ledgers {
            return Err(IsolatedLendingError::OracleQuoteStale);
        }
        if quote.confidence_bps < policy.min_confidence_bps {
            return Err(IsolatedLendingError::OracleConfidenceTooLow);
        }
        Ok(())
    }

    fn require_init(env: &Env) -> Result<(), IsolatedLendingError> {
        if !env.storage().instance().has(&PairDataKey::Initialized) {
            return Err(IsolatedLendingError::NotInitialized);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};

    struct Setup {
        env: Env,
        admin: Address,
        pair: IsolatedLendingPairClient<'static>,
        collateral_token: Address,
        debt_token: Address,
        lender: Address,
        borrower: Address,
    }

    fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
        StellarAssetClient::new(env, token).mint(to, &amount);
    }

    fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
        TokenClient::new(env, token).balance(who)
    }

    /// Pair with 80% collateral factor; the lender supplied 1_000, the borrower
    /// posted 100 collateral and borrowed 80.
    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let collateral_token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let debt_token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let pair_id = env.register(IsolatedLendingPair, ());
        let pair = IsolatedLendingPairClient::new(&env, &pair_id);
        pair.initialize(&admin, &collateral_token, &debt_token, &8_000);

        let lender = Address::generate(&env);
        let borrower = Address::generate(&env);
        mint(&env, &debt_token, &lender, 1_000);
        mint(&env, &collateral_token, &borrower, 100);
        pair.supply(&lender, &1_000);
        pair.post_collateral(&borrower, &100);
        pair.borrow(&borrower, &80);

        Setup {
            env,
            admin,
            pair,
            collateral_token,
            debt_token,
            lender,
            borrower,
        }
    }

    // ── Repay on behalf ─────────────────────────────────────────────

    #[test]
    fn third_party_partial_repay_only_changes_borrower_debt() {
        let s = setup();
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 30);
        let borrower_balance = balance(&s.env, &s.debt_token, &s.borrower);

        s.pair.repay_for(&payer, &s.borrower, &30);

        assert_eq!(s.pair.get_position(&s.borrower), (100, 50));
        assert_eq!(s.pair.get_totals(), (1_000, 50));
        assert_eq!(balance(&s.env, &s.debt_token, &payer), 0);
        assert_eq!(
            balance(&s.env, &s.debt_token, &s.borrower),
            borrower_balance
        );
        assert_eq!(s.pair.get_position(&payer), (0, 0));
    }

    #[test]
    fn third_party_full_repay_clears_debt() {
        let s = setup();
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 80);

        s.pair.repay_for(&payer, &s.borrower, &80);

        assert_eq!(s.pair.get_position(&s.borrower), (100, 0));
        assert_eq!(s.pair.get_totals(), (1_000, 0));
    }

    #[test]
    fn third_party_repay_above_debt_is_rejected() {
        let s = setup();
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 100);

        let res = s.pair.try_repay_for(&payer, &s.borrower, &81);
        assert_eq!(res, Err(Ok(IsolatedLendingError::InvalidAmount)));
        assert_eq!(s.pair.get_position(&s.borrower), (100, 80));
    }

    // ── Borrow liquidity ────────────────────────────────────────────

    #[test]
    fn borrow_at_the_liquidity_limit_succeeds() {
        let s = setup();
        // 1_000 supplied, 80 borrowed -> 920 available.
        assert_eq!(s.pair.get_available_liquidity(), 920);
        mint(&s.env, &s.collateral_token, &s.borrower, 2_000);
        s.pair.post_collateral(&s.borrower, &2_000);

        s.pair.borrow(&s.borrower, &920);

        assert_eq!(s.pair.get_available_liquidity(), 0);
        let res = s.pair.try_borrow(&s.borrower, &1);
        assert_eq!(res, Err(Ok(IsolatedLendingError::InsufficientLiquidity)));
    }

    #[test]
    fn queued_withdrawals_reduce_borrowable_liquidity() {
        let s = setup();
        mint(&s.env, &s.collateral_token, &s.borrower, 2_000);
        s.pair.post_collateral(&s.borrower, &2_000);

        s.pair.queue_withdrawal(&s.lender, &900);
        assert_eq!(s.pair.get_available_liquidity(), 20);

        let res = s.pair.try_borrow(&s.borrower, &21);
        assert_eq!(res, Err(Ok(IsolatedLendingError::InsufficientLiquidity)));
        s.pair.borrow(&s.borrower, &20);
    }

    #[test]
    fn withdrawing_clears_the_queued_amount() {
        let s = setup();
        s.pair.queue_withdrawal(&s.lender, &500);
        assert_eq!(s.pair.get_available_liquidity(), 420);

        s.pair.withdraw(&s.lender, &500);

        // 500 supplied, 80 borrowed, nothing queued.
        assert_eq!(s.pair.get_available_liquidity(), 420);
    }

    #[test]
    fn queued_withdrawal_cannot_exceed_supply() {
        let s = setup();
        let res = s.pair.try_queue_withdrawal(&s.lender, &1_001);
        assert_eq!(res, Err(Ok(IsolatedLendingError::InsufficientLiquidity)));
    }

    #[test]
    fn reserve_requirement_reduces_borrowable_liquidity() {
        let s = setup();
        s.pair.set_reserve_bps(&s.admin, &1_000);
        // 1_000 - 80 debt - 100 reserve.
        assert_eq!(s.pair.get_available_liquidity(), 820);

        let outsider = Address::generate(&s.env);
        let res = s.pair.try_set_reserve_bps(&outsider, &500);
        assert_eq!(res, Err(Ok(IsolatedLendingError::Unauthorized)));
    }

    // ── Liquidation ─────────────────────────────────────────────────

    #[test]
    fn healthy_position_cannot_be_liquidated() {
        let s = setup();
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        let res = s.pair.try_liquidate(&liquidator, &s.borrower, &1, &80);
        assert_eq!(res, Err(Ok(IsolatedLendingError::PositionStillBacked)));
    }

    #[test]
    fn fully_covered_liquidation_records_no_bad_debt() {
        let s = setup();
        s.pair.set_collateral_factor(&s.admin, &4_000);
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        let seized = s.pair.liquidate(&liquidator, &s.borrower, &1, &80);

        assert_eq!(seized, 80);
        assert_eq!(s.pair.get_position(&s.borrower), (20, 0));
        assert_eq!(s.pair.get_totals(), (1_000, 0));
        assert_eq!(s.pair.get_bad_debt(), 0);
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 80);
        assert_eq!(balance(&s.env, &s.debt_token, &liquidator), 0);
    }

    #[test]
    fn repeated_liquidation_id_cannot_seize_twice() {
        let s = setup();
        s.pair.set_collateral_factor(&s.admin, &4_000);
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        s.pair.liquidate(&liquidator, &s.borrower, &7, &40);
        let after_first = s.pair.get_position(&s.borrower);
        let res = s.pair.try_liquidate(&liquidator, &s.borrower, &7, &40);

        assert_eq!(res, Err(Ok(IsolatedLendingError::AlreadyLiquidated)));
        assert_eq!(s.pair.get_position(&s.borrower), after_first);
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 40);
    }

    #[test]
    fn rejected_settlement_does_not_consume_the_liquidation_id() {
        let s = setup();
        s.pair.set_collateral_factor(&s.admin, &4_000);
        let liquidator = Address::generate(&s.env);

        // No debt tokens yet, so the repayment transfer is rejected.
        assert!(s
            .pair
            .try_liquidate(&liquidator, &s.borrower, &3, &40)
            .is_err());
        assert_eq!(s.pair.get_position(&s.borrower), (100, 80));

        mint(&s.env, &s.debt_token, &liquidator, 40);
        assert_eq!(s.pair.liquidate(&liquidator, &s.borrower, &3, &40), 40);
        assert_eq!(s.pair.get_position(&s.borrower), (60, 40));
    }

    #[test]
    fn undercollateralized_liquidation_records_bad_debt() {
        let s = setup();
        // Collateral worth 50 against 80 of debt.
        s.pair.set_collateral_price(&s.admin, &5_000);
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        let seized = s.pair.liquidate(&liquidator, &s.borrower, &1, &80);

        assert_eq!(seized, 100);
        assert_eq!(s.pair.get_position(&s.borrower), (0, 0));
        // The liquidator paid the collateral's value; the other 30 is bad debt.
        assert_eq!(balance(&s.env, &s.debt_token, &liquidator), 30);
        assert_eq!(s.pair.get_bad_debt(), 30);
        assert_eq!(s.pair.get_totals(), (1_000, 0));
        assert_eq!(balance(&s.env, &s.debt_token, &s.lender), 0);
    }

    fn set_ledger(env: &Env, sequence: u32) {
        env.ledger().with_mut(|l| l.sequence_number = sequence);
    }

    /// 12.5% per ledger: the setup's 80 of debt grows by 10 each ledger.
    const RATE: u32 = 125_000_000;

    // ── Liquidation close factor ────────────────────────────────────

    fn unhealthy_with_close_factor(s: &Setup) -> Address {
        s.pair.set_collateral_factor(&s.admin, &4_000);
        s.pair.set_close_factor(&s.admin, &5_000);
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);
        liquidator
    }

    #[test]
    fn liquidation_below_the_close_factor_repays_what_was_asked() {
        let s = setup();
        let liquidator = unhealthy_with_close_factor(&s);

        assert_eq!(s.pair.liquidate(&liquidator, &s.borrower, &1, &20), 20);
        assert_eq!(s.pair.get_position(&s.borrower), (80, 60));
    }

    #[test]
    fn liquidation_at_the_close_factor_is_allowed() {
        let s = setup();
        let liquidator = unhealthy_with_close_factor(&s);

        assert_eq!(s.pair.liquidate(&liquidator, &s.borrower, &1, &40), 40);
        assert_eq!(s.pair.get_position(&s.borrower), (60, 40));
    }

    #[test]
    fn liquidation_above_the_close_factor_is_capped() {
        let s = setup();
        let liquidator = unhealthy_with_close_factor(&s);

        // Asked for 80 of 80, but only half the debt may be repaid at once.
        assert_eq!(s.pair.liquidate(&liquidator, &s.borrower, &1, &80), 40);
        assert_eq!(s.pair.get_position(&s.borrower), (60, 40));
        assert_eq!(balance(&s.env, &s.debt_token, &liquidator), 40);
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 40);
    }

    #[test]
    fn close_factor_must_be_a_valid_share_set_by_the_admin() {
        let s = setup();
        assert_eq!(
            s.pair.try_set_close_factor(&s.admin, &0),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );
        assert_eq!(
            s.pair.try_set_close_factor(&s.admin, &10_001),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );
        let outsider = Address::generate(&s.env);
        assert_eq!(
            s.pair.try_set_close_factor(&outsider, &5_000),
            Err(Ok(IsolatedLendingError::Unauthorized))
        );
    }

    // ── Interest accrual ────────────────────────────────────────────

    #[test]
    fn interest_does_not_accrue_within_the_same_ledger() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);

        assert_eq!(s.pair.get_position(&s.borrower), (100, 80));
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 1);
        s.pair.repay_for(&payer, &s.borrower, &1);
        assert_eq!(s.pair.get_position(&s.borrower), (100, 79));
        assert_eq!(s.pair.get_totals(), (1_000, 79));
    }

    #[test]
    fn interest_accrues_for_one_ledger() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);

        set_ledger(&s.env, 1);

        assert_eq!(s.pair.get_position(&s.borrower), (100, 90));
        assert_eq!(s.pair.get_totals(), (1_000, 90));
    }

    #[test]
    fn interest_accrues_over_a_long_gap_in_one_step() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);

        set_ledger(&s.env, 100);

        // 80 + 80 * 12.5% * 100 ledgers.
        assert_eq!(s.pair.get_position(&s.borrower), (100, 1_080));
        assert_eq!(s.pair.get_totals(), (1_000, 1_080));
    }

    #[test]
    fn touching_a_position_twice_in_a_ledger_accrues_once() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 20);

        set_ledger(&s.env, 1);
        s.pair.repay_for(&payer, &s.borrower, &10);
        s.pair.repay_for(&payer, &s.borrower, &10);

        // 80 + 10 interest - 20 repaid.
        assert_eq!(s.pair.get_position(&s.borrower), (100, 70));
        assert_eq!(s.pair.get_totals(), (1_000, 70));
    }

    #[test]
    fn rate_change_settles_interest_at_the_old_rate() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);

        set_ledger(&s.env, 1);
        s.pair.set_interest_rate(&s.admin, &0);
        set_ledger(&s.env, 50);

        assert_eq!(s.pair.get_position(&s.borrower), (100, 90));
    }

    // ── Protocol fees ───────────────────────────────────────────────

    #[test]
    fn protocol_fees_are_a_share_of_accrued_interest() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        s.pair.set_protocol_fee_bps(&s.admin, &5_000);

        set_ledger(&s.env, 1);

        // 10 of interest, half owed to the protocol.
        assert_eq!(s.pair.get_protocol_fees(), 5);
    }

    #[test]
    fn suppliers_cannot_withdraw_funds_owed_to_the_protocol() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        s.pair.set_protocol_fee_bps(&s.admin, &5_000);
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 10);

        set_ledger(&s.env, 1);
        s.pair.repay_for(&payer, &s.borrower, &10);

        // 920 + 10 repaid = 930 in the pair, 5 of it owed to the protocol.
        assert_eq!(
            s.pair.try_withdraw(&s.lender, &926),
            Err(Ok(IsolatedLendingError::InsufficientLiquidity))
        );
        s.pair.withdraw(&s.lender, &925);

        let treasury = Address::generate(&s.env);
        assert_eq!(s.pair.claim_protocol_fees(&s.admin, &treasury), 5);
        assert_eq!(balance(&s.env, &s.debt_token, &treasury), 5);
        assert_eq!(s.pair.get_protocol_fees(), 0);
    }

    #[test]
    fn full_redemption_after_interest_leaves_the_protocol_fees() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        s.pair.set_protocol_fee_bps(&s.admin, &5_000);
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 90);

        set_ledger(&s.env, 1);
        s.pair.repay_for(&payer, &s.borrower, &90);
        assert_eq!(s.pair.get_position(&s.borrower), (100, 0));

        // The lender redeems the whole deposit; the interest stays in the pair.
        s.pair.withdraw(&s.lender, &1_000);
        assert_eq!(balance(&s.env, &s.debt_token, &s.lender), 1_000);

        let treasury = Address::generate(&s.env);
        assert_eq!(s.pair.claim_protocol_fees(&s.admin, &treasury), 5);
        assert_eq!(balance(&s.env, &s.debt_token, &treasury), 5);
    }

    #[test]
    fn protocol_fee_share_must_be_valid_and_set_by_the_admin() {
        let s = setup();
        assert_eq!(
            s.pair.try_set_protocol_fee_bps(&s.admin, &10_001),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );
        let outsider = Address::generate(&s.env);
        assert_eq!(
            s.pair.try_claim_protocol_fees(&outsider, &outsider),
            Err(Ok(IsolatedLendingError::Unauthorized))
        );
    }

    // ── Oracle policy ───────────────────────────────────────────────

    /// Gives the borrower enough collateral to borrow 10 more and applies a
    /// policy of at least 80% confidence on quotes no older than 10 ledgers.
    fn with_oracle_policy(s: &Setup) -> Address {
        mint(&s.env, &s.collateral_token, &s.borrower, 100);
        s.pair.post_collateral(&s.borrower, &100);
        let oracle = Address::generate(&s.env);
        s.pair.set_oracle(&s.admin, &oracle);
        s.pair.set_oracle_policy(&s.admin, &8_000, &10);
        oracle
    }

    #[test]
    fn borrow_with_a_fresh_confident_quote_is_accepted() {
        let s = setup();
        let oracle = with_oracle_policy(&s);

        s.pair.push_oracle_quote(&oracle, &10_000, &9_000);
        set_ledger(&s.env, 10);

        s.pair.borrow(&s.borrower, &10);
        assert_eq!(s.pair.get_position(&s.borrower), (200, 90));
    }

    #[test]
    fn borrow_with_a_low_confidence_quote_is_rejected() {
        let s = setup();
        let oracle = with_oracle_policy(&s);

        s.pair.push_oracle_quote(&oracle, &10_000, &7_999);

        assert_eq!(
            s.pair.try_borrow(&s.borrower, &10),
            Err(Ok(IsolatedLendingError::OracleConfidenceTooLow))
        );
    }

    #[test]
    fn borrow_with_a_stale_quote_is_rejected() {
        let s = setup();
        let oracle = with_oracle_policy(&s);

        s.pair.push_oracle_quote(&oracle, &10_000, &9_000);
        set_ledger(&s.env, 11);

        assert_eq!(
            s.pair.try_borrow(&s.borrower, &10),
            Err(Ok(IsolatedLendingError::OracleQuoteStale))
        );
    }

    #[test]
    fn borrow_without_a_quote_is_rejected_once_a_policy_is_set() {
        let s = setup();
        with_oracle_policy(&s);

        assert_eq!(
            s.pair.try_borrow(&s.borrower, &10),
            Err(Ok(IsolatedLendingError::OracleQuoteMissing))
        );
    }

    #[test]
    fn only_the_configured_oracle_can_push_quotes() {
        let s = setup();
        with_oracle_policy(&s);
        let impostor = Address::generate(&s.env);

        assert_eq!(
            s.pair.try_push_oracle_quote(&impostor, &10_000, &9_000),
            Err(Ok(IsolatedLendingError::Unauthorized))
        );
    }

    // ── Market isolation during liquidation (#1478) ─────────────────

    /// Opens an independent market on the shared `env`: the lender supplies
    /// 1_000 of `debt_token`, the borrower posts 100 of `collateral_token` and
    /// borrows 80, at an 80% collateral factor.
    fn open_market(
        env: &Env,
        admin: &Address,
        collateral_token: &Address,
        debt_token: &Address,
        lender: &Address,
        borrower: &Address,
    ) -> IsolatedLendingPairClient<'static> {
        let pair_id = env.register(IsolatedLendingPair, ());
        let pair = IsolatedLendingPairClient::new(env, &pair_id);
        pair.initialize(admin, collateral_token, debt_token, &8_000);
        mint(env, debt_token, lender, 1_000);
        mint(env, collateral_token, borrower, 100);
        pair.supply(lender, &1_000);
        pair.post_collateral(borrower, &100);
        pair.borrow(borrower, &80);
        pair
    }

    struct TwoMarkets {
        env: Env,
        admin: Address,
        borrower: Address,
        lender: Address,
        col_a: Address,
        debt_a: Address,
        col_b: Address,
        debt_b: Address,
        market_a: IsolatedLendingPairClient<'static>,
        market_b: IsolatedLendingPairClient<'static>,
    }

    fn new_token(env: &Env) -> Address {
        env.register_stellar_asset_contract_v2(Address::generate(env))
            .address()
    }

    /// Two simultaneous markets with entirely separate tokens, and the same
    /// borrower and lender active in both.
    fn two_markets() -> TwoMarkets {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let borrower = Address::generate(&env);
        let lender = Address::generate(&env);
        let (col_a, debt_a, col_b, debt_b) = (
            new_token(&env),
            new_token(&env),
            new_token(&env),
            new_token(&env),
        );
        let market_a = open_market(&env, &admin, &col_a, &debt_a, &lender, &borrower);
        let market_b = open_market(&env, &admin, &col_b, &debt_b, &lender, &borrower);
        TwoMarkets {
            env,
            admin,
            borrower,
            lender,
            col_a,
            debt_a,
            col_b,
            debt_b,
            market_a,
            market_b,
        }
    }

    #[test]
    fn two_markets_hold_independent_positions() {
        let m = two_markets();
        assert_eq!(m.market_a.get_position(&m.borrower), (100, 80));
        assert_eq!(m.market_b.get_position(&m.borrower), (100, 80));
        assert_eq!(m.market_a.get_totals(), (1_000, 80));
        assert_eq!(m.market_b.get_totals(), (1_000, 80));
    }

    #[test]
    fn liquidating_one_market_leaves_the_other_untouched() {
        let m = two_markets();
        m.market_a.set_collateral_factor(&m.admin, &4_000);
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_a, &liquidator, 80);

        let b_before = (
            m.market_b.get_position(&m.borrower),
            m.market_b.get_totals(),
            m.market_b.get_bad_debt(),
            balance(&m.env, &m.col_b, &m.market_b.address),
            balance(&m.env, &m.debt_b, &m.market_b.address),
        );

        assert_eq!(m.market_a.liquidate(&liquidator, &m.borrower, &1, &80), 80);

        assert_eq!(m.market_a.get_position(&m.borrower), (20, 0));
        let b_after = (
            m.market_b.get_position(&m.borrower),
            m.market_b.get_totals(),
            m.market_b.get_bad_debt(),
            balance(&m.env, &m.col_b, &m.market_b.address),
            balance(&m.env, &m.debt_b, &m.market_b.address),
        );
        assert_eq!(b_before, b_after);
        // B's debt is still owed in full and B's lender can still be repaid.
        assert_eq!(m.market_b.get_position(&m.borrower), (100, 80));
    }

    #[test]
    fn a_liquidator_paying_the_other_markets_debt_token_cannot_liquidate() {
        let m = two_markets();
        m.market_a.set_collateral_factor(&m.admin, &4_000);
        // Holds plenty of market B's debt token, none of market A's.
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_b, &liquidator, 1_000);

        let res = m.market_a.try_liquidate(&liquidator, &m.borrower, &1, &80);

        assert!(res.is_err());
        assert_eq!(m.market_a.get_position(&m.borrower), (100, 80));
        assert_eq!(m.market_b.get_position(&m.borrower), (100, 80));
        assert_eq!(balance(&m.env, &m.debt_b, &liquidator), 1_000);
        assert_eq!(balance(&m.env, &m.col_a, &liquidator), 0);
    }

    #[test]
    fn a_position_unhealthy_only_in_another_market_cannot_be_liquidated_here() {
        let m = two_markets();
        // Only market B turns unhealthy for the shared borrower.
        m.market_b.set_collateral_factor(&m.admin, &4_000);
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_a, &liquidator, 80);
        mint(&m.env, &m.debt_b, &liquidator, 80);

        assert_eq!(
            m.market_a.try_liquidate(&liquidator, &m.borrower, &1, &80),
            Err(Ok(IsolatedLendingError::PositionStillBacked))
        );
        assert_eq!(m.market_a.get_position(&m.borrower), (100, 80));

        // The unhealthy market can still be liquidated on its own terms.
        assert_eq!(m.market_b.liquidate(&liquidator, &m.borrower, &1, &80), 80);
        assert_eq!(m.market_a.get_position(&m.borrower), (100, 80));
    }

    #[test]
    fn a_borrower_with_no_position_in_a_market_cannot_be_liquidated_there() {
        let m = two_markets();
        m.market_a.set_collateral_factor(&m.admin, &4_000);
        let stranger = Address::generate(&m.env);
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_a, &liquidator, 80);

        // No collateral and no debt: nothing to take.
        assert!(m
            .market_a
            .try_liquidate(&liquidator, &stranger, &1, &80)
            .is_err());
        assert_eq!(balance(&m.env, &m.debt_a, &liquidator), 80);
    }

    #[test]
    fn liquidation_ids_are_scoped_to_their_market() {
        let m = two_markets();
        m.market_a.set_collateral_factor(&m.admin, &4_000);
        m.market_b.set_collateral_factor(&m.admin, &4_000);
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_a, &liquidator, 80);
        mint(&m.env, &m.debt_b, &liquidator, 80);

        // Id 7 is consumed in market A only.
        m.market_a.liquidate(&liquidator, &m.borrower, &7, &40);
        assert_eq!(
            m.market_a.try_liquidate(&liquidator, &m.borrower, &7, &40),
            Err(Ok(IsolatedLendingError::AlreadyLiquidated))
        );
        // The same id in market B is a different liquidation.
        assert_eq!(m.market_b.liquidate(&liquidator, &m.borrower, &7, &40), 40);
        assert_eq!(m.market_b.get_position(&m.borrower), (60, 40));
    }

    #[test]
    fn bad_debt_is_recorded_only_in_the_market_that_incurred_it() {
        let m = two_markets();
        // Collateral in A is worth 50 against 80 of debt.
        m.market_a.set_collateral_price(&m.admin, &5_000);
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_a, &liquidator, 80);

        m.market_a.liquidate(&liquidator, &m.borrower, &1, &80);

        assert_eq!(m.market_a.get_bad_debt(), 30);
        assert_eq!(m.market_b.get_bad_debt(), 0);
        assert_eq!(m.market_b.get_totals(), (1_000, 80));
    }

    #[test]
    fn markets_sharing_a_debt_token_do_not_share_liquidity() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let borrower = Address::generate(&env);
        let lender_a = Address::generate(&env);
        let lender_b = Address::generate(&env);
        let shared_debt = new_token(&env);
        let col_a = new_token(&env);
        let col_b = new_token(&env);
        let market_a = open_market(&env, &admin, &col_a, &shared_debt, &lender_a, &borrower);
        let market_b = open_market(&env, &admin, &col_b, &shared_debt, &lender_b, &borrower);

        market_a.set_collateral_factor(&admin, &4_000);
        let liquidator = Address::generate(&env);
        mint(&env, &shared_debt, &liquidator, 80);
        market_a.liquidate(&liquidator, &borrower, &1, &80);

        // The liquidator's repayment stays with market A.
        assert_eq!(balance(&env, &shared_debt, &market_a.address), 920 + 80);
        assert_eq!(balance(&env, &shared_debt, &market_b.address), 920);
        // Market B's lender can still withdraw only what market B holds.
        assert_eq!(market_b.get_available_liquidity(), 920);
        assert_eq!(market_b.get_totals(), (1_000, 80));
        assert_eq!(market_b.get_position(&borrower), (100, 80));
    }

    #[test]
    fn markets_sharing_a_collateral_token_pay_out_only_their_own_holdings() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let borrower = Address::generate(&env);
        let lender = Address::generate(&env);
        let shared_collateral = new_token(&env);
        let debt_a = new_token(&env);
        let debt_b = new_token(&env);
        let market_a = open_market(
            &env,
            &admin,
            &shared_collateral,
            &debt_a,
            &lender,
            &borrower,
        );
        let market_b = open_market(
            &env,
            &admin,
            &shared_collateral,
            &debt_b,
            &lender,
            &borrower,
        );
        assert_eq!(balance(&env, &shared_collateral, &market_a.address), 100);
        assert_eq!(balance(&env, &shared_collateral, &market_b.address), 100);

        // Market A's collateral is nearly worthless: a full liquidation seizes
        // every unit market A holds, and nothing from market B.
        market_a.set_collateral_price(&admin, &1_000);
        let liquidator = Address::generate(&env);
        mint(&env, &debt_a, &liquidator, 80);
        let seized = market_a.liquidate(&liquidator, &borrower, &1, &80);

        assert_eq!(seized, 100);
        assert_eq!(balance(&env, &shared_collateral, &market_a.address), 0);
        assert_eq!(balance(&env, &shared_collateral, &market_b.address), 100);
        assert_eq!(balance(&env, &shared_collateral, &liquidator), 100);
        assert_eq!(market_b.get_position(&borrower), (100, 80));
    }

    #[test]
    fn a_market_cannot_pay_out_collateral_it_does_not_hold() {
        let s = setup();
        // Corrupt the books: the pair believes the borrower posted far more
        // collateral than the contract actually holds (100).
        s.env.as_contract(&s.pair.address, || {
            s.env
                .storage()
                .persistent()
                .set(&PairDataKey::Collateral(s.borrower.clone()), &1_000_i128);
        });
        s.pair.set_collateral_price(&s.admin, &900); // limit 72 < debt 80
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        // 80 / 0.09 = 888 collateral would be seized; the pair holds 100.
        assert_eq!(
            s.pair.try_liquidate(&liquidator, &s.borrower, &1, &80),
            Err(Ok(IsolatedLendingError::InsufficientCollateral))
        );
        // Rejected cleanly: no tokens moved and the liquidation id is still free.
        assert_eq!(balance(&s.env, &s.debt_token, &liquidator), 80);
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 0);
        assert_eq!(balance(&s.env, &s.collateral_token, &s.pair.address), 100);
        s.env.as_contract(&s.pair.address, || {
            assert!(!s
                .env
                .storage()
                .persistent()
                .has(&PairDataKey::Liquidation(s.borrower.clone(), 1)));
        });
    }

    #[test]
    fn factory_pairs_for_different_token_pairs_are_distinct_markets() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let factory_id = env.register(IsolatedLendingFactory, ());
        let factory = IsolatedLendingFactoryClient::new(&env, &factory_id);
        factory.initialize_factory(&admin);
        let (a, b, c) = (new_token(&env), new_token(&env), new_token(&env));

        let ab = factory.create_pair(&admin, &a, &b, &8_000);
        let ac = factory.create_pair(&admin, &a, &c, &8_000);
        let ba = factory.create_pair(&admin, &b, &a, &8_000);

        // Same tokens in a different role, or a different counterpart, is a different market.
        assert_ne!(ab.pair_id, ac.pair_id);
        assert_ne!(ab.pair_id, ba.pair_id);
        assert!(matches!(
            factory.try_create_pair(&admin, &a, &b, &8_000),
            Err(Ok(IsolatedLendingError::PairAlreadyExists))
        ));
    }

    // ── Health-factor components (#1487) ────────────────────────────

    #[test]
    fn health_factor_tracks_collateral_price_movement() {
        let s = setup();
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        // 80 <= 100 * 80%: backed, and liquidation agrees.
        assert_eq!(
            s.pair.get_health_factor(&s.borrower),
            HealthFactor {
                debt_value: 80,
                collateral_value: 100,
                threshold_bps: 8_000,
                ledger: s.env.ledger().sequence(),
            }
        );
        assert_eq!(
            s.pair.try_liquidate(&liquidator, &s.borrower, &1, &80),
            Err(Ok(IsolatedLendingError::PositionStillBacked))
        );

        // A 10% price drop: 80 > 90 * 80% = 72, and liquidation agrees.
        s.pair.set_collateral_price(&s.admin, &9_000);
        let health = s.pair.get_health_factor(&s.borrower);
        assert_eq!((health.debt_value, health.collateral_value), (80, 90));
        assert_eq!(s.pair.liquidate(&liquidator, &s.borrower, &1, &80), 88);
    }

    #[test]
    fn health_factor_reports_debt_accrued_to_the_calculation_ledger() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        set_ledger(&s.env, 2);

        let health = s.pair.get_health_factor(&s.borrower);
        assert_eq!((health.debt_value, health.ledger), (100, 2));
        assert_eq!(s.pair.get_position(&s.borrower).1, health.debt_value);
    }

    #[test]
    fn health_factor_with_empty_debt() {
        let s = setup();
        s.pair.repay(&s.borrower, &80);

        let health = s.pair.get_health_factor(&s.borrower);
        assert_eq!((health.debt_value, health.collateral_value), (0, 100));

        let stranger = Address::generate(&s.env);
        assert_eq!(
            s.pair.get_health_factor(&stranger),
            HealthFactor {
                debt_value: 0,
                collateral_value: 0,
                threshold_bps: 8_000,
                ledger: s.env.ledger().sequence(),
            }
        );
    }

    #[test]
    fn health_factor_rejects_an_invalid_oracle_state() {
        let s = setup();
        let oracle = with_oracle_policy(&s);
        assert_eq!(
            s.pair.try_get_health_factor(&s.borrower),
            Err(Ok(IsolatedLendingError::OracleQuoteMissing))
        );

        s.pair.push_oracle_quote(&oracle, &10_000, &7_999);
        assert_eq!(
            s.pair.try_get_health_factor(&s.borrower),
            Err(Ok(IsolatedLendingError::OracleConfidenceTooLow))
        );

        s.pair.push_oracle_quote(&oracle, &10_000, &9_000);
        assert_eq!(s.pair.get_health_factor(&s.borrower).collateral_value, 200);

        set_ledger(&s.env, 11);
        assert_eq!(
            s.pair.try_get_health_factor(&s.borrower),
            Err(Ok(IsolatedLendingError::OracleQuoteStale))
        );
    }
}
