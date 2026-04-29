use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Env};

fn setup_env() -> (
    Env,
    VeTokenomicsClient<'static>,
    Address,
    Address,
    token::StellarAssetClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();

    // Set a non-zero timestamp to be safe
    env.ledger().set_timestamp(1_000_000);

    let contract_id = env.register(VeTokenomics, ());
    let client = VeTokenomicsClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let yield_token_admin = Address::generate(&env);
    let yield_token_contract = env.register_stellar_asset_contract_v2(yield_token_admin.clone());
    let yield_token_addr = yield_token_contract.address();
    let yield_token_client = token::StellarAssetClient::new(&env, &yield_token_addr);

    client.initialize(&admin, &yield_token_addr);

    (env, client, admin, yield_token_addr, yield_token_client)
}

#[test]
fn test_create_lock() {
    let (env, client, _, yield_token_addr, yield_token_client) = setup_env();
    let user = Address::generate(&env);

    // Lock 1,000,000 tokens (assuming 10^7 decimals, this is 0.1 tokens, but let's just use big numbers)
    // Actually let's use 10^10 for 1000 tokens.
    let amount = 10_000_000_000i128;
    yield_token_client.mint(&user, &amount);

    let current_time = env.ledger().timestamp();
    let unlock_time = current_time + MAX_TIME; // Max lock

    client.create_lock(&user, &amount, &unlock_time);

    // Check tokens transferred
    let token_client = token::Client::new(&env, &yield_token_addr);
    assert_eq!(token_client.balance(&user), 0);
    assert_eq!(token_client.balance(&client.address), amount);

    // Check voting power (at max lock it should be equal to amount)
    let power = client.get_voting_power(&user);
    assert_eq!(power, amount);
}

#[test]
fn test_increase_amount() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let user = Address::generate(&env);

    let amount = 10_000_000_000i128;
    yield_token_client.mint(&user, &(amount * 2));

    let current_time = env.ledger().timestamp();
    let unlock_time = current_time + MAX_TIME;

    client.create_lock(&user, &amount, &unlock_time);
    let power_before = client.get_voting_power(&user);

    client.increase_amount(&user, &amount);
    let power_after = client.get_voting_power(&user);

    assert!(power_after > power_before);
    assert_eq!(power_after, amount * 2);
}

#[test]
fn test_increase_unlock_time() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let user = Address::generate(&env);

    let amount = 10_000_000_000i128;
    yield_token_client.mint(&user, &amount);

    let current_time = env.ledger().timestamp();
    let unlock_time_1 = current_time + WEEK * 52; // 1 year
    let unlock_time_2 = current_time + MAX_TIME; // 4 years

    client.create_lock(&user, &amount, &unlock_time_1);
    let power_before = client.get_voting_power(&user);

    client.increase_unlock_time(&user, &unlock_time_2);
    let power_after = client.get_voting_power(&user);

    assert!(power_after > power_before);
    assert_eq!(power_after, amount); // Max power
}

#[test]
fn test_withdraw_lifecycle() {
    let (env, client, _, yield_token_addr, yield_token_client) = setup_env();
    let user = Address::generate(&env);

    let amount = 10_000_000_000i128;
    yield_token_client.mint(&user, &amount);

    let current_time = env.ledger().timestamp();
    let unlock_time = current_time + WEEK * 10;

    client.create_lock(&user, &amount, &unlock_time);

    // Try withdraw early
    let result = client.try_withdraw(&user);
    assert!(result.is_err());

    // Advance time
    env.ledger().set_timestamp(unlock_time + 1);

    client.withdraw(&user);

    let token_client = token::Client::new(&env, &yield_token_addr);
    assert_eq!(token_client.balance(&user), amount);
    assert_eq!(client.get_voting_power(&user), 0);
}

#[test]
fn test_voting_decay() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let user = Address::generate(&env);

    let amount = 10_000_000_000i128;
    yield_token_client.mint(&user, &amount);

    let current_time = env.ledger().timestamp();
    let unlock_time = current_time + WEEK * 52; // 1 year

    client.create_lock(&user, &amount, &unlock_time);
    let p1 = client.get_voting_power(&user);

    // Advance time by 1 week
    env.ledger().set_timestamp(current_time + WEEK);
    let p2 = client.get_voting_power(&user);

    assert!(p2 < p1);

    // Final decay
    env.ledger().set_timestamp(unlock_time);
    let p3 = client.get_voting_power(&user);
    assert_eq!(p3, 0);
}

#[test]
fn test_gauge_voting() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let user = Address::generate(&env);
    let pool = Address::generate(&env);

    let amount = 10_000_000_000i128;
    yield_token_client.mint(&user, &amount);
    let unlock_time = env.ledger().timestamp() + WEEK * 10;
    client.create_lock(&user, &amount, &unlock_time);

    client.vote(&user, &pool, &5000); // 50%

    // Try vote with expired lock
    env.ledger().set_timestamp(unlock_time + 1);
    let result = client.try_vote(&user, &pool, &5000);
    assert!(result.is_err());
}
