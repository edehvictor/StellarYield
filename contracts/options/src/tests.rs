use crate::{OptionType, OptionsContract, OptionsContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup_env() -> (
    Env,
    OptionsContractClient<'static>,
    Address,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(OptionsContract, ());
    let client = OptionsContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let underlying_addr = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let quote_addr = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();

    client.initialize(&admin, &oracle);

    (env, client, admin, oracle, underlying_addr, quote_addr)
}

fn mint_tokens(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
    let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
    admin_client.mint(to, &amount);
}

/// Mint a standard call option with opening_time=500, expiration_time=1000.
/// Returns (option_id, minter).
fn mint_call_option(
    env: &Env,
    client: &OptionsContractClient,
    underlying: &Address,
    quote: &Address,
) -> (u32, Address) {
    let minter = Address::generate(env);
    mint_tokens(env, underlying, &minter, 20_000_000);

    let option_id = client.mint(
        &minter,
        &OptionType::Call,
        underlying,
        quote,
        &100_000_000_i128, // strike = 10 (scaled 1e7)
        &500u64,           // opening_time
        &1000u64,          // expiration_time
        &10_000_000_i128,  // collateral
    );
    (option_id, minter)
}

// ── Initialization ─────────────────────────────────────────────────────────

#[test]
fn test_initialize() {
    let (_, _client, _, _, _, _) = setup_env();
}

#[test]
fn test_double_initialize_rejected() {
    let (env, client, admin, oracle, _, _) = setup_env();
    let result = client.try_initialize(&admin, &oracle);
    assert_eq!(result, Err(Ok(crate::OptionsError::AlreadyInitialized)));
    let _ = env;
}

#[test]
fn test_mint_requires_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(OptionsContract, ());
    let client = OptionsContractClient::new(&env, &contract_id);

    let minter = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let underlying_addr = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let quote_addr = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let result = client.try_mint(
        &minter,
        &OptionType::Call,
        &underlying_addr,
        &quote_addr,
        &100_000_000_i128,
        &500u64,  // opening_time
        &1000u64, // expiration_time
        &10_000_000_i128,
    );
    assert_eq!(result, Err(Ok(crate::OptionsError::NotInitialized)));
}

// ── Exercise window validation on mint ────────────────────────────────────

#[test]
fn test_mint_rejects_invalid_exercise_window() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);
    mint_tokens(&env, &underlying, &minter, 20_000_000);

    // opening_time == expiration_time must be rejected
    let result = client.try_mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128,
        &1000u64, // opening_time == expiration_time
        &1000u64,
        &10_000_000_i128,
    );
    assert_eq!(result, Err(Ok(crate::OptionsError::InvalidExerciseWindow)));

    // opening_time > expiration_time must also be rejected
    let result2 = client.try_mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128,
        &2000u64, // opening > expiry
        &1000u64,
        &10_000_000_i128,
    );
    assert_eq!(result2, Err(Ok(crate::OptionsError::InvalidExerciseWindow)));
}

// ── Mint ──────────────────────────────────────────────────────────────────

#[test]
fn test_mint_call() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);

    assert_eq!(option_id, 1);
    let client_u = soroban_sdk::token::Client::new(&env, &underlying);
    // Minter transferred 10_000_000 collateral to the contract
    assert_eq!(client_u.balance(&minter), 10_000_000);
    assert_eq!(client_u.balance(&client.address), 10_000_000);
}

// ── Exercise: early rejection (before opening_time) ──────────────────────

#[test]
fn test_exercise_rejected_before_opening_time() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    // Ledger is at 0 — before opening_time of 500
    let result = client.try_exercise(&exerciser, &option_id);
    assert_eq!(result, Err(Ok(crate::OptionsError::TooEarly)));
}

#[test]
fn test_exercise_rejected_one_ledger_before_opening() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    // Set timestamp to one unit before opening_time
    env.ledger().set_timestamp(499);
    let result = client.try_exercise(&exerciser, &option_id);
    assert_eq!(result, Err(Ok(crate::OptionsError::TooEarly)));
}

// ── Exercise: valid window (opening_time..=expiration_time) ───────────────

#[test]
fn test_exercise_succeeds_at_opening_time_boundary() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    // Exactly at opening_time = 500
    env.ledger().set_timestamp(500);
    client.exercise(&exerciser, &option_id);

    let client_u = soroban_sdk::token::Client::new(&env, &underlying);
    let client_q = soroban_sdk::token::Client::new(&env, &quote);

    assert_eq!(client_u.balance(&exerciser), 10_000_000);
    assert_eq!(client_q.balance(&minter), 100_000_000);
    assert_eq!(client_u.balance(&client.address), 0);
}

#[test]
fn test_exercise_succeeds_at_expiration_time_boundary() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    // Exactly at expiration_time = 1000 (still within window)
    env.ledger().set_timestamp(1000);
    client.exercise(&exerciser, &option_id);

    let client_u = soroban_sdk::token::Client::new(&env, &underlying);
    let client_q = soroban_sdk::token::Client::new(&env, &quote);

    assert_eq!(client_u.balance(&exerciser), 10_000_000);
    assert_eq!(client_q.balance(&minter), 100_000_000);
}

#[test]
fn test_exercise_succeeds_mid_window() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    // Mid-window at 750
    env.ledger().set_timestamp(750);
    client.exercise(&exerciser, &option_id);

    let client_u = soroban_sdk::token::Client::new(&env, &underlying);
    let client_q = soroban_sdk::token::Client::new(&env, &quote);

    assert_eq!(client_u.balance(&exerciser), 10_000_000);
    assert_eq!(client_q.balance(&minter), 100_000_000);
}

// ── Exercise: expired rejection (after expiration_time) ───────────────────

#[test]
fn test_exercise_rejected_after_expiration_time() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    // Past expiration_time = 1000
    env.ledger().set_timestamp(1001);
    let result = client.try_exercise(&exerciser, &option_id);
    assert_eq!(result, Err(Ok(crate::OptionsError::ExerciseWindowClosed)));
}

// ── Repeated exercise: cannot pay twice ───────────────────────────────────

#[test]
fn test_repeated_exercise_rejected() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 400_000_000);

    // First exercise in valid window
    env.ledger().set_timestamp(750);
    client.exercise(&exerciser, &option_id);

    // Second attempt — must be rejected even while still in window
    let result = client.try_exercise(&exerciser, &option_id);
    assert_eq!(result, Err(Ok(crate::OptionsError::AlreadyExercised)));
}

// ── Expire ────────────────────────────────────────────────────────────────

#[test]
fn test_expire_rejected_before_expiration_time() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);

    // Try to expire at exactly expiration_time — should still reject (window still open)
    env.ledger().set_timestamp(1000);
    let result = client.try_expire(&option_id);
    assert_eq!(result, Err(Ok(crate::OptionsError::NotExpired)));
}

#[test]
fn test_expire_succeeds_after_expiration_time() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);

    // One unit after expiration_time
    env.ledger().set_timestamp(1001);
    client.expire(&option_id);

    let client_u = soroban_sdk::token::Client::new(&env, &underlying);
    // Collateral returned to minter
    assert_eq!(client_u.balance(&minter), 20_000_000);
    assert_eq!(client_u.balance(&client.address), 0);
}

#[test]
fn test_storage_migration_preserves_open_and_exercised_positions() {
    let (env, client, _admin, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);
    let exerciser = Address::generate(&env);
    mint_tokens(&env, &underlying, &minter, 20_000_000);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    let open_id = client.mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128,
        &1000u64,
        &5_000_000_i128,
    );
    let exercised_id = client.mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128,
        &1000u64,
        &5_000_000_i128,
    );
    env.ledger().set_timestamp(1000);
    client.exercise(&exerciser, &exercised_id);

    // A pre-migration deployment has no version marker, but live positions are
    // already persisted under Option(id) and must remain addressable.
    assert_eq!(
        env.as_contract(&client.address, || crate::storage::read_storage_version(
            &env
        )),
        0
    );
    client.migrate();
    assert_eq!(
        env.as_contract(&client.address, || crate::storage::read_storage_version(
            &env
        )),
        crate::storage::CURRENT_STORAGE_VERSION
    );

    let (open, exercised) = env.as_contract(&client.address, || {
        (
            crate::storage::read_option(&env, open_id),
            crate::storage::read_option(&env, exercised_id),
        )
    });
    assert!(!open.exercised);
    assert!(!open.expired);
    assert!(exercised.exercised);
    assert!(!exercised.expired);
    assert_eq!(open.minter, minter);
    assert_eq!(exercised.collateral_amount, 5_000_000);

    // Re-running migration is safe and does not alter either record.
    client.migrate();
    env.as_contract(&client.address, || {
        assert_eq!(crate::storage::read_option(&env, open_id), open);
        assert_eq!(crate::storage::read_option(&env, exercised_id), exercised);
    });
}

#[test]
fn test_storage_ttl_extension() {
fn test_expire_exercised_option_rejected() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    env.ledger().set_timestamp(750);
    client.exercise(&exerciser, &option_id);

    // Can't expire an already-exercised option
    env.ledger().set_timestamp(1001);
    let result = client.try_expire(&option_id);
    assert_eq!(result, Err(Ok(crate::OptionsError::AlreadyExpired)));
}

// ── Put option exercise ───────────────────────────────────────────────────

#[test]
fn test_exercise_put_in_valid_window() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);
    mint_tokens(&env, &quote, &minter, 200_000_000);

    let option_id = client.mint(
        &minter,
        &OptionType::Put,
        &underlying,
        &quote,
        &100_000_000_i128, // strike = 10
        &500u64,
        &1000u64,
        &10_000_000_i128, // collateral in quote asset
    );

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &underlying, &exerciser, 200_000_000);

    env.ledger().set_timestamp(750);
    client.exercise(&exerciser, &option_id);

    let client_q = soroban_sdk::token::Client::new(&env, &quote);
    // Exerciser receives quote collateral
    assert_eq!(client_q.balance(&exerciser), 10_000_000);
}

// ── Storage TTL extension ─────────────────────────────────────────────────

#[test]
fn test_storage_ttl_extension() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    // Exercise within valid window — verifies TTL extension calls run successfully
    env.ledger().set_timestamp(750);
    client.exercise(&exerciser, &option_id);
}
