#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, symbol_short, token, vec, Address, Env,
    Symbol, Val, IntoVal, Vec,
};

mod storage;
mod math;

#[cfg(test)]
mod test;

use storage::{DataKey, CDP, SCALAR_18, BPS_LIMIT};
use math::{calculate_index, calculate_debt, calculate_collateral_value, calculate_cr};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    ZeroAmount = 4,
    InsufficientCollateral = 5,
    PositionUnderMCR = 6,
    NoCDPFound = 7,
    InvalidRatio = 8,
    PriceStale = 9,
}

#[contract]
pub struct StablecoinManager;

#[contractimpl]
impl StablecoinManager {
    /// Initialize the StablecoinManager contract.
    ///
    /// # Arguments
    /// * `admin` - Contract administrator.
    /// * `s_usd` - Address of the sUSD token.
    /// * `collateral_token` - Address of the collateral token (e.g., XLM).
    /// * `vault_metrics` - Address of the VaultMetrics contract for price/TVL data.
    /// * `oracle` - Address of the price oracle.
    /// * `icr` - Initial Collateral Ratio (e.g., 15000 = 150%).
    /// * `mcr` - Minimum Collateral Ratio (e.g., 11000 = 110%).
    /// * `interest_rate` - Borrowing interest rate.
    pub fn initialize(
        env: Env,
        admin: Address,
        s_usd: Address,
        collateral_token: Address,
        vault_metrics: Address,
        oracle: Address,
        icr: u32,
        mcr: u32,
        interest_rate: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::AlreadyInitialized);
        }
        
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::SUSDToken, &s_usd);
        env.storage().instance().set(&DataKey::CollateralToken, &collateral_token);
        env.storage().instance().set(&DataKey::VaultMetrics, &vault_metrics);
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        env.storage().instance().set(&DataKey::ICR, &icr);
        env.storage().instance().set(&DataKey::MCR, &mcr);
        env.storage().instance().set(&DataKey::InterestRate, &interest_rate);
        
        env.storage().instance().set(&DataKey::CumulativeIndex, &SCALAR_18);
        env.storage().instance().set(&DataKey::LastUpdate, &env.ledger().timestamp());
        env.storage().instance().set(&DataKey::Initialized, &true);
        Ok(())
    }

    /// Mint sUSD by providing collateral.
    ///
    /// # Arguments
    /// * `from` - User address authorizing the mint.
    /// * `collateral_amount` - Amount of collateral to add to the CDP.
    /// * `mint_amount` - Amount of sUSD to mint.
    pub fn mint_s_usd(
        env: Env,
        from: Address,
        collateral_amount: i128,
        mint_amount: i128,
    ) -> Result<(), Error> {
        Self::require_init(&env)?;
        from.require_auth();

        Self::accrue_interest(&env)?;

        let mut cdp = env.storage().persistent().get(&DataKey::CDP(from.clone())).unwrap_or(CDP {
            collateral: 0,
            debt_shares: 0,
            last_index: SCALAR_18,
        });

        if collateral_amount > 0 {
            let collateral_token: Address = env.storage().instance().get(&DataKey::CollateralToken).unwrap();
            let token_client = token::Client::new(&env, &collateral_token);
            token_client.transfer(&from, &env.current_contract_address(), &collateral_amount);
            cdp.collateral += collateral_amount;
        }

        if mint_amount > 0 {
            let index: i128 = env.storage().instance().get(&DataKey::CumulativeIndex).unwrap();
            let new_debt_shares = (mint_amount * SCALAR_18) / index;
            cdp.debt_shares += new_debt_shares;

            let s_usd_addr: Address = env.storage().instance().get(&DataKey::SUSDToken).unwrap();
            let client = token::StellarAssetClient::new(&env, &s_usd_addr);
            client.mint(&from, &mint_amount);
        }

        Self::verify_cr(&env, &cdp, true)?;
        env.storage().persistent().set(&DataKey::CDP(from.clone()), &cdp);
        
        env.events().publish((symbol_short!("mint"), from), (collateral_amount, mint_amount));
        Ok(())
    }

    /// Repay sUSD debt and/or withdraw collateral.
    ///
    /// # Arguments
    /// * `from` - User address authorizing the repayment.
    /// * `repay_amount` - Amount of sUSD to repay/burn.
    /// * `withdraw_collateral` - Amount of collateral to withdraw.
    pub fn repay_s_usd(
        env: Env,
        from: Address,
        repay_amount: i128,
        withdraw_collateral: i128,
    ) -> Result<(), Error> {
        Self::require_init(&env)?;
        from.require_auth();
        Self::accrue_interest(&env)?;

        let mut cdp: CDP = env.storage().persistent().get(&DataKey::CDP(from.clone())).ok_or(Error::NoCDPFound)?;
        let index: i128 = env.storage().instance().get(&DataKey::CumulativeIndex).unwrap();

        if repay_amount > 0 {
            let s_usd_addr: Address = env.storage().instance().get(&DataKey::SUSDToken).unwrap();
            let client = token::Client::new(&env, &s_usd_addr);
            client.burn(&from, &repay_amount);

            let debt_repaid_shares = (repay_amount * SCALAR_18) / index;
            cdp.debt_shares = if debt_repaid_shares >= cdp.debt_shares { 0 } else { cdp.debt_shares - debt_repaid_shares };
        }

        if withdraw_collateral > 0 {
            if withdraw_collateral > cdp.collateral { return Err(Error::InsufficientCollateral); }
            cdp.collateral -= withdraw_collateral;
            if cdp.debt_shares > 0 { Self::verify_cr(&env, &cdp, true)?; }

            let collateral_token: Address = env.storage().instance().get(&DataKey::CollateralToken).unwrap();
            let client = token::Client::new(&env, &collateral_token);
            client.transfer(&env.current_contract_address(), &from, &withdraw_collateral);
        }

        if cdp.collateral == 0 && cdp.debt_shares == 0 {
            env.storage().persistent().remove(&DataKey::CDP(from.clone()));
        } else {
            env.storage().persistent().set(&DataKey::CDP(from.clone()), &cdp);
        }
        Ok(())
    }

    /// Liquidate an undercollateralized CDP.
    ///
    /// # Arguments
    /// * `liquidator` - Address executing the liquidation.
    /// * `user` - Address of the undercollateralized account to liquidate.
    pub fn liquidate(env: Env, liquidator: Address, user: Address) -> Result<(), Error> {
        Self::require_init(&env)?;
        liquidator.require_auth();
        Self::accrue_interest(&env)?;

        let cdp: CDP = env.storage().persistent().get(&DataKey::CDP(user.clone())).ok_or(Error::NoCDPFound)?;
        let cr = Self::get_user_cr(&env, &cdp)?;
        let mcr: u32 = env.storage().instance().get(&DataKey::MCR).unwrap();
        if cr >= mcr { return Err(Error::Unauthorized); }

        let index: i128 = env.storage().instance().get(&DataKey::CumulativeIndex).unwrap();
        let total_debt = calculate_debt(cdp.debt_shares, index);

        let s_usd_addr: Address = env.storage().instance().get(&DataKey::SUSDToken).unwrap();
        token::Client::new(&env, &s_usd_addr).burn(&liquidator, &total_debt);

        let collateral_token: Address = env.storage().instance().get(&DataKey::CollateralToken).unwrap();
        token::Client::new(&env, &collateral_token).transfer(&env.current_contract_address(), &liquidator, &cdp.collateral);

        env.storage().persistent().remove(&DataKey::CDP(user.clone()));
        Ok(())
    }

    fn require_init(env: &Env) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) { return Err(Error::NotInitialized); }
        Ok(())
    }

    fn accrue_interest(env: &Env) -> Result<(), Error> {
        let last_update: u64 = env.storage().instance().get(&DataKey::LastUpdate).unwrap();
        let now = env.ledger().timestamp();
        if now <= last_update { return Ok(()); }
        let index_last: i128 = env.storage().instance().get(&DataKey::CumulativeIndex).unwrap();
        let rate: i128 = env.storage().instance().get(&DataKey::InterestRate).unwrap();
        let index_next = calculate_index(index_last, rate, now - last_update);
        env.storage().instance().set(&DataKey::CumulativeIndex, &index_next);
        env.storage().instance().set(&DataKey::LastUpdate, &now);
        Ok(())
    }

    fn get_user_cr(env: &Env, cdp: &CDP) -> Result<u32, Error> {
        if cdp.debt_shares == 0 { return Ok(u32::MAX); }
        let (metrics_addr, oracle_addr): (Address, Address) = (env.storage().instance().get(&DataKey::VaultMetrics).unwrap(), env.storage().instance().get(&DataKey::Oracle).unwrap());
        
        let total_assets: i128 = env.invoke_contract(&metrics_addr, &Symbol::new(env, "total_assets"), Vec::new(env));
        let total_shares: i128 = env.invoke_contract(&metrics_addr, &Symbol::new(env, "total_shares"), Vec::new(env));
        
        let collateral_token_addr: Address = env.storage().instance().get(&DataKey::CollateralToken).unwrap();
        let oracle_args: soroban_sdk::Vec<Val> = vec![env, collateral_token_addr.into_val(env)];
        let price_data: Option<(i128, u64)> = env.invoke_contract(&oracle_addr, &Symbol::new(env, "get_price"), oracle_args);
        
        let (price, timestamp) = price_data.ok_or(Error::PriceStale)?;
        if env.ledger().timestamp() > timestamp + 3600 { return Err(Error::PriceStale); }

        let collateral_val = calculate_collateral_value(cdp.collateral, total_assets, total_shares, price);
        let index: i128 = env.storage().instance().get(&DataKey::CumulativeIndex).unwrap();
        Ok(calculate_cr(collateral_val, calculate_debt(cdp.debt_shares, index)))
    }

    fn verify_cr(env: &Env, cdp: &CDP, use_icr: bool) -> Result<(), Error> {
        if cdp.debt_shares == 0 { return Ok(()); }
        let cr = Self::get_user_cr(env, cdp)?;
        let limit: u32 = if use_icr { env.storage().instance().get(&DataKey::ICR).unwrap() } else { env.storage().instance().get(&DataKey::MCR).unwrap() };
        if cr < limit { return Err(Error::InsufficientCollateral); }
        Ok(())
    }
}
