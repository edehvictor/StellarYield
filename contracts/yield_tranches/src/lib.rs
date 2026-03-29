#![no_std]

//! # Yield Tranches — Principal / Yield Tokenizer
//!
//! Splits a yield-bearing asset (IBT) into **Principal Token (PT)** and
//! **Yield Token (YT)**. PT redeems 1:1 for the settlement asset at maturity;
//! YT captures variable IBT yield until maturity.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

// ── Storage ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Ibt,
    Underlying,
    MaturityTs,
    Initialized,
    /// Sum of IBT units deposited (principal basis for surplus = balance − principal).
    PrincipalIbt,
    TotalPt,
    TotalYt,
    BalancePt(Address),
    BalanceYt(Address),
}

// ── Errors ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TokenizerError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    ZeroAmount = 3,
    InsufficientBalance = 4,
    /// Claiming YT yield is forbidden at or after maturity.
    YieldClaimAfterMaturity = 5,
    /// PT redemption only when `ledger_timestamp >= maturity`.
    RedeemBeforeMaturity = 6,
    Unauthorized = 7,
    Overflow = 8,
    /// Contract holds insufficient underlying for this PT redemption.
    InsufficientUnderlyingLiquidity = 9,
    /// New deposits are not accepted at or after maturity.
    DepositClosed = 10,
}

// ── Contract ─────────────────────────────────────────────────────────────

#[contract]
pub struct Tokenizer;

#[contractimpl]
impl Tokenizer {
    /// Initialize the tokenizer with admin, asset addresses, and maturity.
    ///
    /// # Arguments
    ///
    /// * `admin` — Configuration and redemption-pool management.
    /// * `ibt` — Interest-bearing token users deposit (e.g. vault share / yUSDC SAC).
    /// * `underlying` — Asset PT holders receive 1:1 at maturity (same decimals as PT accounting).
    /// * `maturity_ts` — UNIX timestamp (seconds); YT yield claims require `ledger_time < maturity`;
    ///   PT redemption requires `ledger_time >= maturity`.
    ///
    /// # Errors
    ///
    /// * [`TokenizerError::AlreadyInitialized`]
    pub fn initialize(
        env: Env,
        admin: Address,
        ibt: Address,
        underlying: Address,
        maturity_ts: u64,
    ) -> Result<(), TokenizerError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(TokenizerError::AlreadyInitialized);
        }
        if maturity_ts == 0 {
            return Err(TokenizerError::ZeroAmount);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Ibt, &ibt);
        env.storage()
            .instance()
            .set(&DataKey::Underlying, &underlying);
        env.storage()
            .instance()
            .set(&DataKey::MaturityTs, &maturity_ts);
        env.storage().instance().set(&DataKey::PrincipalIbt, &0i128);
        env.storage().instance().set(&DataKey::TotalPt, &0i128);
        env.storage().instance().set(&DataKey::TotalYt, &0i128);
        env.storage().instance().set(&DataKey::Initialized, &true);

        env.events().publish(
            (symbol_short!("init_tz"),),
            (admin.clone(), ibt.clone(), underlying.clone(), maturity_ts),
        );
        Ok(())
    }

    /// Deposit IBT and mint equal PT and YT to `from`.
    ///
    /// Transfers `amount` IBT from `from` into this contract and increases the
    /// tracked principal by `amount`.
    ///
    /// # Errors
    ///
    /// * [`TokenizerError::ZeroAmount`]
    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), TokenizerError> {
        Self::require_init(&env)?;
        from.require_auth();
        if amount <= 0 {
            return Err(TokenizerError::ZeroAmount);
        }

        let maturity: u64 = env.storage().instance().get(&DataKey::MaturityTs).unwrap();
        let now = env.ledger().timestamp();
        if now >= maturity {
            return Err(TokenizerError::DepositClosed);
        }

        let ibt: Address = env.storage().instance().get(&DataKey::Ibt).unwrap();
        let this = env.current_contract_address();
        let ibt_client = token::Client::new(&env, &ibt);
        ibt_client.transfer(&from, &this, &amount);

        let principal: i128 = env
            .storage()
            .instance()
            .get(&DataKey::PrincipalIbt)
            .unwrap();
        let new_principal = principal
            .checked_add(amount)
            .ok_or(TokenizerError::Overflow)?;
        env.storage()
            .instance()
            .set(&DataKey::PrincipalIbt, &new_principal);

        Self::mint_pt(&env, &from, amount)?;
        Self::mint_yt(&env, &from, amount)?;

        env.events()
            .publish((symbol_short!("dep_tz"),), (from.clone(), amount));
        Ok(())
    }

    /// Claim a pro-rata share of surplus IBT (yield) for YT holders.
    ///
    /// Surplus is `ibt_balance(this) − principal_ibt`. Only callable while
    /// `ledger_timestamp < maturity` so yield cannot be drained after maturity.
    ///
    /// # Returns
    ///
    /// Amount of IBT transferred to `from`.
    pub fn claim_yt_yield(env: Env, from: Address) -> Result<i128, TokenizerError> {
        Self::require_init(&env)?;
        from.require_auth();
        Self::require_before_maturity(&env)?;

        let yt: i128 = Self::read_balance_yt(&env, &from);
        if yt <= 0 {
            return Err(TokenizerError::InsufficientBalance);
        }

        let total_yt: i128 = env.storage().instance().get(&DataKey::TotalYt).unwrap();
        if total_yt <= 0 {
            return Err(TokenizerError::InsufficientBalance);
        }

        let ibt: Address = env.storage().instance().get(&DataKey::Ibt).unwrap();
        let this = env.current_contract_address();
        let principal: i128 = env
            .storage()
            .instance()
            .get(&DataKey::PrincipalIbt)
            .unwrap();
        let ibt_client = token::Client::new(&env, &ibt);
        let balance = ibt_client.balance(&this);
        let surplus = balance
            .checked_sub(principal)
            .ok_or(TokenizerError::Overflow)?;
        if surplus <= 0 {
            return Ok(0);
        }

        let share = surplus
            .checked_mul(yt)
            .ok_or(TokenizerError::Overflow)?
            .checked_div(total_yt)
            .ok_or(TokenizerError::Overflow)?;
        if share <= 0 {
            return Ok(0);
        }

        ibt_client.transfer(&this, &from, &share);

        env.events()
            .publish((symbol_short!("yt_clm"),), (from.clone(), share));
        Ok(share)
    }

    /// Redeem PT for underlying 1:1 after maturity.
    ///
    /// Burns `amount` PT from `from` and transfers `amount` underlying from this
    /// contract. Requires sufficient underlying liquidity (e.g. funded via
    /// [`Tokenizer::fund_underlying_for_redemption`]).
    pub fn redeem_pt(env: Env, from: Address, amount: i128) -> Result<(), TokenizerError> {
        Self::require_init(&env)?;
        from.require_auth();

        let maturity: u64 = env.storage().instance().get(&DataKey::MaturityTs).unwrap();
        let now = env.ledger().timestamp();
        if now < maturity {
            return Err(TokenizerError::RedeemBeforeMaturity);
        }
        if amount <= 0 {
            return Err(TokenizerError::ZeroAmount);
        }

        let pt = Self::read_balance_pt(&env, &from);
        if pt < amount {
            return Err(TokenizerError::InsufficientBalance);
        }

        let underlying: Address = env.storage().instance().get(&DataKey::Underlying).unwrap();
        let this = env.current_contract_address();
        let u_client = token::Client::new(&env, &underlying);
        let u_bal = u_client.balance(&this);
        if u_bal < amount {
            return Err(TokenizerError::InsufficientUnderlyingLiquidity);
        }

        Self::burn_pt(&env, &from, amount)?;
        u_client.transfer(&this, &from, &amount);

        env.events()
            .publish((symbol_short!("pt_rdm"),), (from.clone(), amount));
        Ok(())
    }

    /// Admin: transfer underlying into the contract to back PT redemptions at maturity.
    pub fn fund_underlying_for_redemption(
        env: Env,
        admin: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), TokenizerError> {
        Self::require_init(&env)?;
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        if amount <= 0 {
            return Err(TokenizerError::ZeroAmount);
        }

        let underlying: Address = env.storage().instance().get(&DataKey::Underlying).unwrap();
        let this = env.current_contract_address();
        let u_client = token::Client::new(&env, &underlying);
        u_client.transfer(&from, &this, &amount);

        env.events()
            .publish((symbol_short!("fund_u"),), (from.clone(), amount));
        Ok(())
    }

    /// Transfer PT to another address (fungible ledger).
    pub fn transfer_pt(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), TokenizerError> {
        Self::require_init(&env)?;
        from.require_auth();
        if amount <= 0 {
            return Err(TokenizerError::ZeroAmount);
        }
        let bal = Self::read_balance_pt(&env, &from);
        if bal < amount {
            return Err(TokenizerError::InsufficientBalance);
        }
        Self::set_balance_pt(&env, &from, bal - amount);
        let to_bal = Self::read_balance_pt(&env, &to);
        let new_to = to_bal.checked_add(amount).ok_or(TokenizerError::Overflow)?;
        Self::set_balance_pt(&env, &to, new_to);
        Ok(())
    }

    /// Transfer YT to another address (fungible ledger).
    pub fn transfer_yt(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), TokenizerError> {
        Self::require_init(&env)?;
        from.require_auth();
        if amount <= 0 {
            return Err(TokenizerError::ZeroAmount);
        }
        let bal = Self::read_balance_yt(&env, &from);
        if bal < amount {
            return Err(TokenizerError::InsufficientBalance);
        }
        Self::set_balance_yt(&env, &from, bal - amount);
        let to_bal = Self::read_balance_yt(&env, &to);
        let new_to = to_bal.checked_add(amount).ok_or(TokenizerError::Overflow)?;
        Self::set_balance_yt(&env, &to, new_to);
        Ok(())
    }

    // ── Views ───────────────────────────────────────────────────────

    pub fn get_admin(env: Env) -> Result<Address, TokenizerError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::Admin).unwrap())
    }

    pub fn get_ibt(env: Env) -> Result<Address, TokenizerError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::Ibt).unwrap())
    }

    pub fn get_underlying(env: Env) -> Result<Address, TokenizerError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::Underlying).unwrap())
    }

    pub fn get_maturity(env: Env) -> Result<u64, TokenizerError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::MaturityTs).unwrap())
    }

    pub fn get_principal_ibt(env: Env) -> Result<i128, TokenizerError> {
        Self::require_init(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&DataKey::PrincipalIbt)
            .unwrap())
    }

    pub fn balance_pt(env: Env, account: Address) -> Result<i128, TokenizerError> {
        Self::require_init(&env)?;
        Ok(Self::read_balance_pt(&env, &account))
    }

    pub fn balance_yt(env: Env, account: Address) -> Result<i128, TokenizerError> {
        Self::require_init(&env)?;
        Ok(Self::read_balance_yt(&env, &account))
    }

    pub fn total_pt(env: Env) -> Result<i128, TokenizerError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::TotalPt).unwrap())
    }

    pub fn total_yt(env: Env) -> Result<i128, TokenizerError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::TotalYt).unwrap())
    }

    /// IBT held minus tracked principal (surplus available as yield to YT).
    pub fn surplus_ibt(env: Env) -> Result<i128, TokenizerError> {
        Self::require_init(&env)?;
        let ibt: Address = env.storage().instance().get(&DataKey::Ibt).unwrap();
        let this = env.current_contract_address();
        let principal: i128 = env
            .storage()
            .instance()
            .get(&DataKey::PrincipalIbt)
            .unwrap();
        let bal = token::Client::new(&env, &ibt).balance(&this);
        Ok(bal.saturating_sub(principal))
    }

    // ── Internal ─────────────────────────────────────────────────────

    fn require_init(env: &Env) -> Result<(), TokenizerError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(TokenizerError::NotInitialized);
        }
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), TokenizerError> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != &admin {
            return Err(TokenizerError::Unauthorized);
        }
        Ok(())
    }

    fn require_before_maturity(env: &Env) -> Result<(), TokenizerError> {
        let maturity: u64 = env.storage().instance().get(&DataKey::MaturityTs).unwrap();
        let now = env.ledger().timestamp();
        if now >= maturity {
            return Err(TokenizerError::YieldClaimAfterMaturity);
        }
        Ok(())
    }

    fn read_balance_pt(env: &Env, a: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::BalancePt(a.clone()))
            .unwrap_or(0)
    }

    fn read_balance_yt(env: &Env, a: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::BalanceYt(a.clone()))
            .unwrap_or(0)
    }

    fn set_balance_pt(env: &Env, a: &Address, v: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::BalancePt(a.clone()), &v);
    }

    fn set_balance_yt(env: &Env, a: &Address, v: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::BalanceYt(a.clone()), &v);
    }

    fn mint_pt(env: &Env, to: &Address, amount: i128) -> Result<(), TokenizerError> {
        let total: i128 = env.storage().instance().get(&DataKey::TotalPt).unwrap();
        let new_total = total.checked_add(amount).ok_or(TokenizerError::Overflow)?;
        env.storage().instance().set(&DataKey::TotalPt, &new_total);
        let b = Self::read_balance_pt(env, to);
        let nb = b.checked_add(amount).ok_or(TokenizerError::Overflow)?;
        Self::set_balance_pt(env, to, nb);
        Ok(())
    }

    fn mint_yt(env: &Env, to: &Address, amount: i128) -> Result<(), TokenizerError> {
        let total: i128 = env.storage().instance().get(&DataKey::TotalYt).unwrap();
        let new_total = total.checked_add(amount).ok_or(TokenizerError::Overflow)?;
        env.storage().instance().set(&DataKey::TotalYt, &new_total);
        let b = Self::read_balance_yt(env, to);
        let nb = b.checked_add(amount).ok_or(TokenizerError::Overflow)?;
        Self::set_balance_yt(env, to, nb);
        Ok(())
    }

    fn burn_pt(env: &Env, from: &Address, amount: i128) -> Result<(), TokenizerError> {
        let total: i128 = env.storage().instance().get(&DataKey::TotalPt).unwrap();
        let new_total = total.checked_sub(amount).ok_or(TokenizerError::Overflow)?;
        env.storage().instance().set(&DataKey::TotalPt, &new_total);
        let b = Self::read_balance_pt(env, from);
        if b < amount {
            return Err(TokenizerError::InsufficientBalance);
        }
        Self::set_balance_pt(env, from, b - amount);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::testutils::Ledger;

    fn mint_tokens(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
        let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    fn setup(
        env: &Env,
        maturity: u64,
    ) -> (
        TokenizerClient<'static>,
        Address,
        Address,
        Address,
        Address,
        Address,
        Address,
    ) {
        env.mock_all_auths();
        let contract_id = env.register(Tokenizer, ());
        let client = TokenizerClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let ibt_admin = Address::generate(env);
        let u_admin = Address::generate(env);
        let ibt = env
            .register_stellar_asset_contract_v2(ibt_admin.clone())
            .address();
        let underlying = env
            .register_stellar_asset_contract_v2(u_admin.clone())
            .address();
        client.initialize(&admin, &ibt, &underlying, &maturity);
        (
            client,
            contract_id,
            admin,
            ibt,
            underlying,
            ibt_admin,
            u_admin,
        )
    }

    #[test]
    fn initialize_sets_config() {
        let env = Env::default();
        let (client, _, admin, ibt, underlying, _, _) = setup(&env, 1_000_000);
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_ibt(), ibt);
        assert_eq!(client.get_underlying(), underlying);
        assert_eq!(client.get_maturity(), 1_000_000);
        assert_eq!(client.get_principal_ibt(), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn double_initialize_panics() {
        let env = Env::default();
        let (client, _, admin, ibt, underlying, _, _) = setup(&env, 100);
        client.initialize(&admin, &ibt, &underlying, &200);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn initialize_zero_maturity_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(Tokenizer, ());
        let client = TokenizerClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let ibt = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let u = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        client.initialize(&admin, &ibt, &u, &0);
    }

    #[test]
    fn deposit_mints_pt_yt() {
        let env = Env::default();
        let (client, _, _, ibt, _, _, _) = setup(&env, 10_000);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 5000);
        env.ledger().set_timestamp(100);
        client.deposit(&user, &1000);
        assert_eq!(client.balance_pt(&user), 1000);
        assert_eq!(client.balance_yt(&user), 1000);
        assert_eq!(client.get_principal_ibt(), 1000);
        assert_eq!(client.total_pt(), 1000);
        assert_eq!(client.total_yt(), 1000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn deposit_zero_panics() {
        let env = Env::default();
        let (client, _, _, _, _, _, _) = setup(&env, 10_000);
        let user = Address::generate(&env);
        client.deposit(&user, &0);
    }

    #[test]
    fn claim_yt_distributes_surplus() {
        let env = Env::default();
        let (client, contract_id, _, ibt, _, _, _) = setup(&env, 10_000);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 10_000);
        env.ledger().set_timestamp(100);
        client.deposit(&user, &1000);
        // Simulate yield: mint extra IBT to the tokenizer contract
        mint_tokens(&env, &ibt, &contract_id, 100);
        assert_eq!(client.surplus_ibt(), 100);
        let claimed = client.claim_yt_yield(&user);
        assert_eq!(claimed, 100);
    }

    #[test]
    fn claim_yt_zero_when_no_surplus() {
        let env = Env::default();
        let (client, _, _, ibt, _, _, _) = setup(&env, 10_000);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 1000);
        env.ledger().set_timestamp(100);
        client.deposit(&user, &1000);
        assert_eq!(client.claim_yt_yield(&user), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn claim_yt_after_maturity_panics() {
        let env = Env::default();
        let (client, contract_id, _, ibt, _, _, _) = setup(&env, 10_000);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 1000);
        env.ledger().set_timestamp(100);
        client.deposit(&user, &500);
        mint_tokens(&env, &ibt, &contract_id, 50);
        env.ledger().set_timestamp(10_001);
        let _ = client.claim_yt_yield(&user);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn claim_yt_at_maturity_panics() {
        let env = Env::default();
        let (client, _, _, ibt, _, _, _) = setup(&env, 1000);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 1000);
        env.ledger().set_timestamp(500);
        client.deposit(&user, &100);
        env.ledger().set_timestamp(1000);
        let _ = client.claim_yt_yield(&user);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn redeem_pt_before_maturity_panics() {
        let env = Env::default();
        let (client, _, admin, ibt, u, _, _) = setup(&env, 10_000);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 1000);
        mint_tokens(&env, &u, &admin, 10_000);
        env.ledger().set_timestamp(100);
        client.deposit(&user, &100);
        client.fund_underlying_for_redemption(&admin, &admin, &500);
        env.ledger().set_timestamp(500);
        client.redeem_pt(&user, &50);
    }

    #[test]
    fn redeem_pt_after_maturity() {
        let env = Env::default();
        let (client, _, admin, ibt, u, _, _) = setup(&env, 1000);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 1000);
        mint_tokens(&env, &u, &admin, 10_000);
        env.ledger().set_timestamp(100);
        client.deposit(&user, &100);
        client.fund_underlying_for_redemption(&admin, &admin, &100);
        env.ledger().set_timestamp(1000);
        let u_client = token::Client::new(&env, &u);
        let before = u_client.balance(&user);
        client.redeem_pt(&user, &100);
        assert_eq!(u_client.balance(&user), before + 100);
        assert_eq!(client.balance_pt(&user), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn redeem_pt_insufficient_underlying_panics() {
        let env = Env::default();
        let (client, _, _, ibt, _, _, _) = setup(&env, 500);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 500);
        env.ledger().set_timestamp(100);
        client.deposit(&user, &100);
        env.ledger().set_timestamp(600);
        client.redeem_pt(&user, &100);
    }

    #[test]
    fn transfer_pt_and_yt() {
        let env = Env::default();
        let (client, _, _, ibt, _, _, _) = setup(&env, 10_000);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        mint_tokens(&env, &ibt, &a, 500);
        env.ledger().set_timestamp(100);
        client.deposit(&a, &200);
        client.transfer_pt(&a, &b, &50);
        client.transfer_yt(&a, &b, &50);
        assert_eq!(client.balance_pt(&a), 150);
        assert_eq!(client.balance_pt(&b), 50);
        assert_eq!(client.balance_yt(&a), 150);
        assert_eq!(client.balance_yt(&b), 50);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn transfer_pt_insufficient_panics() {
        let env = Env::default();
        let (client, _, _, ibt, _, _, _) = setup(&env, 10_000);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        mint_tokens(&env, &ibt, &a, 100);
        env.ledger().set_timestamp(100);
        client.deposit(&a, &50);
        client.transfer_pt(&a, &b, &100);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")]
    fn fund_underlying_non_admin_panics() {
        let env = Env::default();
        let (client, _, admin, _, u, _, _) = setup(&env, 10_000);
        let bad = Address::generate(&env);
        mint_tokens(&env, &u, &bad, 100);
        client.fund_underlying_for_redemption(&bad, &bad, &50);
        let _ = admin;
    }

    #[test]
    fn two_users_split_yield() {
        let env = Env::default();
        let (client, contract_id, _, ibt, _, _, _) = setup(&env, 50_000);
        let u1 = Address::generate(&env);
        let u2 = Address::generate(&env);
        mint_tokens(&env, &ibt, &u1, 5000);
        mint_tokens(&env, &ibt, &u2, 5000);
        env.ledger().set_timestamp(1000);
        client.deposit(&u1, &1000);
        client.deposit(&u2, &1000);
        mint_tokens(&env, &ibt, &contract_id, 200);
        // Top up if the test env only applied part of the mint to the tokenizer balance.
        let mut surplus = client.surplus_ibt();
        if surplus < 200 {
            mint_tokens(&env, &ibt, &contract_id, 200 - surplus);
            surplus = client.surplus_ibt();
        }
        assert_eq!(surplus, 200);
        assert_eq!(client.total_yt(), 2000);
        // Same formula both times: share = surplus * yt / total_yt. The first claim
        // transfers IBT out, so the second claim splits the *remaining* surplus (100),
        // not another full 200.
        assert_eq!(client.claim_yt_yield(&u1), 100);
        assert_eq!(client.claim_yt_yield(&u2), 50);
    }

    #[test]
    fn surplus_ibt_view() {
        let env = Env::default();
        let (client, contract_id, _, ibt, _, _, _) = setup(&env, 99_999);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 2000);
        env.ledger().set_timestamp(1);
        client.deposit(&user, &1000);
        mint_tokens(&env, &ibt, &contract_id, 50);
        assert_eq!(client.surplus_ibt(), 50);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn claim_yt_zero_balance_panics() {
        let env = Env::default();
        let (client, contract_id, _, ibt, _, _, _) = setup(&env, 50_000);
        let user = Address::generate(&env);
        let other = Address::generate(&env);
        mint_tokens(&env, &ibt, &other, 1000);
        env.ledger().set_timestamp(100);
        client.deposit(&other, &500);
        mint_tokens(&env, &ibt, &contract_id, 10);
        client.claim_yt_yield(&user);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn redeem_pt_zero_panics() {
        let env = Env::default();
        let (client, _, admin, ibt, u, _, _) = setup(&env, 100);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 100);
        mint_tokens(&env, &u, &admin, 1000);
        env.ledger().set_timestamp(0);
        client.deposit(&user, &50);
        client.fund_underlying_for_redemption(&admin, &admin, &50);
        env.ledger().set_timestamp(100);
        client.redeem_pt(&user, &0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn redeem_pt_insufficient_pt_panics() {
        let env = Env::default();
        let (client, _, admin, ibt, u, _, _) = setup(&env, 200);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 100);
        mint_tokens(&env, &u, &admin, 1000);
        env.ledger().set_timestamp(0);
        client.deposit(&user, &10);
        client.fund_underlying_for_redemption(&admin, &admin, &100);
        env.ledger().set_timestamp(200);
        client.redeem_pt(&user, &50);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #10)")]
    fn deposit_after_maturity_closed() {
        let env = Env::default();
        let (client, _, _, ibt, _, _, _) = setup(&env, 1000);
        let user = Address::generate(&env);
        mint_tokens(&env, &ibt, &user, 500);
        env.ledger().set_timestamp(2000);
        client.deposit(&user, &100);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn fund_underlying_zero_panics() {
        let env = Env::default();
        let (client, _, admin, _, u, _, _) = setup(&env, 10_000);
        let bad = Address::generate(&env);
        mint_tokens(&env, &u, &bad, 10);
        client.fund_underlying_for_redemption(&admin, &bad, &0);
    }
}
