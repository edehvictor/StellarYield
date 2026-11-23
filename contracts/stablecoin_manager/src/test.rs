use crate::StablecoinManager;
use crate::StablecoinManagerClient;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{contract, contractimpl, token, Address, Env};

// ── Mock Vault ─────────────────────────────────────────────────────────────
// Simulates YieldVault total_assets() / total_shares() used for CR calculation.
// 1:1 ratio means each vault share == 1 unit of underlying.

#[contract]
pub struct MockVault;

#[contractimpl]
impl MockVault {
    pub fn total_assets(_env: Env) -> i128 {
        10_000_000
    }
    pub fn total_shares(_env: Env) -> i128 {
        10_000_000
    }
}

// ── Mock Oracle ────────────────────────────────────────────────────────────
// Returns a fresh price of $0.10/unit (1_000_000 scaled by 1e7).
// Timestamp is always "now" so it's never stale.

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn get_price(env: Env, _asset: Address) -> Option<(i128, u64)> {
        Some((1_000_000, env.ledger().timestamp()))
    }
}

// ── Test Harness ───────────────────────────────────────────────────────────
//
// Key fix: we register StablecoinManager FIRST, then pass its address as the
// sUSD SAC admin. This gives the contract permission to call `mint` on sUSD.

fn setup_env() -> (
    Env,
    StablecoinManagerClient<'static>,
    Address, // admin
    Address, // s_usd_addr
    Address, // collateral_addr
    Address, // metrics_id (MockVault)
    Address, // oracle_id  (MockOracle)
) {
    let env = Env::default();
    env.mock_all_auths();

    // Register StablecoinManager FIRST so we have its address
    let contract_id = env.register(StablecoinManager, ());
    let client = StablecoinManagerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);

    // sUSD SAC — admin is the StablecoinManager contract so it can call `mint`
    let s_usd_contract = env.register_stellar_asset_contract_v2(contract_id.clone());
    let s_usd_addr = s_usd_contract.address();

    // Collateral SAC — separate token representing vault shares
    let collateral_admin = Address::generate(&env);
    let collateral_contract = env.register_stellar_asset_contract_v2(collateral_admin.clone());
    let collateral_addr = collateral_contract.address();

    // MockVault for total_assets / total_shares
    let metrics_id = env.register(MockVault, ());
    let oracle_id = env.register(MockOracle, ());

    client.initialize(
        &admin,
        &s_usd_addr,
        &collateral_addr,
        &metrics_id,
        &oracle_id,
        &15000,                      // 150 % Icr
        &11000,                      // 110 % Mcr
        &50_000_000_000_000_000i128, // 5 % APR (0.05 * 1e18)
    );

    (
        env,
        client,
        admin,
        s_usd_addr,
        collateral_addr,
        metrics_id,
        oracle_id,
    )
}

// ── Helper: mint collateral to a user ─────────────────────────────────────
fn give_collateral(env: &Env, collateral_addr: &Address, user: &Address, amount: i128) {
    token::StellarAssetClient::new(env, collateral_addr).mint(user, &amount);
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

/// Mint sUSD within allowed Icr — happy path
/// Collateral value = 100_000 * (10M/10M) * $0.1 = $10_000
/// Max debt at 150% Icr = $10_000 / 1.5 ≈ $6_666
#[test]
fn test_mint_s_usd_within_icr() {
    let (env, client, _, s_usd_addr, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    client.mint_s_usd(&user, &100_000, &5_000);

    assert_eq!(token::Client::new(&env, &s_usd_addr).balance(&user), 5_000);
}

/// Mint that would push CR below Icr must fail
#[test]
fn test_mint_s_usd_exceeding_icr_fails() {
    let (env, client, _, _, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);

    // $8_000 debt → CR ≈ 125 % < 150 % Icr — must be rejected
    let err = client.try_mint_s_usd(&user, &100_000, &8_000);
    assert!(err.is_err(), "expected InsufficientCollateral error");
}

/// Interest accrues over time — repay after 1 year should not panic
#[test]
fn test_accrue_interest_after_one_year() {
    let (env, client, _, _s_usd_addr, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    client.mint_s_usd(&user, &100_000, &1_000);

    // Advance ledger by 1 year
    env.ledger().set_timestamp(31_536_001);

    // Zero-repay call forces interest accrual
    client.repay_s_usd(&user, &0, &0);
}

/// Full repay releases collateral and closes the Cdp
#[test]
fn test_full_repay_closes_cdp() {
    let (env, client, _, s_usd_addr, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    client.mint_s_usd(&user, &100_000, &1_000);

    // Repay all debt and withdraw all collateral
    client.repay_s_usd(&user, &1_000, &100_000);

    // User should have no sUSD left and collateral returned
    let sac = token::Client::new(&env, &s_usd_addr);
    assert_eq!(sac.balance(&user), 0);

    let col = token::Client::new(&env, &collateral_addr);
    assert_eq!(col.balance(&user), 100_000);
}

/// Liquidation is rejected when CR is above Mcr
#[test]
fn test_liquidate_healthy_cdp_fails() {
    let (env, client, _, _, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);
    let liquidator = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    // ~163 % CR (well above 110 % Mcr)
    client.mint_s_usd(&user, &100_000, &6_100);

    let err = client.try_liquidate(&liquidator, &user);
    assert!(err.is_err(), "healthy positions must not be liquidatable");
}

/// Cannot open a Cdp if already initialized with same user and borrow more
/// without extra collateral
#[test]
fn test_incremental_debt_respects_icr() {
    let (env, client, _, _, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);

    // First borrow: $4_000 → safe
    client.mint_s_usd(&user, &100_000, &4_000);

    // Second borrow: another $4_000 → total $8_000, CR ≈ 125 % < 150 % → must fail
    let err = client.try_mint_s_usd(&user, &0, &4_000);
    assert!(err.is_err(), "second borrow should violate Icr");
}

#[test]
fn test_double_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(StablecoinManager, ());
    let client = StablecoinManagerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let s_usd_addr = env
        .register_stellar_asset_contract_v2(contract_id.clone())
        .address();
    let collateral_addr = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let metrics_id = env.register(MockVault, ());
    let oracle_id = env.register(MockOracle, ());

    client.initialize(
        &admin,
        &s_usd_addr,
        &collateral_addr,
        &metrics_id,
        &oracle_id,
        &15000,
        &11000,
        &50_000_000_000_000_000i128,
    );

    let result = client.try_initialize(
        &admin,
        &s_usd_addr,
        &collateral_addr,
        &metrics_id,
        &oracle_id,
        &15000,
        &11000,
        &50_000_000_000_000_000i128,
    );
    assert_eq!(result, Err(Ok(crate::Error::AlreadyInitialized)));
}

#[test]
fn test_storage_ttl_extension() {
    let (env, client, _, _, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    client.mint_s_usd(&user, &100_000, &5_000);

    // Call repay_s_usd to verify that read/write paths for CDP run successfully with TTL extension
    client.repay_s_usd(&user, &0, &0);
}

// ─────────────────────────────────────────────────────────────────────────
// Oracle clock policy: future-dated, current and stale observations
// ─────────────────────────────────────────────────────────────────────────
//
// Policy under test (see `clock.rs`): an observation is accepted when
//   ledger_time - MAX_PRICE_AGE_SECS <= observed_at <= ledger_time + MAX_PRICE_FUTURE_SKEW_SECS
// with both ends inclusive. Anything later is `PriceFromFuture`, anything older
// is `PriceStale`. A rejected call must leave every balance exactly as it was.

use crate::clock::{MAX_PRICE_AGE_SECS, MAX_PRICE_FUTURE_SKEW_SECS};
use crate::Error;

const NOW: u64 = 1_000_000;

/// Oracle whose observation time the test controls. The price is fixed at
/// $0.10 so only the timestamp varies between cases.
///
/// Lives in its own module: `#[contractimpl]` derives module-level names from
/// function names, so two mock oracles that both define `get_price` cannot
/// share a module with `MockOracle`.
mod clock_oracle {
    use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};

    #[contract]
    pub struct ClockOracle;

    #[contractimpl]
    impl ClockOracle {
        pub fn set_observed_at(env: Env, observed_at: u64) {
            env.storage()
                .instance()
                .set(&symbol_short!("obs"), &observed_at);
        }

        pub fn get_price(env: Env, _asset: Address) -> Option<(i128, u64)> {
            let observed_at: u64 = env
                .storage()
                .instance()
                .get(&symbol_short!("obs"))
                .unwrap_or(env.ledger().timestamp());
            Some((1_000_000, observed_at))
        }
    }
}
use clock_oracle::{ClockOracle, ClockOracleClient};

struct ClockEnv {
    env: Env,
    client: StablecoinManagerClient<'static>,
    s_usd: Address,
    collateral: Address,
    oracle: ClockOracleClient<'static>,
}

fn setup_clock_env() -> ClockEnv {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = NOW);

    let contract_id = env.register(StablecoinManager, ());
    let client = StablecoinManagerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let s_usd = env
        .register_stellar_asset_contract_v2(contract_id.clone())
        .address();
    let collateral = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let metrics_id = env.register(MockVault, ());
    let oracle_id = env.register(ClockOracle, ());
    let oracle = ClockOracleClient::new(&env, &oracle_id);

    client.initialize(
        &admin,
        &s_usd,
        &collateral,
        &metrics_id,
        &oracle_id,
        &15000,
        &11000,
        &50_000_000_000_000_000i128,
    );

    ClockEnv {
        env,
        client,
        s_usd,
        collateral,
        oracle,
    }
}

/// Every balance a failed operation must leave untouched.
#[derive(Debug, PartialEq, Eq)]
struct Balances {
    user_collateral: i128,
    user_s_usd: i128,
    contract_collateral: i128,
}

fn balances(t: &ClockEnv, user: &Address) -> Balances {
    Balances {
        user_collateral: token::Client::new(&t.env, &t.collateral).balance(user),
        user_s_usd: token::Client::new(&t.env, &t.s_usd).balance(user),
        contract_collateral: token::Client::new(&t.env, &t.collateral).balance(&t.client.address),
    }
}

/// A user holding 100_000 collateral and no position yet.
fn funded_user(t: &ClockEnv) -> Address {
    let user = Address::generate(&t.env);
    give_collateral(&t.env, &t.collateral, &user, 100_000);
    user
}

#[test]
fn clock_policy_constants_are_the_documented_values() {
    // Documented in docs/contracts/stablecoin-manager-price-clock.md. Changing
    // either one is a behaviour change and must update that document.
    assert_eq!(MAX_PRICE_AGE_SECS, 3600);
    assert_eq!(MAX_PRICE_FUTURE_SKEW_SECS, 0);
}

#[test]
fn observation_at_ledger_time_is_accepted() {
    let t = setup_clock_env();
    let user = funded_user(&t);
    t.oracle.set_observed_at(&NOW);

    t.client.mint_s_usd(&user, &100_000, &5_000);

    assert_eq!(balances(&t, &user).user_s_usd, 5_000);
}

#[test]
fn observation_one_second_in_the_future_is_rejected() {
    let t = setup_clock_env();
    let user = funded_user(&t);
    t.oracle
        .set_observed_at(&(NOW + MAX_PRICE_FUTURE_SKEW_SECS + 1));
    let before = balances(&t, &user);

    let result = t.client.try_mint_s_usd(&user, &100_000, &5_000);

    assert_eq!(result, Err(Ok(Error::PriceFromFuture)));
    assert_eq!(
        balances(&t, &user),
        before,
        "failed mint must not move funds"
    );
}

#[test]
fn observation_far_in_the_future_is_rejected() {
    let t = setup_clock_env();
    let user = funded_user(&t);
    let before = balances(&t, &user);

    // One day ahead, and u64::MAX: the old `timestamp + 3600` overflowed on the latter.
    for observed_at in [NOW + 86_400, u64::MAX] {
        t.oracle.set_observed_at(&observed_at);
        let result = t.client.try_mint_s_usd(&user, &100_000, &5_000);
        assert_eq!(
            result,
            Err(Ok(Error::PriceFromFuture)),
            "observed_at={observed_at}"
        );
    }
    assert_eq!(balances(&t, &user), before);
}

#[test]
fn observation_exactly_at_max_age_is_accepted() {
    let t = setup_clock_env();
    let user = funded_user(&t);
    t.oracle.set_observed_at(&(NOW - MAX_PRICE_AGE_SECS));

    t.client.mint_s_usd(&user, &100_000, &5_000);

    assert_eq!(balances(&t, &user).user_s_usd, 5_000);
}

#[test]
fn observation_one_second_past_max_age_is_stale() {
    let t = setup_clock_env();
    let user = funded_user(&t);
    t.oracle.set_observed_at(&(NOW - MAX_PRICE_AGE_SECS - 1));
    let before = balances(&t, &user);

    let result = t.client.try_mint_s_usd(&user, &100_000, &5_000);

    assert_eq!(result, Err(Ok(Error::PriceStale)));
    assert_eq!(
        balances(&t, &user),
        before,
        "failed mint must not move funds"
    );
}

#[test]
fn rejected_future_price_leaves_an_existing_position_intact() {
    let t = setup_clock_env();
    let user = funded_user(&t);
    t.oracle.set_observed_at(&NOW);
    t.client.mint_s_usd(&user, &50_000, &2_000);
    let before = balances(&t, &user);

    t.oracle.set_observed_at(&(NOW + 1));
    let result = t.client.try_mint_s_usd(&user, &50_000, &2_000);

    assert_eq!(result, Err(Ok(Error::PriceFromFuture)));
    assert_eq!(balances(&t, &user), before);

    // The position is untouched: with a valid quote the same call succeeds and
    // the totals are exactly "first mint + second mint", nothing lost or doubled.
    t.oracle.set_observed_at(&NOW);
    t.client.mint_s_usd(&user, &50_000, &2_000);
    let after = balances(&t, &user);
    assert_eq!(after.user_s_usd, 4_000);
    assert_eq!(after.contract_collateral, 100_000);
}

#[test]
fn collateral_withdrawal_is_rejected_on_a_future_price_and_changes_nothing() {
    let t = setup_clock_env();
    let user = funded_user(&t);
    t.oracle.set_observed_at(&NOW);
    t.client.mint_s_usd(&user, &100_000, &5_000);
    let before = balances(&t, &user);

    t.oracle.set_observed_at(&(NOW + 1));
    let result = t.client.try_repay_s_usd(&user, &0, &1_000);

    assert_eq!(result, Err(Ok(Error::PriceFromFuture)));
    assert_eq!(balances(&t, &user), before);
}

#[test]
fn liquidation_is_rejected_on_a_future_price_and_the_cdp_survives() {
    let t = setup_clock_env();
    let user = funded_user(&t);
    let liquidator = Address::generate(&t.env);
    t.oracle.set_observed_at(&NOW);
    t.client.mint_s_usd(&user, &100_000, &5_000);
    let before = balances(&t, &user);

    t.oracle.set_observed_at(&(NOW + 1));
    let result = t.client.try_liquidate(&liquidator, &user);

    assert_eq!(result, Err(Ok(Error::PriceFromFuture)));
    assert_eq!(balances(&t, &user), before);

    // The CDP still exists: with a valid quote the call reaches the health
    // check (healthy position -> Unauthorized) instead of NoCdpFound.
    t.oracle.set_observed_at(&NOW);
    assert_eq!(
        t.client.try_liquidate(&liquidator, &user),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn future_price_error_code_is_stable() {
    // Integrators match on the numeric code; see ERROR_CODES.md.
    assert_eq!(Error::PriceStale as u32, 9);
    assert_eq!(Error::PriceFromFuture as u32, 10);
}
