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

fn settlement_state(client: &OptionsContractClient, option_id: u32) -> crate::SettlementState {
    client
        .get_settlement_state(&option_id, &client.get_config_fingerprint())
        .unwrap()
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
    let result = client.try_exercise(&exerciser, &option_id, &client.get_config_fingerprint());
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
    let result = client.try_exercise(&exerciser, &option_id, &client.get_config_fingerprint());
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
    client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());

    let client_u = soroban_sdk::token::Client::new(&env, &underlying);

    assert_eq!(client_u.balance(&exerciser), 10_000_000);
    // The minter keeps the 10M it never collateralised.
    assert_eq!(client_u.balance(&minter), 10_000_000);
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
    client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());

    let client_u = soroban_sdk::token::Client::new(&env, &underlying);

    assert_eq!(client_u.balance(&exerciser), 10_000_000);
    assert_eq!(client_u.balance(&minter), 10_000_000);
    assert_eq!(client_u.balance(&client.address), 0);
}

#[test]
fn test_exercise_succeeds_mid_window() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    // Mid-window at 750
    env.ledger().set_timestamp(750);
    client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());

    let client_u = soroban_sdk::token::Client::new(&env, &underlying);

    assert_eq!(client_u.balance(&exerciser), 10_000_000);
    assert_eq!(client_u.balance(&minter), 10_000_000);
    assert_eq!(client_u.balance(&client.address), 0);
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
    let result = client.try_exercise(&exerciser, &option_id, &client.get_config_fingerprint());
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
    client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());

    // Second attempt — must be rejected even while still in window
    let result = client.try_exercise(&exerciser, &option_id, &client.get_config_fingerprint());
    assert_eq!(result, Err(Ok(crate::OptionsError::AlreadyExercised)));
}

#[test]
fn test_settlement_sequence_rejects_stale_state_and_allows_retry() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);
    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);
    env.ledger().set_timestamp(750);

    assert_eq!(client.get_settlement_sequence(&option_id), 1);
    client.exercise_partial_with_sequence(
        &exerciser,
        &option_id,
        &4_000_000,
        &1,
        &client.get_config_fingerprint(),
    );
    assert_eq!(client.get_settlement_sequence(&option_id), 2);

    let underlying_client = soroban_sdk::token::Client::new(&env, &underlying);
    let balance_before_retry = underlying_client.balance(&exerciser);
    let stale = client.try_exercise_partial_with_sequence(
        &exerciser,
        &option_id,
        &1_000_000,
        &1,
        &client.get_config_fingerprint(),
    );
    assert_eq!(stale, Err(Ok(crate::OptionsError::ConcurrentModification)));
    assert_eq!(underlying_client.balance(&exerciser), balance_before_retry);
    assert_eq!(client.get_settlement_sequence(&option_id), 2);

    client.exercise_partial_with_sequence(
        &exerciser,
        &option_id,
        &1_000_000,
        &2,
        &client.get_config_fingerprint(),
    );
    assert_eq!(
        underlying_client.balance(&exerciser),
        balance_before_retry + 1_000_000
    );
    assert_eq!(client.get_settlement_sequence(&option_id), 3);
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
        &500u64,
        &1000u64,
        &5_000_000_i128,
    );
    let exercised_id = client.mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128,
        &500u64,
        &1000u64,
        &5_000_000_i128,
    );
    env.ledger().set_timestamp(1000);
    client.exercise(&exerciser, &exercised_id, &client.get_config_fingerprint());

    // Simulate a pre-context deployment: live positions remain under Option(id)
    // and migration pins its network and current layout without rewriting them.
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .remove(&crate::storage::DataKey::StorageVersion);
        env.storage()
            .instance()
            .remove(&crate::storage::DataKey::NetworkId);
    });
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
    assert_eq!(
        env.as_contract(&client.address, || crate::storage::read_network_id(&env)),
        Some(env.ledger().network_id())
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
fn test_expire_exercised_option_rejected() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);

    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    env.ledger().set_timestamp(750);
    client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());

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
    client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());

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
    client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());
}

// ── Collateral reserve: free vs reserved ──────────────────────────────────

fn mint_with(
    client: &OptionsContractClient,
    minter: &Address,
    underlying: &Address,
    quote: &Address,
    collateral: i128,
) -> u32 {
    client.mint(
        minter,
        &OptionType::Call,
        underlying,
        quote,
        &100_000_000_i128,
        &500u64,
        &1000u64,
        &collateral,
    )
}

#[test]
fn test_deposit_and_withdraw_free_collateral() {
    let (env, client, _, _, underlying, _) = setup_env();
    let owner = Address::generate(&env);
    mint_tokens(&env, &underlying, &owner, 10_000_000);
    let token = soroban_sdk::token::Client::new(&env, &underlying);

    client.deposit(&owner, &underlying, &10_000_000);
    assert_eq!(client.get_free_collateral(&owner, &underlying), 10_000_000);
    assert_eq!(client.get_reserved_collateral(&owner, &underlying), 0);
    assert_eq!(token.balance(&owner), 0);

    client.withdraw(&owner, &underlying, &4_000_000);
    assert_eq!(client.get_free_collateral(&owner, &underlying), 6_000_000);
    assert_eq!(token.balance(&owner), 4_000_000);
}

#[test]
fn test_deposit_and_withdraw_reject_zero_and_overdraw() {
    let (env, client, _, _, underlying, _) = setup_env();
    let owner = Address::generate(&env);
    mint_tokens(&env, &underlying, &owner, 1_000);

    assert_eq!(
        client.try_deposit(&owner, &underlying, &0),
        Err(Ok(crate::OptionsError::ZeroAmount))
    );
    assert_eq!(
        client.try_withdraw(&owner, &underlying, &0),
        Err(Ok(crate::OptionsError::ZeroAmount))
    );
    client.deposit(&owner, &underlying, &1_000);
    assert_eq!(
        client.try_withdraw(&owner, &underlying, &1_001),
        Err(Ok(crate::OptionsError::InsufficientFreeCollateral))
    );
}

#[test]
fn test_mint_without_deposit_reserves_collateral_from_wallet() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (_, minter) = mint_call_option(&env, &client, &underlying, &quote);

    assert_eq!(client.get_free_collateral(&minter, &underlying), 0);
    assert_eq!(
        client.get_reserved_collateral(&minter, &underlying),
        10_000_000
    );
    // Reserved collateral cannot be withdrawn.
    assert_eq!(
        client.try_withdraw(&minter, &underlying, &1),
        Err(Ok(crate::OptionsError::InsufficientFreeCollateral))
    );
}

#[test]
fn test_mint_uses_free_collateral_then_wallet_for_shortfall() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);
    mint_tokens(&env, &underlying, &minter, 10_000_000);
    let token = soroban_sdk::token::Client::new(&env, &underlying);

    client.deposit(&minter, &underlying, &4_000_000);
    mint_with(&client, &minter, &underlying, &quote, 10_000_000);

    // 4M came from free collateral, 6M was pulled from the wallet.
    assert_eq!(client.get_free_collateral(&minter, &underlying), 0);
    assert_eq!(
        client.get_reserved_collateral(&minter, &underlying),
        10_000_000
    );
    assert_eq!(token.balance(&minter), 0);
    assert_eq!(token.balance(&client.address), 10_000_000);
}

#[test]
fn test_withdraw_cannot_touch_collateral_reserved_by_open_option() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);
    mint_tokens(&env, &underlying, &minter, 15_000_000);
    let token = soroban_sdk::token::Client::new(&env, &underlying);

    client.deposit(&minter, &underlying, &15_000_000);
    mint_with(&client, &minter, &underlying, &quote, 10_000_000);
    assert_eq!(client.get_free_collateral(&minter, &underlying), 5_000_000);

    // Withdrawing more than the free 5M would undercollateralize the option.
    assert_eq!(
        client.try_withdraw(&minter, &underlying, &5_000_001),
        Err(Ok(crate::OptionsError::InsufficientFreeCollateral))
    );
    client.withdraw(&minter, &underlying, &5_000_000);

    assert_eq!(client.get_free_collateral(&minter, &underlying), 0);
    assert_eq!(
        client.get_reserved_collateral(&minter, &underlying),
        10_000_000
    );
    // The contract still holds every unit of reserved collateral.
    assert_eq!(token.balance(&client.address), 10_000_000);
}

#[test]
fn test_overlapping_positions_accumulate_reserve() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);
    mint_tokens(&env, &underlying, &minter, 30_000_000);
    let token = soroban_sdk::token::Client::new(&env, &underlying);

    client.deposit(&minter, &underlying, &18_000_000);
    mint_with(&client, &minter, &underlying, &quote, 10_000_000);
    mint_with(&client, &minter, &underlying, &quote, 5_000_000);

    assert_eq!(
        client.get_reserved_collateral(&minter, &underlying),
        15_000_000
    );
    assert_eq!(client.get_free_collateral(&minter, &underlying), 3_000_000);

    // Only the 3M that backs no open position can leave.
    assert_eq!(
        client.try_withdraw(&minter, &underlying, &4_000_000),
        Err(Ok(crate::OptionsError::InsufficientFreeCollateral))
    );
    client.withdraw(&minter, &underlying, &3_000_000);

    // Expiring one position releases only its own share of the reserve.
    env.ledger().set_timestamp(1001);
    client.expire(&1);
    assert_eq!(
        client.get_reserved_collateral(&minter, &underlying),
        5_000_000
    );
    assert_eq!(token.balance(&client.address), 5_000_000);
}

#[test]
fn test_partial_exercise_releases_only_the_exercised_reserve() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);
    let token_u = soroban_sdk::token::Client::new(&env, &underlying);

    env.ledger().set_timestamp(750);
    client.exercise_partial(
        &exerciser,
        &option_id,
        &4_000_000,
        &client.get_config_fingerprint(),
    );

    // 4M of the 10M left the contract; the other 6M stays reserved.
    assert_eq!(token_u.balance(&exerciser), 4_000_000);
    assert_eq!(token_u.balance(&minter), 10_000_000);
    assert_eq!(
        client.get_reserved_collateral(&minter, &underlying),
        6_000_000
    );
    assert_eq!(token_u.balance(&client.address), 6_000_000);
    assert_eq!(
        client.try_withdraw(&minter, &underlying, &1),
        Err(Ok(crate::OptionsError::InsufficientFreeCollateral))
    );

    // The option is still open and can be partially exercised again.
    client.exercise_partial(
        &exerciser,
        &option_id,
        &1_000_000,
        &client.get_config_fingerprint(),
    );
    assert_eq!(
        client.get_reserved_collateral(&minter, &underlying),
        5_000_000
    );
}

#[test]
fn test_partial_exercise_settles_one_base_unit_exactly() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
    let exerciser = Address::generate(&env);
    let token = soroban_sdk::token::Client::new(&env, &underlying);

    env.ledger().set_timestamp(750);
    client.exercise_partial(&exerciser, &option_id, &1, &client.get_config_fingerprint());

    assert_eq!(token.balance(&exerciser), 1);
    assert_eq!(token.balance(&client.address), 9_999_999);
    assert_eq!(
        client.get_reserved_collateral(&minter, &underlying),
        9_999_999
    );
}

#[test]
fn test_cancel_returns_unfilled_collateral_and_releases_reserve() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
    let token = soroban_sdk::token::Client::new(&env, &underlying);

    client.cancel(&minter, &option_id);

    assert_eq!(token.balance(&minter), 20_000_000);
    assert_eq!(token.balance(&client.address), 0);
    assert_eq!(client.get_reserved_collateral(&minter, &underlying), 0);
    assert!(!client.get_option_collateral_health(&option_id).active);
    assert_eq!(
        client.try_exercise(
            &Address::generate(&env),
            &option_id,
            &client.get_config_fingerprint()
        ),
        Err(Ok(crate::OptionsError::AlreadyCancelled))
    );
}

#[test]
fn test_cancel_cannot_be_repeated_or_expired() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);

    client.cancel(&minter, &option_id);
    assert_eq!(
        client.try_cancel(&minter, &option_id),
        Err(Ok(crate::OptionsError::AlreadyCancelled))
    );
    assert_eq!(
        client.try_expire(&option_id),
        Err(Ok(crate::OptionsError::AlreadyCancelled))
    );
}

#[test]
fn test_cancel_after_partial_exercise_returns_only_remaining_collateral() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);
    let token = soroban_sdk::token::Client::new(&env, &underlying);

    env.ledger().set_timestamp(750);
    client.exercise_partial(
        &exerciser,
        &option_id,
        &4_000_000,
        &client.get_config_fingerprint(),
    );
    client.cancel(&minter, &option_id);

    assert_eq!(token.balance(&exerciser), 4_000_000);
    assert_eq!(token.balance(&minter), 16_000_000);
    assert_eq!(token.balance(&client.address), 0);
    assert_eq!(client.get_reserved_collateral(&minter, &underlying), 0);
}

#[test]
fn test_cancel_after_expiration_requires_expire_path() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
    let token = soroban_sdk::token::Client::new(&env, &underlying);

    env.ledger().set_timestamp(1001);
    assert_eq!(
        client.try_cancel(&minter, &option_id),
        Err(Ok(crate::OptionsError::CancellationWindowClosed))
    );
    assert_eq!(token.balance(&minter), 10_000_000);
    client.expire(&option_id);
    assert_eq!(token.balance(&minter), 20_000_000);
    assert_eq!(client.get_reserved_collateral(&minter, &underlying), 0);
}

#[test]
fn test_cancel_requires_the_minter() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);
    let other = Address::generate(&env);

    assert_eq!(
        client.try_cancel(&other, &option_id),
        Err(Ok(crate::OptionsError::Unauthorized))
    );
}

#[test]
fn test_cancel_requires_authorization() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
    let token = soroban_sdk::token::Client::new(&env, &underlying);

    env.mock_auths(&[]);
    assert!(client.try_cancel(&minter, &option_id).is_err());
    assert_eq!(token.balance(&minter), 10_000_000);
    assert_eq!(token.balance(&client.address), 10_000_000);
}

#[test]
fn test_partial_exercise_rejects_zero_and_excess_amounts() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);
    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    env.ledger().set_timestamp(750);
    assert_eq!(
        client.try_exercise_partial(&exerciser, &option_id, &0, &client.get_config_fingerprint()),
        Err(Ok(crate::OptionsError::ZeroAmount))
    );
    assert_eq!(
        client.try_exercise_partial(
            &exerciser,
            &option_id,
            &10_000_001,
            &client.get_config_fingerprint()
        ),
        Err(Ok(crate::OptionsError::ExceedsCollateral))
    );

    // After a partial exercise only the remainder can be exercised.
    client.exercise_partial(
        &exerciser,
        &option_id,
        &7_000_000,
        &client.get_config_fingerprint(),
    );
    assert_eq!(
        client.try_exercise_partial(
            &exerciser,
            &option_id,
            &3_000_001,
            &client.get_config_fingerprint()
        ),
        Err(Ok(crate::OptionsError::ExceedsCollateral))
    );
}

#[test]
fn test_partial_exercise_respects_exercise_window() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);
    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    env.ledger().set_timestamp(499);
    assert_eq!(
        client.try_exercise_partial(
            &exerciser,
            &option_id,
            &1_000_000,
            &client.get_config_fingerprint()
        ),
        Err(Ok(crate::OptionsError::TooEarly))
    );
    env.ledger().set_timestamp(1001);
    assert_eq!(
        client.try_exercise_partial(
            &exerciser,
            &option_id,
            &1_000_000,
            &client.get_config_fingerprint()
        ),
        Err(Ok(crate::OptionsError::ExerciseWindowClosed))
    );
}

#[test]
fn test_finishing_partial_exercise_closes_position_and_clears_reserve() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    env.ledger().set_timestamp(750);
    client.exercise_partial(
        &exerciser,
        &option_id,
        &4_000_000,
        &client.get_config_fingerprint(),
    );
    // A full exercise now settles just the remaining 6M.
    client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());

    assert_eq!(client.get_reserved_collateral(&minter, &underlying), 0);
    let token_u = soroban_sdk::token::Client::new(&env, &underlying);
    assert_eq!(token_u.balance(&exerciser), 10_000_000);
    assert_eq!(token_u.balance(&client.address), 0);

    assert_eq!(
        client.try_exercise(&exerciser, &option_id, &client.get_config_fingerprint()),
        Err(Ok(crate::OptionsError::AlreadyExercised))
    );
    assert_eq!(
        client.try_cancel(&minter, &option_id),
        Err(Ok(crate::OptionsError::AlreadyExercised))
    );
    // The stored record keeps the original collateral amount.
    let option = env.as_contract(&client.address, || {
        crate::storage::read_option(&env, option_id)
    });
    assert!(option.exercised);
    assert_eq!(option.collateral_amount, 10_000_000);
}

#[test]
fn test_expire_after_partial_exercise_returns_only_remaining_collateral() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
    let exerciser = Address::generate(&env);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);
    let token_u = soroban_sdk::token::Client::new(&env, &underlying);

    env.ledger().set_timestamp(750);
    client.exercise_partial(
        &exerciser,
        &option_id,
        &4_000_000,
        &client.get_config_fingerprint(),
    );

    env.ledger().set_timestamp(1001);
    client.expire(&option_id);

    // Minter started with 20M, locked 10M, and gets back the unexercised 6M.
    assert_eq!(token_u.balance(&minter), 16_000_000);
    assert_eq!(token_u.balance(&client.address), 0);
    assert_eq!(client.get_reserved_collateral(&minter, &underlying), 0);
}

#[test]
fn test_put_option_reserves_quote_asset_collateral() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);
    mint_tokens(&env, &quote, &minter, 10_000_000);

    client.mint(
        &minter,
        &OptionType::Put,
        &underlying,
        &quote,
        &100_000_000_i128,
        &500u64,
        &1000u64,
        &10_000_000_i128,
    );

    assert_eq!(client.get_reserved_collateral(&minter, &quote), 10_000_000);
    assert_eq!(client.get_reserved_collateral(&minter, &underlying), 0);
    assert_eq!(
        client.try_withdraw(&minter, &quote, &1),
        Err(Ok(crate::OptionsError::InsufficientFreeCollateral))
    );
}

#[test]
fn test_reserve_is_tracked_per_owner() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let (_, minter) = mint_call_option(&env, &client, &underlying, &quote);
    let other = Address::generate(&env);
    mint_tokens(&env, &underlying, &other, 3_000_000);
    client.deposit(&other, &underlying, &3_000_000);

    // Another owner's deposit is unaffected by the minter's reserve, and the
    // minter cannot withdraw it.
    assert_eq!(client.get_free_collateral(&other, &underlying), 3_000_000);
    assert_eq!(client.get_free_collateral(&minter, &underlying), 0);
    assert_eq!(
        client.try_withdraw(&minter, &underlying, &1),
        Err(Ok(crate::OptionsError::InsufficientFreeCollateral))
    );
    client.withdraw(&other, &underlying, &3_000_000);
}

// ── Oracle freshness guard on mint ────────────────────────────────────────

use soroban_sdk::{contract, contractimpl, contracttype};

#[contracttype]
enum MockKey {
    Price(Address),
}

/// Minimal price source returning whatever the test last stored.
#[contract]
struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn set_price(env: Env, asset: Address, price: i128, observed_at: u64) {
        env.storage()
            .instance()
            .set(&MockKey::Price(asset), &(price, observed_at));
    }

    pub fn get_price(env: Env, asset: Address) -> Option<(i128, u64)> {
        env.storage().instance().get(&MockKey::Price(asset))
    }
}

const NOW: u64 = 10_000;
const MAX_AGE: u64 = 900;

struct OracleEnv {
    env: Env,
    client: OptionsContractClient<'static>,
    oracle: MockOracleClient<'static>,
    admin: Address,
    underlying: Address,
    quote: Address,
}

fn setup_oracle_env() -> OracleEnv {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let client = OptionsContractClient::new(&env, &env.register(OptionsContract, ()));
    let oracle = MockOracleClient::new(&env, &env.register(MockOracle, ()));
    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let underlying = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let quote = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    client.initialize(&admin, &oracle.address);

    OracleEnv {
        env,
        client,
        oracle,
        admin,
        underlying,
        quote,
    }
}

fn try_mint_call(t: &OracleEnv, minter: &Address) -> Result<u32, crate::OptionsError> {
    match t.client.try_mint(
        minter,
        &OptionType::Call,
        &t.underlying,
        &t.quote,
        &100_000_000_i128,
        &500u64,
        &1000u64,
        &10_000_000_i128,
    ) {
        Ok(Ok(id)) => Ok(id),
        Err(Ok(err)) => Err(err),
        other => panic!("unexpected result: {other:?}"),
    }
}

fn funded_minter(t: &OracleEnv) -> Address {
    let minter = Address::generate(&t.env);
    mint_tokens(&t.env, &t.underlying, &minter, 20_000_000);
    mint_tokens(&t.env, &t.quote, &minter, 20_000_000);
    minter
}

#[test]
fn test_mint_ignores_oracle_until_guard_is_enabled() {
    let t = setup_oracle_env();
    let minter = funded_minter(&t);

    // No observation at all, but the guard is off, so mint behaves as before.
    assert_eq!(t.client.get_oracle_max_age(), None);
    assert_eq!(try_mint_call(&t, &minter), Ok(1));
}

#[test]
fn test_mint_accepts_fresh_observation() {
    let t = setup_oracle_env();
    let minter = funded_minter(&t);
    t.client.set_oracle_max_age(&MAX_AGE);
    assert_eq!(t.client.get_oracle_max_age(), Some(MAX_AGE));

    t.oracle
        .set_price(&t.underlying, &100_000_000, &(NOW - 100));
    assert_eq!(try_mint_call(&t, &minter), Ok(1));
}

#[test]
fn test_mint_accepts_observation_exactly_at_max_age() {
    let t = setup_oracle_env();
    let minter = funded_minter(&t);
    t.client.set_oracle_max_age(&MAX_AGE);

    t.oracle
        .set_price(&t.underlying, &100_000_000, &(NOW - MAX_AGE));
    assert_eq!(try_mint_call(&t, &minter), Ok(1));
}

#[test]
fn test_mint_rejects_stale_observation_and_moves_no_funds() {
    let t = setup_oracle_env();
    let minter = funded_minter(&t);
    t.client.set_oracle_max_age(&MAX_AGE);
    let token = soroban_sdk::token::Client::new(&t.env, &t.underlying);

    t.oracle
        .set_price(&t.underlying, &100_000_000, &(NOW - MAX_AGE - 1));
    assert_eq!(
        try_mint_call(&t, &minter),
        Err(crate::OptionsError::StaleOracleObservation)
    );
    assert_eq!(token.balance(&minter), 20_000_000);
    assert_eq!(token.balance(&t.client.address), 0);

    // A refreshed observation unblocks minting, and ids start at 1: the
    // rejected attempt did not consume one.
    t.oracle.set_price(&t.underlying, &100_000_000, &NOW);
    assert_eq!(try_mint_call(&t, &minter), Ok(1));
}

#[test]
fn test_mint_rejects_missing_observation() {
    let t = setup_oracle_env();
    let minter = funded_minter(&t);
    t.client.set_oracle_max_age(&MAX_AGE);

    assert_eq!(
        try_mint_call(&t, &minter),
        Err(crate::OptionsError::OracleObservationMissing)
    );
}

#[test]
fn test_mint_rejects_invalid_observations() {
    let t = setup_oracle_env();
    let minter = funded_minter(&t);
    t.client.set_oracle_max_age(&MAX_AGE);

    // Non-positive price, zero timestamp, and a timestamp from the future.
    for (price, observed_at) in [
        (0, NOW),
        (-5, NOW),
        (100_000_000, 0),
        (100_000_000, NOW + 1),
    ] {
        t.oracle.set_price(&t.underlying, &price, &observed_at);
        assert_eq!(
            try_mint_call(&t, &minter),
            Err(crate::OptionsError::InvalidPrice),
            "price {price} observed_at {observed_at}"
        );
    }
}

#[test]
fn test_put_requires_fresh_observation_for_quote_collateral_too() {
    let t = setup_oracle_env();
    let minter = funded_minter(&t);
    t.client.set_oracle_max_age(&MAX_AGE);
    let mint_put = || {
        t.client.try_mint(
            &minter,
            &OptionType::Put,
            &t.underlying,
            &t.quote,
            &100_000_000_i128,
            &500u64,
            &1000u64,
            &10_000_000_i128,
        )
    };

    // Underlying is fresh but the quote (collateral) asset has no observation.
    t.oracle.set_price(&t.underlying, &100_000_000, &NOW);
    assert_eq!(
        mint_put(),
        Err(Ok(crate::OptionsError::OracleObservationMissing))
    );

    // Quote asset observed, but stale.
    t.oracle
        .set_price(&t.quote, &10_000_000, &(NOW - MAX_AGE - 1));
    assert_eq!(
        mint_put(),
        Err(Ok(crate::OptionsError::StaleOracleObservation))
    );

    t.oracle.set_price(&t.quote, &10_000_000, &(NOW - 1));
    assert_eq!(mint_put(), Ok(Ok(1)));
}

#[test]
fn test_oracle_max_age_admin_controls() {
    let t = setup_oracle_env();
    let minter = funded_minter(&t);

    assert_eq!(
        t.client.try_set_oracle_max_age(&0),
        Err(Ok(crate::OptionsError::InvalidMaxAge))
    );
    assert_eq!(t.client.get_oracle_max_age(), None);

    t.client.set_oracle_max_age(&MAX_AGE);
    // Only the admin may change the guard.
    assert_eq!(t.env.auths()[0].0, t.admin);

    // Clearing the guard lets mint ignore the (missing) observation again.
    assert_eq!(
        try_mint_call(&t, &minter),
        Err(crate::OptionsError::OracleObservationMissing)
    );
    t.client.clear_oracle_max_age();
    assert_eq!(t.client.get_oracle_max_age(), None);
    assert_eq!(try_mint_call(&t, &minter), Ok(1));
}

#[test]
fn test_oracle_max_age_requires_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    let client = OptionsContractClient::new(&env, &env.register(OptionsContract, ()));

    assert_eq!(
        client.try_set_oracle_max_age(&MAX_AGE),
        Err(Ok(crate::OptionsError::NotInitialized))
    );
    assert_eq!(
        client.try_clear_oracle_max_age(),
        Err(Ok(crate::OptionsError::NotInitialized))
    );
}

// ── Property tests: payout conservation ──────────────────────────────────

mod payout_conservation {
    extern crate std;

    use crate::{OptionType, OptionsContractClient};
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token, Address, Env,
    };

    const OPENING_TIME: u64 = 500;
    const EXPIRATION_TIME: u64 = 1_000;
    const STRIKE: i128 = 100_000_000;
    const CI_PROPTEST_CASES: u32 = 64;

    struct Position {
        env: Env,
        client: OptionsContractClient<'static>,
        option_id: u32,
        minter: Address,
        exerciser: Address,
        collateral_asset: Address,
        escrowed: i128,
    }

    impl Position {
        fn enter_exercise_window(&self) {
            self.env.ledger().set_timestamp(750);
        }

        fn close_window(&self) {
            self.env.ledger().set_timestamp(EXPIRATION_TIME + 1);
        }

        /// Asserts the settlement invariant for a single fully closed position:
        /// buyer payout + writer return + fees == escrowed collateral, and no
        /// leg exceeds the collateral that was escrowed at mint time.
        fn assert_conserved(&self, expected_buyer: i128) {
            let token_client = token::Client::new(&self.env, &self.collateral_asset);
            let buyer_payout = token_client.balance(&self.exerciser);
            let writer_return = token_client.balance(&self.minter);
            // This contract has no fee leg, so any collateral left behind would
            // be an accounting leak rather than a fee.
            let fees = token_client.balance(&self.client.address);

            assert_eq!(buyer_payout, expected_buyer, "unexpected buyer payout");
            assert_eq!(
                writer_return,
                self.escrowed - expected_buyer,
                "unexpected writer return"
            );
            assert_eq!(fees, 0, "contract retained collateral");
            assert!(buyer_payout <= self.escrowed);
            assert!(writer_return <= self.escrowed);
            assert!(fees <= self.escrowed);
            assert_eq!(
                buyer_payout + writer_return + fees,
                self.escrowed,
                "payouts must conserve the escrowed collateral"
            );
            assert_eq!(
                self.client
                    .get_reserved_collateral(&self.minter, &self.collateral_asset),
                0,
                "reserve must be fully released"
            );
        }
    }

    fn open_position(collateral: i128, is_put: bool, strike: i128) -> Position {
        let (env, client, _, _, underlying, quote) = super::setup_env();
        let option_type = if is_put {
            OptionType::Put
        } else {
            OptionType::Call
        };
        let collateral_asset = if is_put {
            quote.clone()
        } else {
            underlying.clone()
        };
        let minter = Address::generate(&env);
        super::mint_tokens(&env, &collateral_asset, &minter, collateral);

        let option_id = client.mint(
            &minter,
            &option_type,
            &underlying,
            &quote,
            &strike,
            &OPENING_TIME,
            &EXPIRATION_TIME,
            &collateral,
        );
        let exerciser = Address::generate(&env);

        Position {
            env,
            client,
            option_id,
            minter,
            exerciser,
            collateral_asset,
            escrowed: collateral,
        }
    }

    /// Mixes token-boundary amounts with a broad range so generated cases cover
    /// one-base-unit decimals as well as large balances.
    fn collateral_strategy() -> impl Strategy<Value = i128> {
        prop_oneof![
            Just(1i128),
            Just(9i128),
            Just(10i128),
            Just(1_000_000_000i128),
            Just(1_000_000_000_000_000i128),
            1i128..=1_000_000_000_000_000i128,
        ]
    }

    fn exercise_splits(
        client: &OptionsContractClient,
        position: &Position,
        collateral: i128,
        splits: std::vec::Vec<u8>,
    ) -> i128 {
        let mut expected_buyer = 0i128;
        for split in splits {
            let remaining = collateral - expected_buyer;
            if remaining == 0 {
                break;
            }
            let amount = ((collateral / 100) * split as i128).max(1).min(remaining);
            client.exercise_partial(
                &position.exerciser,
                &position.option_id,
                &amount,
                &client.get_config_fingerprint(),
            );
            expected_buyer += amount;
        }
        expected_buyer
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(CI_PROPTEST_CASES))]

        #[test]
        fn max_payout_full_exercise_conserves_collateral(
            collateral in collateral_strategy(),
            is_put in any::<bool>(),
        ) {
            let position = open_position(collateral, is_put, STRIKE);
            position.enter_exercise_window();
            position.client.exercise(
                &position.exerciser,
                &position.option_id,
                &position.client.get_config_fingerprint(),
            );

            // A full exercise pays the buyer the entire escrow: the maximum
            // payout permitted by the collateral.
            position.assert_conserved(collateral);
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(CI_PROPTEST_CASES))]

        #[test]
        fn partial_exercises_then_expiry_conserve_collateral(
            collateral in collateral_strategy(),
            is_put in any::<bool>(),
            splits in prop::collection::vec(1u8..=100, 1..8),
        ) {
            let position = open_position(collateral, is_put, STRIKE);
            position.enter_exercise_window();
            let expected_buyer =
                exercise_splits(&position.client, &position, collateral, splits);

            if expected_buyer < collateral {
                position.close_window();
                position.client.expire(&position.option_id);
            }

            position.assert_conserved(expected_buyer);
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(CI_PROPTEST_CASES))]

        #[test]
        fn partial_exercises_then_cancel_conserve_collateral(
            collateral in collateral_strategy(),
            is_put in any::<bool>(),
            splits in prop::collection::vec(1u8..=100, 1..8),
        ) {
            let position = open_position(collateral, is_put, STRIKE);
            position.enter_exercise_window();
            let expected_buyer =
                exercise_splits(&position.client, &position, collateral, splits);

            if expected_buyer < collateral {
                position
                    .client
                    .cancel(&position.minter, &position.option_id);
            }

            position.assert_conserved(expected_buyer);
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(CI_PROPTEST_CASES))]

        #[test]
        fn zero_intrinsic_value_still_conserves_collateral(
            collateral in collateral_strategy(),
            spot in 1i128..=STRIKE,
            strike_offset in 0i128..=STRIKE,
        ) {
            let strike = spot + strike_offset;
            let position = open_position(collateral, false, strike);

            // At expiry, an at- or out-of-the-money call has zero intrinsic
            // value; settlement must still conserve the posted collateral.
            let premium =
                position
                    .client
                    .get_premium(&spot, &strike, &0, &1_000_000_000);
            prop_assert_eq!(premium, 0);

            position.enter_exercise_window();
            position.client.exercise(
                &position.exerciser,
                &position.option_id,
                &position.client.get_config_fingerprint(),
            );
            position.assert_conserved(collateral);
        }
    }

    #[test]
    fn one_base_unit_boundary_conserves_collateral() {
        for collateral in [1i128, 9, 10, 999_999_999, 1_000_000_000] {
            let position = open_position(collateral, false, STRIKE);
            position.enter_exercise_window();
            position.client.exercise_partial(
                &position.exerciser,
                &position.option_id,
                &1,
                &position.client.get_config_fingerprint(),
            );

            let expected_buyer = 1;
            if expected_buyer < collateral {
                position.close_window();
                position.client.expire(&position.option_id);
            }
            position.assert_conserved(expected_buyer);
        }
    }
}

// ── Versioned lifecycle events (#1467) ───────────────────────────────────

mod versioned_lifecycle_events {
    use super::*;
    use crate::events::{OptionLifecycleEvent, OPTION_EVENT_SCHEMA_VERSION};
    use soroban_sdk::{
        symbol_short,
        testutils::{Events as _, Ledger},
        Env, Symbol, TryFromVal,
    };

    fn is_lifecycle_kind(kind: &Symbol) -> bool {
        *kind == symbol_short!("create")
            || *kind == symbol_short!("fill")
            || *kind == symbol_short!("exercise")
            || *kind == symbol_short!("expire")
            || *kind == symbol_short!("cancel")
    }

    /// The versioned lifecycle events emitted by the most recent invocation.
    fn lifecycle_events(env: &Env) -> soroban_sdk::Vec<(Symbol, u32, OptionLifecycleEvent)> {
        let mut out = soroban_sdk::Vec::new(env);
        for (_, topics, data) in env.events().all().iter() {
            if topics.len() != 3 {
                continue;
            }
            let Some(first) = topics.get(0) else {
                continue;
            };
            let Ok(kind) = Symbol::try_from_val(env, &first) else {
                continue;
            };
            if !is_lifecycle_kind(&kind) {
                continue;
            }
            let Ok(option_id) = u32::try_from_val(env, &topics.get(1).unwrap()) else {
                continue;
            };
            let Ok(schema_version) = u32::try_from_val(env, &topics.get(2).unwrap()) else {
                continue;
            };
            let Ok(event) = OptionLifecycleEvent::try_from_val(env, &data) else {
                continue;
            };

            assert_eq!(event.option_id, option_id);
            assert_eq!(event.schema_version, schema_version);
            out.push_back((kind, schema_version, event));
        }
        out
    }

    fn single_event(env: &Env) -> (Symbol, u32, OptionLifecycleEvent) {
        let events = lifecycle_events(env);
        assert_eq!(events.len(), 1, "expected one versioned lifecycle event");
        events.get(0).unwrap()
    }

    #[test]
    fn create_event_exposes_versioned_position_fields() {
        let (env, client, _, _, underlying, quote) = setup_env();
        env.ledger().set_timestamp(123);
        let minter = Address::generate(&env);
        mint_tokens(&env, &underlying, &minter, 10_000_000);

        let option_id = client.mint(
            &minter,
            &OptionType::Call,
            &underlying,
            &quote,
            &100_000_000_i128,
            &500u64,
            &1000u64,
            &10_000_000_i128,
        );

        let (kind, version, event) = single_event(&env);
        assert_eq!(kind, symbol_short!("create"));
        assert_eq!(version, OPTION_EVENT_SCHEMA_VERSION);
        assert_eq!(event.schema_version, OPTION_EVENT_SCHEMA_VERSION);
        assert_eq!(event.option_id, option_id);
        assert_eq!(event.option_type, OptionType::Call);
        assert_eq!(event.minter, minter);
        assert_eq!(event.actor, minter);
        assert_eq!(event.underlying_asset, underlying);
        assert_eq!(event.quote_asset, quote);
        assert_eq!(event.collateral_asset, underlying);
        assert_eq!(event.strike_price, 100_000_000);
        assert_eq!(event.opening_time, 500);
        assert_eq!(event.expiration_time, 1000);
        assert_eq!(event.collateral_amount, 10_000_000);
        assert_eq!(event.amount, 10_000_000);
        assert_eq!(event.exercised_amount, 0);
        assert_eq!(event.remaining_collateral, 10_000_000);
        assert_eq!(event.timestamp, 123);
    }

    #[test]
    fn create_fill_exercise_events_are_ordered_and_consistent() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);

        let (create_kind, version, create) = single_event(&env);
        assert_eq!(create_kind, symbol_short!("create"));
        assert_eq!(version, OPTION_EVENT_SCHEMA_VERSION);
        assert_eq!(create.option_id, option_id);

        env.ledger().set_timestamp(750);
        client.exercise_partial(
            &exerciser,
            &option_id,
            &4_000_000,
            &client.get_config_fingerprint(),
        );

        let (fill_kind, version, fill) = single_event(&env);
        assert_eq!(fill_kind, symbol_short!("fill"));
        assert_eq!(version, OPTION_EVENT_SCHEMA_VERSION);
        assert_eq!(fill.option_id, option_id);
        assert_eq!(fill.minter, minter);
        assert_eq!(fill.actor, exerciser);
        assert_eq!(fill.amount, 4_000_000);
        assert_eq!(fill.exercised_amount, 4_000_000);
        assert_eq!(fill.remaining_collateral, 6_000_000);

        client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());

        let (exercise_kind, version, exercise) = single_event(&env);
        assert_eq!(exercise_kind, symbol_short!("exercise"));
        assert_eq!(version, OPTION_EVENT_SCHEMA_VERSION);
        assert_eq!(exercise.option_id, option_id);
        assert_eq!(exercise.minter, minter);
        assert_eq!(exercise.actor, exerciser);
        assert_eq!(exercise.amount, 6_000_000);
        assert_eq!(exercise.exercised_amount, 10_000_000);
        assert_eq!(exercise.remaining_collateral, 0);
    }

    #[test]
    fn full_exercise_emits_exercise_without_a_fill() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);

        // Discard the create event; this test starts from the open position.
        let _ = single_event(&env);

        env.ledger().set_timestamp(750);
        client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());

        let (kind, version, event) = single_event(&env);
        assert_eq!(kind, symbol_short!("exercise"));
        assert_eq!(version, OPTION_EVENT_SCHEMA_VERSION);
        assert_eq!(event.option_id, option_id);
        assert_eq!(event.minter, minter);
        assert_eq!(event.actor, exerciser);
        assert_eq!(event.amount, 10_000_000);
        assert_eq!(event.exercised_amount, 10_000_000);
        assert_eq!(event.remaining_collateral, 0);
    }

    #[test]
    fn expiry_emits_versioned_expire_after_partial_fill() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);

        let (create_kind, _, _) = single_event(&env);
        assert_eq!(create_kind, symbol_short!("create"));

        env.ledger().set_timestamp(750);
        client.exercise_partial(
            &exerciser,
            &option_id,
            &4_000_000,
            &client.get_config_fingerprint(),
        );
        let (fill_kind, _, _) = single_event(&env);
        assert_eq!(fill_kind, symbol_short!("fill"));

        env.ledger().set_timestamp(1001);
        client.expire(&option_id);

        let (kind, version, event) = single_event(&env);
        assert_eq!(kind, symbol_short!("expire"));
        assert_eq!(version, OPTION_EVENT_SCHEMA_VERSION);
        assert_eq!(event.option_id, option_id);
        assert_eq!(event.minter, minter);
        assert_eq!(event.actor, minter);
        assert_eq!(event.amount, 6_000_000);
        assert_eq!(event.exercised_amount, 4_000_000);
        assert_eq!(event.remaining_collateral, 0);
        assert_eq!(event.timestamp, 1001);
    }

    #[test]
    fn cancellation_emits_versioned_cancel_after_partial_fill() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);

        let (create_kind, _, _) = single_event(&env);
        assert_eq!(create_kind, symbol_short!("create"));

        env.ledger().set_timestamp(750);
        client.exercise_partial(
            &exerciser,
            &option_id,
            &4_000_000,
            &client.get_config_fingerprint(),
        );
        let (fill_kind, _, _) = single_event(&env);
        assert_eq!(fill_kind, symbol_short!("fill"));

        client.cancel(&minter, &option_id);

        let (kind, version, event) = single_event(&env);
        assert_eq!(kind, symbol_short!("cancel"));
        assert_eq!(version, OPTION_EVENT_SCHEMA_VERSION);
        assert_eq!(event.option_id, option_id);
        assert_eq!(event.minter, minter);
        assert_eq!(event.actor, minter);
        assert_eq!(event.amount, 6_000_000);
        assert_eq!(event.exercised_amount, 4_000_000);
        assert_eq!(event.remaining_collateral, 0);
    }
}

// ── Configuration fingerprint on settlement (#1744) ───────────────────────

mod settlement_config_fingerprint {
    use super::*;
    use soroban_sdk::{symbol_short, testutils::Events as _, BytesN, Symbol, TryFromVal};

    /// The latest `config` event payload, if the last invocation emitted one.
    fn last_config_event(env: &Env) -> Option<(Address, BytesN<32>)> {
        let mut found = None;
        for (_, topics, data) in env.events().all().iter() {
            if topics.len() != 1 {
                continue;
            }
            let Some(first) = topics.get(0) else { continue };
            let Ok(kind) = Symbol::try_from_val(env, &first) else {
                continue;
            };
            if kind != symbol_short!("config") {
                continue;
            }
            found = Some(<(Address, BytesN<32>)>::try_from_val(env, &data).unwrap());
        }
        found
    }

    #[test]
    fn fingerprint_is_stable_across_position_state_changes() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let before = client.get_config_fingerprint();

        // Minting, depositing and exercising change balances and positions, not
        // configuration, so a captured fingerprint must stay valid.
        let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);
        assert_eq!(client.get_config_fingerprint(), before);

        env.ledger().set_timestamp(750);
        let exerciser = Address::generate(&env);
        client.exercise_partial(&exerciser, &option_id, &1_000_000, &before);
        assert_eq!(client.get_config_fingerprint(), before);
    }

    #[test]
    fn fingerprint_matches_the_configuration_snapshot() {
        let (env, client, admin, oracle, _, _) = setup_env();
        let snapshot = client.get_config_snapshot();
        assert_eq!(snapshot.network_id, env.ledger().network_id());
        assert_eq!(snapshot.contract, client.address);
        assert_eq!(snapshot.admin, admin);
        assert_eq!(snapshot.oracle, oracle);
        assert_eq!(snapshot.oracle_max_age, None);
        assert_eq!(
            snapshot.storage_version,
            crate::storage::CURRENT_STORAGE_VERSION
        );

        // Any configuration change produces a different fingerprint; reverting
        // the change restores it, so the fingerprint is a pure function of the
        // snapshot rather than of call order.
        let initial = client.get_config_fingerprint();
        client.set_oracle_max_age(&MAX_AGE);
        assert_eq!(client.get_config_snapshot().oracle_max_age, Some(MAX_AGE));
        let guarded = client.get_config_fingerprint();
        assert_ne!(guarded, initial);

        client.clear_oracle_max_age();
        assert_eq!(client.get_config_fingerprint(), initial);

        client.migrate();
        assert_eq!(
            client.get_config_snapshot().storage_version,
            crate::storage::CURRENT_STORAGE_VERSION
        );
        assert_eq!(client.get_config_fingerprint(), initial);
        let _ = env;
    }

    #[test]
    fn settlement_succeeds_with_the_current_fingerprint() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);
        let token = soroban_sdk::token::Client::new(&env, &underlying);

        env.ledger().set_timestamp(750);
        client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());

        assert_eq!(token.balance(&exerciser), 10_000_000);
        assert_eq!(token.balance(&client.address), 0);
        assert_eq!(client.get_reserved_collateral(&minter, &underlying), 0);
    }

    #[test]
    fn stale_fingerprint_rejects_settlement_and_preserves_state() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);
        let token = soroban_sdk::token::Client::new(&env, &underlying);

        // The caller snapshots the configuration, then an admin change lands.
        let captured = client.get_config_fingerprint();
        client.set_oracle_max_age(&MAX_AGE);
        assert_ne!(client.get_config_fingerprint(), captured);

        env.ledger().set_timestamp(750);
        assert_eq!(
            client.try_exercise(&exerciser, &option_id, &captured),
            Err(Ok(crate::OptionsError::StaleConfig))
        );

        // The rejected settlement moved nothing: balances, reserve, exercised
        // amount and the position record are all untouched.
        assert_eq!(token.balance(&exerciser), 0);
        assert_eq!(token.balance(&client.address), 10_000_000);
        assert_eq!(
            client.get_reserved_collateral(&minter, &underlying),
            10_000_000
        );
        assert_eq!(client.get_free_collateral(&minter, &underlying), 0);
        let (exercised_amount, option, cancelled) = env.as_contract(&client.address, || {
            (
                crate::storage::read_exercised_amount(&env, option_id),
                crate::storage::read_option(&env, option_id),
                crate::storage::read_cancelled(&env, option_id),
            )
        });
        assert_eq!(exercised_amount, 0);
        assert!(!option.exercised);
        assert!(!cancelled);
        assert!(client.get_option_collateral_health(&option_id).active);

        // Retrying with a refreshed fingerprint settles exactly once.
        client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());
        assert_eq!(token.balance(&exerciser), 10_000_000);
        assert_eq!(token.balance(&client.address), 0);
        assert_eq!(client.get_reserved_collateral(&minter, &underlying), 0);
        assert_eq!(
            client.try_exercise(&exerciser, &option_id, &client.get_config_fingerprint()),
            Err(Ok(crate::OptionsError::AlreadyExercised))
        );
    }

    #[test]
    fn stale_fingerprint_rejects_partial_settlement_and_allows_safe_retry() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);
        let token = soroban_sdk::token::Client::new(&env, &underlying);

        let captured = client.get_config_fingerprint();
        // Model an approved context migration between preparation and execution.
        env.as_contract(&client.address, || {
            env.storage()
                .instance()
                .set(&crate::storage::DataKey::StorageVersion, &1_u32);
        });
        client.migrate();

        env.ledger().set_timestamp(750);
        assert_eq!(
            client.try_exercise_partial(&exerciser, &option_id, &4_000_000, &captured),
            Err(Ok(crate::OptionsError::StaleConfig))
        );
        // Nothing was paid out and no reserve was released.
        assert_eq!(token.balance(&exerciser), 0);
        assert_eq!(
            client.get_reserved_collateral(&minter, &underlying),
            10_000_000
        );

        // A retry under the refreshed configuration settles the same amount.
        client.exercise_partial(
            &exerciser,
            &option_id,
            &4_000_000,
            &client.get_config_fingerprint(),
        );
        assert_eq!(token.balance(&exerciser), 4_000_000);
        assert_eq!(
            client.get_reserved_collateral(&minter, &underlying),
            6_000_000
        );
    }

    #[test]
    fn network_mismatch_rejects_reads_and_settlement_then_retry_is_safe() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);
        let token = soroban_sdk::token::Client::new(&env, &underlying);
        let fingerprint = client.get_config_fingerprint();
        let original_network = env.ledger().network_id();

        env.ledger().set_network_id([7; 32]);
        assert_eq!(
            client.try_get_config_fingerprint(),
            Err(Ok(crate::OptionsError::WrongNetwork))
        );
        assert_eq!(
            client.try_get_settlement_state(&option_id, &fingerprint),
            Err(Ok(crate::OptionsError::WrongNetwork))
        );
        env.ledger().set_timestamp(750);
        assert_eq!(
            client.try_exercise(&exerciser, &option_id, &fingerprint),
            Err(Ok(crate::OptionsError::WrongNetwork))
        );

        assert_eq!(token.balance(&exerciser), 0);
        assert_eq!(token.balance(&client.address), 10_000_000);
        assert_eq!(
            client.get_reserved_collateral(&minter, &underlying),
            10_000_000
        );

        env.ledger().set_network_id(original_network.to_array());
        client.exercise(&exerciser, &option_id, &fingerprint);
        assert_eq!(token.balance(&exerciser), 10_000_000);
        assert_eq!(
            settlement_state(&client, option_id).status,
            crate::SettlementStatus::Exercised
        );
    }

    #[test]
    fn config_fingerprint_functions_require_initialization() {
        let env = Env::default();
        env.mock_all_auths();
        let client = OptionsContractClient::new(&env, &env.register(OptionsContract, ()));

        assert_eq!(
            client.try_get_config_fingerprint(),
            Err(Ok(crate::OptionsError::NotInitialized))
        );
        assert_eq!(
            client.try_get_config_snapshot(),
            Err(Ok(crate::OptionsError::NotInitialized))
        );
    }

    #[test]
    fn admin_config_change_announces_the_new_fingerprint() {
        let (env, client, admin, _, _, _) = setup_env();
        client.set_oracle_max_age(&MAX_AGE);

        let (actor, fingerprint) = last_config_event(&env).expect("config event expected");
        assert_eq!(actor, admin);
        assert_eq!(fingerprint, client.get_config_fingerprint());

        client.clear_oracle_max_age();
        let (actor, fingerprint) = last_config_event(&env).expect("config event expected");
        assert_eq!(actor, admin);
        assert_eq!(fingerprint, client.get_config_fingerprint());
    }
}

// ── Settlement hardening: partial completion and retry (#1749) ───────────────

mod settlement_retry {
    use super::*;
    use crate::{OptionsError, SettlementState, SettlementStatus};
    use soroban_sdk::token;

    /// Simulates a failing token leg by draining the contract's escrow so the
    /// next payout transfer cannot succeed. Returns the amount drained.
    fn drain_escrow(
        env: &Env,
        client: &OptionsContractClient,
        asset: &Address,
        sink: &Address,
    ) -> i128 {
        let token = token::Client::new(env, asset);
        let balance = token.balance(&client.address);
        env.as_contract(&client.address, || {
            token.transfer(&client.address, sink, &balance);
        });
        balance
    }

    fn restore_escrow(
        env: &Env,
        client: &OptionsContractClient,
        asset: &Address,
        sink: &Address,
        amount: i128,
    ) {
        token::Client::new(env, asset).transfer(sink, &client.address, &amount);
    }

    #[test]
    fn settlement_state_tracks_the_full_lifecycle() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);

        assert_eq!(
            settlement_state(&client, option_id),
            SettlementState {
                status: SettlementStatus::Open,
                exercised_amount: 0,
                remaining_amount: 10_000_000,
            }
        );

        env.ledger().set_timestamp(750);
        client.exercise_partial(
            &exerciser,
            &option_id,
            &4_000_000,
            &client.get_config_fingerprint(),
        );
        assert_eq!(
            settlement_state(&client, option_id),
            SettlementState {
                status: SettlementStatus::PartiallyExercised,
                exercised_amount: 4_000_000,
                remaining_amount: 6_000_000,
            }
        );

        client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());
        assert_eq!(
            settlement_state(&client, option_id),
            SettlementState {
                status: SettlementStatus::Exercised,
                exercised_amount: 10_000_000,
                remaining_amount: 0,
            }
        );
    }

    #[test]
    fn settlement_state_reports_expired_and_cancelled() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (expiring, _) = mint_call_option(&env, &client, &underlying, &quote);
        let (cancelled, minter) = mint_call_option(&env, &client, &underlying, &quote);

        client.cancel(&minter, &cancelled);
        assert_eq!(
            settlement_state(&client, cancelled).status,
            SettlementStatus::Cancelled
        );

        env.ledger().set_timestamp(1001);
        client.expire(&expiring);
        let state = settlement_state(&client, expiring);
        assert_eq!(state.status, SettlementStatus::Expired);
        assert_eq!(state.remaining_amount, 0);
    }

    #[test]
    fn failed_exercise_leaves_state_and_balances_untouched_then_retry_succeeds() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);
        let sink = Address::generate(&env);
        let token_u = token::Client::new(&env, &underlying);

        env.ledger().set_timestamp(750);
        let drained = drain_escrow(&env, &client, &underlying, &sink);
        let before = settlement_state(&client, option_id);

        assert!(client
            .try_exercise_partial(
                &exerciser,
                &option_id,
                &4_000_000,
                &client.get_config_fingerprint()
            )
            .is_err());

        // Nothing moved, no progress recorded, reserve intact.
        assert_eq!(settlement_state(&client, option_id), before);
        assert_eq!(token_u.balance(&exerciser), 0);
        assert_eq!(
            client.get_reserved_collateral(&minter, &underlying),
            10_000_000
        );

        // Once the leg can succeed, the same call completes exactly once.
        restore_escrow(&env, &client, &underlying, &sink, drained);
        client.exercise_partial(
            &exerciser,
            &option_id,
            &4_000_000,
            &client.get_config_fingerprint(),
        );
        assert_eq!(token_u.balance(&exerciser), 4_000_000);
        assert_eq!(
            settlement_state(&client, option_id).exercised_amount,
            4_000_000
        );
        assert_eq!(
            client.get_reserved_collateral(&minter, &underlying),
            6_000_000
        );
    }

    #[test]
    fn failed_full_exercise_does_not_mark_option_exercised() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);
        let sink = Address::generate(&env);

        env.ledger().set_timestamp(750);
        let drained = drain_escrow(&env, &client, &underlying, &sink);
        assert!(client
            .try_exercise(&exerciser, &option_id, &client.get_config_fingerprint())
            .is_err());
        assert_eq!(
            settlement_state(&client, option_id).status,
            SettlementStatus::Open
        );

        restore_escrow(&env, &client, &underlying, &sink, drained);
        client.exercise(&exerciser, &option_id, &client.get_config_fingerprint());
        assert_eq!(
            settlement_state(&client, option_id).status,
            SettlementStatus::Exercised
        );
    }

    #[test]
    fn failed_expire_is_rolled_back_and_can_be_retried() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let sink = Address::generate(&env);
        let token_u = token::Client::new(&env, &underlying);

        env.ledger().set_timestamp(1001);
        let drained = drain_escrow(&env, &client, &underlying, &sink);
        assert!(client.try_expire(&option_id).is_err());

        // Not marked expired, reserve not released, minter not paid.
        assert_eq!(
            settlement_state(&client, option_id).status,
            SettlementStatus::Open
        );
        assert_eq!(
            client.get_reserved_collateral(&minter, &underlying),
            10_000_000
        );
        assert_eq!(token_u.balance(&minter), 10_000_000);

        restore_escrow(&env, &client, &underlying, &sink, drained);
        client.expire(&option_id);
        assert_eq!(token_u.balance(&minter), 20_000_000);
        assert_eq!(client.get_reserved_collateral(&minter, &underlying), 0);
        assert_eq!(
            client.try_expire(&option_id),
            Err(Ok(OptionsError::AlreadyExpired))
        );
    }

    #[test]
    fn failed_cancel_is_rolled_back_and_can_be_retried() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let sink = Address::generate(&env);
        let token_u = token::Client::new(&env, &underlying);

        let drained = drain_escrow(&env, &client, &underlying, &sink);
        assert!(client.try_cancel(&minter, &option_id).is_err());
        assert_eq!(
            settlement_state(&client, option_id).status,
            SettlementStatus::Open
        );
        assert_eq!(
            client.get_reserved_collateral(&minter, &underlying),
            10_000_000
        );

        restore_escrow(&env, &client, &underlying, &sink, drained);
        client.cancel(&minter, &option_id);
        assert_eq!(token_u.balance(&minter), 20_000_000);
        assert_eq!(
            client.try_cancel(&minter, &option_id),
            Err(Ok(OptionsError::AlreadyCancelled))
        );
    }

    #[test]
    fn rejected_validation_changes_nothing() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);
        let token_u = token::Client::new(&env, &underlying);

        env.ledger().set_timestamp(750);
        assert_eq!(
            client.try_exercise_partial(
                &exerciser,
                &option_id,
                &10_000_001,
                &client.get_config_fingerprint()
            ),
            Err(Ok(OptionsError::ExceedsCollateral))
        );
        assert_eq!(
            client.try_exercise_partial(
                &exerciser,
                &option_id,
                &0,
                &client.get_config_fingerprint()
            ),
            Err(Ok(OptionsError::ZeroAmount))
        );

        assert_eq!(settlement_state(&client, option_id).exercised_amount, 0);
        assert_eq!(token_u.balance(&client.address), 10_000_000);
        assert_eq!(
            client.get_reserved_collateral(&minter, &underlying),
            10_000_000
        );
    }

    #[test]
    fn checked_exercise_pays_once_when_the_same_request_is_retried() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);
        let token_u = token::Client::new(&env, &underlying);

        env.ledger().set_timestamp(750);
        client.exercise_partial_checked(
            &exerciser,
            &option_id,
            &4_000_000,
            &0,
            &1,
            &client.get_config_fingerprint(),
        );

        // The client never saw the first result and resubmits the identical call.
        assert_eq!(
            client.try_exercise_partial_checked(
                &exerciser,
                &option_id,
                &4_000_000,
                &0,
                &1,
                &client.get_config_fingerprint()
            ),
            Err(Ok(OptionsError::SettlementStateChanged))
        );

        assert_eq!(token_u.balance(&exerciser), 4_000_000);
        assert_eq!(
            settlement_state(&client, option_id).exercised_amount,
            4_000_000
        );
        assert_eq!(
            client.get_reserved_collateral(&minter, &underlying),
            6_000_000
        );

        // Resuming from the persisted progress continues normally.
        client.exercise_partial_checked(
            &exerciser,
            &option_id,
            &6_000_000,
            &4_000_000,
            &2,
            &client.get_config_fingerprint(),
        );
        assert_eq!(
            settlement_state(&client, option_id).status,
            SettlementStatus::Exercised
        );
        assert_eq!(token_u.balance(&exerciser), 10_000_000);
        assert_eq!(client.get_reserved_collateral(&minter, &underlying), 0);
    }

    #[test]
    fn checked_exercise_after_full_settlement_is_refused() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, _) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);
        let token_u = token::Client::new(&env, &underlying);

        env.ledger().set_timestamp(750);
        client.exercise_partial_checked(
            &exerciser,
            &option_id,
            &10_000_000,
            &0,
            &1,
            &client.get_config_fingerprint(),
        );
        assert_eq!(
            client.try_exercise_partial_checked(
                &exerciser,
                &option_id,
                &10_000_000,
                &0,
                &1,
                &client.get_config_fingerprint()
            ),
            Err(Ok(OptionsError::SettlementStateChanged))
        );
        assert_eq!(token_u.balance(&exerciser), 10_000_000);
    }

    #[test]
    fn checked_exercise_still_enforces_normal_validation() {
        let (env, client, _, _, underlying, quote) = setup_env();
        let (option_id, minter) = mint_call_option(&env, &client, &underlying, &quote);
        let exerciser = Address::generate(&env);

        env.ledger().set_timestamp(750);
        assert_eq!(
            client.try_exercise_partial_checked(
                &exerciser,
                &option_id,
                &10_000_001,
                &0,
                &1,
                &client.get_config_fingerprint()
            ),
            Err(Ok(OptionsError::ExceedsCollateral))
        );
        client.cancel(&minter, &option_id);
        assert_eq!(
            client.try_exercise_partial_checked(
                &exerciser,
                &option_id,
                &1,
                &0,
                &1,
                &client.get_config_fingerprint()
            ),
            Err(Ok(OptionsError::AlreadyCancelled))
        );
    }
}
