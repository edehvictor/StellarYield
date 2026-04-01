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
}

#[contract]
pub struct IsolatedLendingFactory;

#[contractimpl]
impl IsolatedLendingFactory {
    pub fn initialize(env: Env, admin: Address) {
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
        let available = total_supplied
            .checked_sub(total_debt)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        if available < amount {
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
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;

        let debt_key = PairDataKey::Debt(user.clone());
        let old_debt: i128 = env.storage().persistent().get(&debt_key).unwrap_or(0);
        if old_debt < amount {
            return Err(IsolatedLendingError::InvalidAmount);
        }

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

    fn require_init(env: &Env) -> Result<(), IsolatedLendingError> {
        if !env.storage().instance().has(&PairDataKey::Initialized) {
            return Err(IsolatedLendingError::NotInitialized);
        }
        Ok(())
    }
}
