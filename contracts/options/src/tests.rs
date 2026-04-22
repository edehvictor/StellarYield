use crate::{OptionType, OptionsContract, OptionsContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

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

#[test]
fn test_initialize() {
    let (_, _client, _, _, _, _) = setup_env();
}

#[test]
fn test_double_initialize_rejected() {
    let (env, client, admin, oracle, _, _) = setup_env();
    let result = client.try_initialize(&admin, &oracle);
    assert_eq!(result, Err(Ok(crate::OptionsError::AlreadyInitialized)));

    // Keep env in scope to avoid accidental drop-related warnings in some setups.
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
        &1000u64,
        &10_000_000_i128,
    );
    assert_eq!(result, Err(Ok(crate::OptionsError::NotInitialized)));
}

#[test]
fn test_mint_call() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);

    mint_tokens(&env, &underlying, &minter, 20_000_000);

    let option_id = client.mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128, // strike 10 (1e7)
        &1000u64,          // expiry
        &10_000_000_i128,  // collateral (1e7)
    );

    assert_eq!(option_id, 1);
    let client_u = soroban_sdk::token::Client::new(&env, &underlying);
    assert_eq!(client_u.balance(&minter), 10_000_000);
    assert_eq!(client_u.balance(&client.address), 10_000_000);
}

#[test]
fn test_expire() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);

    mint_tokens(&env, &underlying, &minter, 20_000_000);

    let option_id = client.mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128, // strike 10 (1e7)
        &500u64,           // expiry
        &10_000_000_i128,  // collateral (1e7)
    );

    // Advance ledger to expire the option
    env.ledger().set_timestamp(1000);

    client.expire(&option_id);

    let client_u = soroban_sdk::token::Client::new(&env, &underlying);
    assert_eq!(client_u.balance(&minter), 20_000_000);
    assert_eq!(client_u.balance(&client.address), 0);
}

#[test]
fn test_exercise() {
    let (env, client, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);
    let exerciser = Address::generate(&env);

    mint_tokens(&env, &underlying, &minter, 20_000_000);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    let option_id = client.mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128, // strike 10 (1e7)
        &1500u64,          // expiry
        &10_000_000_i128,  // collateral (1e7)
    );

    // Advance ledger past expiry to allow exercise
    env.ledger().set_timestamp(1500);

    client.exercise(&exerciser, &option_id);

    let client_u = soroban_sdk::token::Client::new(&env, &underlying);
    let client_q = soroban_sdk::token::Client::new(&env, &quote);

    // Exerciser received the 10_000_000 underlying
    assert_eq!(client_u.balance(&exerciser), 10_000_000);

    // Minter received 10 * 10 = 100_000_000 quote asset
    assert_eq!(client_q.balance(&minter), 100_000_000);

    // Contract has 0 balance
    assert_eq!(client_u.balance(&client.address), 0);
}
