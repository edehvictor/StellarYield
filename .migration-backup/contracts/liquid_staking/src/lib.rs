#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contractmeta, panic_with_error, symbol_short, Address,
    BytesN, Env, IntoVal, String as SorobanString, Symbol, Val, Vec,
};

// -----------------------------
// Metadata
// -----------------------------
contractmeta!(key = "name", val = "Liquid Staking Derivative - yXLM");
contractmeta!(key = "version", val = "0.1.0");
contractmeta!(
    key = "description",
    val = "Accepts native XLM deposits, delegates to validators, and mints yXLM."
);

// -----------------------------
// Errors
// -----------------------------
#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Error {
    NotAdmin = 1,
    NotInitialized = 2,
    AlreadyInitialized = 3,
    ValidatorNotWhitelisted = 4,
    AmountMustBePositive = 5,
    ZeroShares = 6,
    Unauthorized = 7,
}

// -----------------------------
// Storage Keys
// -----------------------------
const KEY_ADMIN: Symbol = symbol_short!("ADMIN");
const KEY_INIT: Symbol = symbol_short!("INIT");
const KEY_TOTAL_STAKED: Symbol = symbol_short!("TSTAKE");
const KEY_TOTAL_SHARES: Symbol = symbol_short!("TSHARE");
const KEY_VALIDATORS: Symbol = symbol_short!("VALS");
const KEY_MULTIPLIER_BPS: Symbol = symbol_short!("MBPS"); // 10_000 = 1.0x
const KEY_TOTAL_SUPPLY: Symbol = symbol_short!("TSUP");
const KEY_TOKEN_XLM: Symbol = symbol_short!("XLM");

fn key_balance(addr: &Address) -> (Symbol, Address) {
    (symbol_short!("BAL"), addr.clone())
}
fn key_allow(owner: &Address, spender: &Address) -> (Symbol, Address, Address) {
    (symbol_short!("ALLOW"), owner.clone(), spender.clone())
}

// -----------------------------
// Validator storage
// -----------------------------
const KEY_VAL_WEIGHT: Symbol = symbol_short!("VW"); // composite with id
fn key_val_weight(id: &BytesN<32>) -> (Symbol, BytesN<32>) {
    (KEY_VAL_WEIGHT, id.clone())
}

// -----------------------------
// Events
// -----------------------------
fn event_deposit(env: &Env, from: &Address, amount: i128, shares: i128) {
    env.events()
        .publish((symbol_short!("deposit"), from), (amount, shares));
}

fn event_withdraw(env: &Env, to: &Address, amount: i128, shares: i128) {
    env.events()
        .publish((symbol_short!("withdraw"), to), (amount, shares));
}

fn event_delegate(env: &Env, validator: &BytesN<32>, amount: i128) {
    env.events()
        .publish((symbol_short!("delegate"), validator), amount);
}

fn event_rebase(env: &Env, old_multiplier_bps: u32, new_multiplier_bps: u32) {
    env.events().publish(
        (symbol_short!("rebase"),),
        (old_multiplier_bps, new_multiplier_bps),
    );
}

// -----------------------------
// Helpers (storage)
// -----------------------------
fn read_initialized(env: &Env) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&KEY_INIT)
        .unwrap_or(false)
}
fn write_initialized(env: &Env, v: bool) {
    env.storage().instance().set(&KEY_INIT, &v);
}

fn read_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get::<_, Address>(&KEY_ADMIN)
        .expect("admin not set")
}
fn write_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&KEY_ADMIN, admin);
}

fn read_total_staked(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get::<_, i128>(&KEY_TOTAL_STAKED)
        .unwrap_or(0)
}
fn write_total_staked(env: &Env, v: i128) {
    env.storage().instance().set(&KEY_TOTAL_STAKED, &v);
}

fn read_total_shares(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get::<_, i128>(&KEY_TOTAL_SHARES)
        .unwrap_or(0)
}
fn write_total_shares(env: &Env, v: i128) {
    env.storage().instance().set(&KEY_TOTAL_SHARES, &v);
}
fn read_total_supply(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get::<_, i128>(&KEY_TOTAL_SUPPLY)
        .unwrap_or(0)
}
fn write_total_supply(env: &Env, v: i128) {
    env.storage().instance().set(&KEY_TOTAL_SUPPLY, &v);
}

fn read_multiplier_bps(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get::<_, u32>(&KEY_MULTIPLIER_BPS)
        .unwrap_or(10_000)
}
fn write_multiplier_bps(env: &Env, v: u32) {
    env.storage().instance().set(&KEY_MULTIPLIER_BPS, &v);
}

fn read_validators(env: &Env) -> Vec<BytesN<32>> {
    env.storage()
        .instance()
        .get::<_, Vec<BytesN<32>>>(&KEY_VALIDATORS)
        .unwrap_or(Vec::new(env))
}
fn write_validators(env: &Env, vals: &Vec<BytesN<32>>) {
    env.storage().instance().set(&KEY_VALIDATORS, vals);
}

fn ensure_admin(env: &Env, who: &Address) {
    let admin = read_admin(env);
    if &admin != who {
        panic_with_error!(env, Error::NotAdmin);
    }
}

fn ensure_initialized(env: &Env) {
    if !read_initialized(env) {
        panic_with_error!(env, Error::NotInitialized);
    }
}

fn read_token_xlm(env: &Env) -> Address {
    env.storage()
        .instance()
        .get::<_, Address>(&KEY_TOKEN_XLM)
        .expect("xlm token not set")
}
fn write_token_xlm(env: &Env, addr: &Address) {
    env.storage().instance().set(&KEY_TOKEN_XLM, addr);
}

// -----------------------------
// Minimal token client (transfer)
// -----------------------------
fn token_transfer_from(env: &Env, token: &Address, from: &Address, to: &Address, amount: i128) {
    // call token.transfer(from, to, amount)
    // standard Soroban token uses method name "transfer" with (from, to, amount)
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(from.clone().into_val(env));
    args.push_back(to.clone().into_val(env));
    args.push_back(amount.into_val(env));
    env.invoke_contract::<()>(token, &symbol_short!("transfer"), args);
}
fn token_transfer(env: &Env, token: &Address, to: &Address, amount: i128) {
    // transfer from contract (self) to `to`
    let from = env.current_contract_address();
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(from.into_val(env));
    args.push_back(to.clone().into_val(env));
    args.push_back(amount.into_val(env));
    env.invoke_contract::<()>(token, &symbol_short!("transfer"), args);
}
fn token_balance_of(env: &Env, token: &Address, owner: &Address) -> i128 {
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(owner.clone().into_val(env));
    env.invoke_contract::<i128>(token, &symbol_short!("balance"), args)
}

// -----------------------------
// Core math: shares and exchange rate
// -----------------------------
#[allow(dead_code)]
fn preview_mint_shares(env: &Env, deposit_amount: i128) -> i128 {
    let total_staked = read_total_staked(env);
    let total_shares = read_total_shares(env);
    if total_shares == 0 || total_staked == 0 {
        // First deposit: 1:1 shares minted, scaled by multiplier already 1.0x initially
        return deposit_amount;
    }
    // shares = deposit * total_shares / total_staked
    deposit_amount * total_shares / total_staked
}

#[allow(dead_code)]
fn preview_redeem_amount(env: &Env, share_amount: i128) -> i128 {
    let total_staked = read_total_staked(env);
    let total_shares = read_total_shares(env);
    if total_shares == 0 || total_staked == 0 {
        return 0;
    }
    // amount = shares * total_staked / total_shares
    share_amount * total_staked / total_shares
}

// -----------------------------
// Contract
// -----------------------------
#[contract]
pub struct LiquidStaking;

#[contractimpl]
impl LiquidStaking {
    /// Initialize the contract with an `admin` address and native XLM token contract address.
    ///
    /// Requirements:
    /// - Must be called exactly once.
    /// - Sets initial multiplier to 1.0x (10_000 bps).
    pub fn init(env: Env, admin: Address, xlm_token: Address) {
        if read_initialized(&env) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        admin.require_auth();
        write_admin(&env, &admin);
        write_token_xlm(&env, &xlm_token);
        write_multiplier_bps(&env, 10_000);
        write_total_supply(&env, 0);
        write_initialized(&env, true);
    }

    /// Add or update a validator in the whitelist with `weight_bps`.
    ///
    /// Access: admin-only.
    pub fn upsert_validator(env: Env, admin: Address, id: BytesN<32>, weight_bps: u32) {
        ensure_initialized(&env);
        ensure_admin(&env, &admin);
        admin.require_auth();

        let mut vals = read_validators(&env);
        let mut exists = false;
        for vid in vals.iter() {
            if vid == id {
                exists = true;
            }
        }
        if !exists {
            vals.push_back(id.clone());
            write_validators(&env, &vals);
        }
        env.storage()
            .instance()
            .set(&key_val_weight(&id), &weight_bps);
    }

    /// Remove a validator from the whitelist.
    ///
    /// Access: admin-only.
    pub fn remove_validator(env: Env, admin: Address, id: BytesN<32>) {
        ensure_initialized(&env);
        ensure_admin(&env, &admin);
        admin.require_auth();

        let vals = read_validators(&env);
        let mut next = Vec::new(&env);
        for v in vals.iter() {
            if v != id {
                next.push_back(v);
            }
        }
        write_validators(&env, &next);
        env.storage().instance().remove(&key_val_weight(&id));
    }

    /// Deposit native XLM and receive yXLM shares.
    ///
    /// Notes:
    /// - This function assumes the caller has already transferred native XLM
    ///   to this contract address via the Stellar Asset Contract prior to the call,
    ///   or this function will be extended in a follow-up to perform the
    ///   transfer-in through cross-contract invocation (SDK-guarded).
    /// - Mints shares based on current exchange rate.
    pub fn deposit(env: Env, from: Address, amount: i128) -> i128 {
        ensure_initialized(&env);
        if amount <= 0 {
            panic_with_error!(&env, Error::AmountMustBePositive);
        }
        from.require_auth();

        // Pull native XLM into the contract via token transfer
        let token = read_token_xlm(&env);
        let self_addr = env.current_contract_address();
        let pool_before = token_balance_of(&env, &token, &self_addr);
        token_transfer_from(&env, &token, &from, &self_addr, amount);

        // Compute shares to mint based on current exchange rate (total_staked/total_shares)
        // Use pool_before for stable pricing during the operation
        let total_shares = read_total_shares(&env);
        let shares = if total_shares == 0 || pool_before == 0 {
            amount
        } else {
            amount * total_shares / pool_before
        };
        if shares <= 0 {
            panic_with_error!(&env, Error::ZeroShares);
        }

        // Update totals; set total_staked to actual token balance post-transfer for 1:1 backing
        let pool_after = token_balance_of(&env, &token, &self_addr);
        write_total_staked(&env, pool_after);
        let new_total_shares = read_total_shares(&env) + shares;
        write_total_shares(&env, new_total_shares);
        let new_total_supply = read_total_supply(&env) + shares;
        write_total_supply(&env, new_total_supply);

        // Mint yXLM shares to depositor
        let mut bal = Self::balance(env.clone(), from.clone());
        bal += shares;
        env.storage().instance().set(&key_balance(&from), &bal);

        // Emit event and return shares to mint (mint mechanics will be wired)
        event_deposit(&env, &from, amount, shares);
        shares
    }

    /// Redeem `share_amount` yXLM shares for underlying XLM.
    ///
    /// Notes:
    /// - This function returns the amount of XLM to withdraw.
    /// - Transfer-out and share burn will be wired next.
    pub fn redeem(env: Env, to: Address, share_amount: i128) -> i128 {
        ensure_initialized(&env);
        if share_amount <= 0 {
            panic_with_error!(&env, Error::AmountMustBePositive);
        }
        to.require_auth();

        // Price using current pool and total_shares
        let token = read_token_xlm(&env);
        let self_addr = env.current_contract_address();
        let pool_before = token_balance_of(&env, &token, &self_addr);
        let total_shares = read_total_shares(&env);
        let amount = if total_shares == 0 || pool_before == 0 {
            0
        } else {
            share_amount * pool_before / total_shares
        };
        if amount <= 0 {
            panic_with_error!(&env, Error::ZeroShares);
        }

        // Burn shares from user
        let mut bal = Self::balance(env.clone(), to.clone());
        // naive check; underflow will panic anyway
        if bal < share_amount {
            panic_with_error!(&env, Error::Unauthorized);
        }
        bal -= share_amount;
        env.storage().instance().set(&key_balance(&to), &bal);
        let new_total_supply = read_total_supply(&env) - share_amount;
        write_total_supply(&env, new_total_supply);

        // Transfer out native XLM to user
        token_transfer(&env, &token, &to, amount);

        // Update totals; set total_staked to actual token balance post-transfer for 1:1 backing
        let pool_after = token_balance_of(&env, &token, &self_addr);
        write_total_staked(&env, pool_after);
        let new_total_shares = read_total_shares(&env) - share_amount;
        write_total_shares(&env, new_total_shares);

        event_withdraw(&env, &to, amount, share_amount);
        amount
    }

    /// Adjust the global share multiplier basis points (for accounting/events).
    ///
    /// Access: admin-only.
    /// Example: 10_000 -> 10_200 represents a +2% global reward signal (does not move funds).
    pub fn rebase(env: Env, admin: Address, new_multiplier_bps: u32) {
        ensure_initialized(&env);
        ensure_admin(&env, &admin);
        admin.require_auth();

        let old = read_multiplier_bps(&env);
        write_multiplier_bps(&env, new_multiplier_bps);
        event_rebase(&env, old, new_multiplier_bps);
    }

    /// Delegate stake to a whitelisted validator. Emits an event for off-chain indexing.
    ///
    /// Access: admin-only for now; can be extended to keeper roles.
    pub fn delegate(env: Env, admin: Address, validator_id: BytesN<32>, amount: i128) {
        ensure_initialized(&env);
        ensure_admin(&env, &admin);
        admin.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::AmountMustBePositive);
        }
        // Verify whitelist
        let vals = read_validators(&env);
        let mut ok = false;
        for v in vals.iter() {
            if v == validator_id {
                ok = true;
            }
        }
        if !ok {
            panic_with_error!(&env, Error::ValidatorNotWhitelisted);
        }
        // Event; wiring to actual staking mechanism would be added in a follow-up.
        event_delegate(&env, &validator_id, amount);
    }

    // -------- Views --------

    /// Returns (total_staked, total_shares, multiplier_bps).
    pub fn stats(env: Env) -> (i128, i128, u32) {
        (
            read_total_staked(&env),
            read_total_shares(&env),
            read_multiplier_bps(&env),
        )
    }

    /// Returns the validator whitelist.
    pub fn validators(env: Env) -> Vec<BytesN<32>> {
        read_validators(&env)
    }

    /// Sync `total_staked` to the actual token balance held by the contract (1:1 backing).
    ///
    /// Access: admin-only.
    pub fn sync(env: Env, admin: Address) {
        ensure_initialized(&env);
        ensure_admin(&env, &admin);
        admin.require_auth();
        let token = read_token_xlm(&env);
        let self_addr = env.current_contract_address();
        let bal = token_balance_of(&env, &token, &self_addr);
        write_total_staked(&env, bal);
    }

    /// Returns true if `total_staked` equals the token balance held by the contract.
    pub fn backing_ok(env: Env) -> bool {
        let token = read_token_xlm(&env);
        let self_addr = env.current_contract_address();
        let bal = token_balance_of(&env, &token, &self_addr);
        bal == read_total_staked(&env)
    }

    // -------- yXLM token interface (minimal ERC20-like) --------

    /// Name of the share token.
    pub fn name(env: Env) -> SorobanString {
        SorobanString::from_str(&env, "Yield XLM")
    }
    /// Symbol of the share token.
    pub fn symbol(env: Env) -> SorobanString {
        SorobanString::from_str(&env, "yXLM")
    }
    /// Decimals of the share token (matches XLM stroop precision).
    pub fn decimals(_env: Env) -> u32 {
        7
    }
    /// Total supply equals total shares.
    pub fn total_supply(env: Env) -> i128 {
        read_total_supply(&env)
    }
    /// Balance of an address.
    pub fn balance(env: Env, owner: Address) -> i128 {
        env.storage()
            .instance()
            .get::<_, i128>(&key_balance(&owner))
            .unwrap_or(0)
    }
    /// Allowance from `owner` to `spender`.
    pub fn allowance(env: Env, owner: Address, spender: Address) -> i128 {
        env.storage()
            .instance()
            .get::<_, i128>(&key_allow(&owner, &spender))
            .unwrap_or(0)
    }
    /// Approve `amount` for `spender`.
    pub fn approve(env: Env, owner: Address, spender: Address, amount: i128) {
        owner.require_auth();
        env.storage()
            .instance()
            .set(&key_allow(&owner, &spender), &amount);
    }
    /// Transfer `amount` from caller to `to`.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        Self::transfer_internal(&env, &from, &to, amount);
    }
    /// Transfer `amount` from `from` to `to` using allowance by `spender`.
    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        // Check allowance
        let mut allow = Self::allowance(env.clone(), from.clone(), spender.clone());
        if allow < amount {
            panic_with_error!(&env, Error::Unauthorized);
        }
        allow -= amount;
        env.storage()
            .instance()
            .set(&key_allow(&from, &spender), &allow);
        Self::transfer_internal(&env, &from, &to, amount);
    }

    fn transfer_internal(env: &Env, from: &Address, to: &Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(env, Error::AmountMustBePositive);
        }
        let mut fb = env
            .storage()
            .instance()
            .get::<_, i128>(&key_balance(from))
            .unwrap_or(0);
        if fb < amount {
            panic_with_error!(env, Error::Unauthorized);
        }
        let mut tb = env
            .storage()
            .instance()
            .get::<_, i128>(&key_balance(to))
            .unwrap_or(0);
        fb -= amount;
        tb += amount;
        env.storage().instance().set(&key_balance(from), &fb);
        env.storage().instance().set(&key_balance(to), &tb);
    }
}

// -----------------------------
// Tests (basic smoke; extended coverage will follow)
// -----------------------------
#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, BytesN as _};
    use soroban_sdk::{contract, contractimpl, Symbol};

    // Minimal mock token to simulate native XLM token contract
    #[contract]
    struct MockToken;
    const K_BAL: Symbol = symbol_short!("MBAL");
    fn k_user(addr: &Address) -> (Symbol, Address) {
        (K_BAL, addr.clone())
    }
    #[contractimpl]
    impl MockToken {
        pub fn mint(env: Env, to: Address, amount: i128) {
            let mut b = env
                .storage()
                .instance()
                .get::<_, i128>(&k_user(&to))
                .unwrap_or(0);
            b += amount;
            env.storage().instance().set(&k_user(&to), &b);
        }
        pub fn balance(env: Env, owner: Address) -> i128 {
            env.storage()
                .instance()
                .get::<_, i128>(&k_user(&owner))
                .unwrap_or(0)
        }
        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            let mut fb = env
                .storage()
                .instance()
                .get::<_, i128>(&k_user(&from))
                .unwrap_or(0);
            let mut tb = env
                .storage()
                .instance()
                .get::<_, i128>(&k_user(&to))
                .unwrap_or(0);
            assert!(amount > 0 && fb >= amount);
            fb -= amount;
            tb += amount;
            env.storage().instance().set(&k_user(&from), &fb);
            env.storage().instance().set(&k_user(&to), &tb);
        }
    }

    #[test]
    fn init_and_deposit() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        // Deploy mock XLM token
        let token_id = env.register(MockToken, ());
        let token = MockTokenClient::new(&env, &token_id);
        token.mint(&user, &10_000_000);

        let lsd_id = env.register(LiquidStaking, ());
        let client = LiquidStakingClient::new(&env, &lsd_id);

        client.init(&admin, &token.address);
        let (ts, sh, mbps) = client.stats();
        assert_eq!(ts, 0);
        assert_eq!(sh, 0);
        assert_eq!(mbps, 10_000);

        let minted = client.deposit(&user, &10_000_000); // 1 XLM = 10^7 stroops (example scale)
        assert_eq!(minted, 10_000_000);
        let (ts2, sh2, _) = client.stats();
        assert_eq!(ts2, 10_000_000);
        assert_eq!(sh2, 10_000_000);

        // Token balance moved from user to contract
        let lsd_addr = client.address.clone();
        assert_eq!(token.balance(&user), 0);
        assert_eq!(token.balance(&lsd_addr), 10_000_000);
    }

    #[test]
    fn rebase_and_redeem() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let token_id = env.register(MockToken, ());
        let token = MockTokenClient::new(&env, &token_id);
        token.mint(&user, &20_000_000);

        let lsd_id = env.register(LiquidStaking, ());
        let client = LiquidStakingClient::new(&env, &lsd_id);

        client.init(&admin, &token.address);
        client.deposit(&user, &20_000_000);
        let (_ts, sh, mbps) = client.stats();
        assert_eq!(sh, 20_000_000);
        assert_eq!(mbps, 10_000);

        // Simulate rewards arriving to the contract (e.g., from validators)
        let lsd_addr = client.address.clone();
        token.mint(&lsd_addr, &2_000_000); // +0.2 XLM
                                           // Update multiplier for accounting/event (does not change totals directly)
        client.rebase(&admin, &11_000);
        // Sync totals to actual token balance
        client.sync(&admin);
        let (ts2, sh2, mbps2) = client.stats();
        assert_eq!(mbps2, 11_000);
        assert_eq!(sh2, 20_000_000);
        assert_eq!(ts2, 22_000_000); // now equals on-chain balance

        // Redeem half of shares -> should withdraw 1.1 XLM (11_000_000)
        let out = client.redeem(&user, &10_000_000);
        assert_eq!(out, 11_000_000);
        // Token balance received
        assert_eq!(token.balance(&user), 11_000_000);
        assert_eq!(token.balance(&lsd_addr), 11_000_000);

        // Remaining stats
        let (ts3, sh3, _) = client.stats();
        assert_eq!(sh3, 10_000_000);
        assert_eq!(ts3, 11_000_000);
        assert!(client.backing_ok());
    }

    #[test]
    fn whitelist_and_delegate_events() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        let token_id = env.register(MockToken, ());
        let lsd_id = env.register(LiquidStaking, ());
        let client = LiquidStakingClient::new(&env, &lsd_id);
        let token_client = MockTokenClient::new(&env, &token_id);
        client.init(&admin, &token_client.address);

        let vid = BytesN::<32>::random(&env);
        client.upsert_validator(&admin, &vid, &5_000);
        let vals = client.validators();
        assert_eq!(vals.len(), 1);

        // Delegation emits event if validator exists
        client.delegate(&admin, &vid, &123);
    }
}
