#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

const BPS_DENOMINATOR: i128 = 10_000;

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

        let key = PairDataKey::Supply(user.clone());
        let old_supply: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if old_supply < amount {
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
        let current_debt: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::Debt(user.clone()))
            .unwrap_or(0);

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

        env.storage()
            .persistent()
            .set(&PairDataKey::Debt(user.clone()), &new_debt);
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

        let current_debt: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::Debt(user.clone()))
            .unwrap_or(0);
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

        let liquidation_key = PairDataKey::Liquidation(borrower.clone(), liquidation_id);
        if env.storage().persistent().has(&liquidation_key) {
            return Err(IsolatedLendingError::AlreadyLiquidated);
        }

        let collateral_key = PairDataKey::Collateral(borrower.clone());
        let debt_key = PairDataKey::Debt(borrower.clone());
        let collateral: i128 = env.storage().persistent().get(&collateral_key).unwrap_or(0);
        let debt: i128 = env.storage().persistent().get(&debt_key).unwrap_or(0);
        let collateral_factor_bps: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralFactorBps)
            .unwrap();
        let price_bps = Self::collateral_price_bps(&env) as i128;

        let collateral_value = collateral
            .checked_mul(price_bps)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let borrow_limit = collateral_value
            .checked_mul(collateral_factor_bps as i128)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        if debt <= borrow_limit {
            return Err(IsolatedLendingError::PositionStillBacked);
        }

        let mut repaid = if repay_amount < debt { repay_amount } else { debt };
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
        env.storage().persistent().set(&debt_key, &remaining_debt);
        let total_debt: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalDebt)
            .unwrap_or(0);
        env.storage().instance().set(
            &PairDataKey::TotalDebt,
            &total_debt
                .checked_sub(total_debt_reduction)
                .ok_or(IsolatedLendingError::MathOverflow)?,
        );
        env.storage().persistent().set(&liquidation_key, &true);
        Ok(seized)
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
        Ok((
            env.storage()
                .persistent()
                .get(&PairDataKey::Collateral(user.clone()))
                .unwrap_or(0),
            env.storage()
                .persistent()
                .get(&PairDataKey::Debt(user))
                .unwrap_or(0),
        ))
    }

    pub fn get_totals(env: Env) -> Result<(i128, i128), IsolatedLendingError> {
        Self::require_init(&env)?;
        Ok((
            env.storage()
                .instance()
                .get(&PairDataKey::TotalSupplied)
                .unwrap_or(0),
            env.storage()
                .instance()
                .get(&PairDataKey::TotalDebt)
                .unwrap_or(0),
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

    fn spendable_liquidity(env: &Env) -> Result<i128, IsolatedLendingError> {
        Self::require_init(env)?;
        let total_supplied: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalSupplied)
            .unwrap_or(0);
        let total_debt: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalDebt)
            .unwrap_or(0);
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

        let debt_key = PairDataKey::Debt(borrower.clone());
        let old_debt: i128 = env.storage().persistent().get(&debt_key).unwrap_or(0);
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

        env.storage()
            .persistent()
            .set(&debt_key, &(old_debt - amount));
        let total_debt: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalDebt)
            .unwrap_or(0);
        env.storage().instance().set(
            &PairDataKey::TotalDebt,
            &total_debt
                .checked_sub(amount)
                .ok_or(IsolatedLendingError::MathOverflow)?,
        );
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
    use soroban_sdk::testutils::Address as _;
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
        assert_eq!(balance(&s.env, &s.debt_token, &s.borrower), borrower_balance);
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
}
