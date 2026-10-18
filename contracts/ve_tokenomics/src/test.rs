extern crate std;

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
fn test_expired_lock_has_zero_power_at_later_ledgers() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let user = Address::generate(&env);
    let amount = 10_000_000_000i128;
    yield_token_client.mint(&user, &amount);

    let start = env.ledger().timestamp();
    let unlock_time = start + WEEK * 10;
    client.create_lock(&user, &amount, &unlock_time);

    env.ledger().set_timestamp(unlock_time + 1);
    assert_eq!(client.get_voting_power(&user), 0);

    env.ledger().set_timestamp(unlock_time + WEEK * 52);
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

#[test]
fn test_storage_ttl_extension() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let user = Address::generate(&env);

    let amount = 10_000_000_000i128;
    yield_token_client.mint(&user, &amount);
    let unlock_time = env.ledger().timestamp() + WEEK * 10;
    client.create_lock(&user, &amount, &unlock_time);

    // Call get_voting_power and get_unlock_time to test that persistent user lock read paths run with TTL extension
    client.get_voting_power(&user);
    client.get_unlock_time(&user);
}

// ── Lock extension (#1511) ──────────────────────────────────────────

fn lock_for(
    env: &Env,
    client: &VeTokenomicsClient<'static>,
    yield_token_client: &token::StellarAssetClient<'static>,
    amount: i128,
    duration: u64,
) -> Address {
    let user = Address::generate(env);
    yield_token_client.mint(&user, &amount);
    let unlock_time = env.ledger().timestamp() + duration;
    client.create_lock(&user, &amount, &unlock_time);
    user
}

#[test]
fn test_early_extension_recomputes_power_from_new_end() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let amount = 10_000_000_000i128;
    let user = lock_for(&env, &client, &yield_token_client, amount, WEEK * 52);

    // Extend well before the lock expires.
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + WEEK * 4);
    let now = env.ledger().timestamp();
    let new_end = now + WEEK * 104;
    client.increase_unlock_time(&user, &new_end);

    let lock = client.get_lock(&user).unwrap();
    assert_eq!(lock.amount, amount);
    assert_eq!(lock.end, new_end);
    assert_eq!(
        client.get_voting_power(&user),
        calculate_voting_power(amount, new_end, now)
    );
    assert_eq!(client.get_total_locked(), amount);
}

#[test]
fn test_repeated_extensions_do_not_double_count_power() {
    let (env, client, _, yield_token_addr, yield_token_client) = setup_env();
    let amount = 10_000_000_000i128;
    let user = lock_for(&env, &client, &yield_token_client, amount, WEEK * 10);

    let start = env.ledger().timestamp();
    let mut end = start + WEEK * 10;
    for step in 1..=5u64 {
        env.ledger().set_timestamp(start + WEEK * step);
        end += WEEK * 20;
        client.increase_unlock_time(&user, &end);

        let now = env.ledger().timestamp();
        let power = client.get_voting_power(&user);
        // Power equals a single fresh lock ending at `end` — never the sum of
        // the old and new positions.
        assert_eq!(power, calculate_voting_power(amount, end, now));
        assert!(power <= amount);
        assert_eq!(client.get_lock(&user).unwrap().amount, amount);
    }

    // Extending to the max horizon caps power at the locked amount.
    let now = env.ledger().timestamp();
    client.increase_unlock_time(&user, &(now + MAX_TIME));
    assert_eq!(client.get_voting_power(&user), amount);

    // No tokens were minted or moved by the extensions.
    let token_client = token::Client::new(&env, &yield_token_addr);
    assert_eq!(token_client.balance(&client.address), amount);
    assert_eq!(client.get_total_locked(), amount);
}

#[test]
fn test_extension_rejects_non_increasing_end() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let amount = 10_000_000_000i128;
    let user = lock_for(&env, &client, &yield_token_client, amount, WEEK * 10);
    let end = client.get_unlock_time(&user);
    let power_before = client.get_voting_power(&user);

    assert_eq!(
        client.try_increase_unlock_time(&user, &end),
        Err(Ok(Error::InvalidUnlockTime))
    );
    assert_eq!(client.get_voting_power(&user), power_before);
}

#[test]
fn test_extension_with_concurrent_positions_is_isolated() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let a_amount = 10_000_000_000i128;
    let b_amount = 4_000_000_000i128;
    let a = lock_for(&env, &client, &yield_token_client, a_amount, WEEK * 26);
    let b = lock_for(&env, &client, &yield_token_client, b_amount, WEEK * 52);
    let b_end = client.get_unlock_time(&b);

    env.ledger().set_timestamp(env.ledger().timestamp() + WEEK);
    let now = env.ledger().timestamp();
    let b_power_before = client.get_voting_power(&b);

    let a_end = now + WEEK * 200;
    client.increase_unlock_time(&a, &a_end);
    yield_token_client.mint(&b, &b_amount);
    client.increase_amount(&b, &b_amount);

    assert_eq!(
        client.get_voting_power(&a),
        calculate_voting_power(a_amount, a_end, now)
    );
    // `b` only grew from its own amount increase; `a`'s extension leaked nothing.
    assert_eq!(client.get_unlock_time(&b), b_end);
    assert_eq!(
        client.get_voting_power(&b),
        calculate_voting_power(b_amount * 2, b_end, now)
    );
    assert!(client.get_voting_power(&b) > b_power_before);
    assert_eq!(client.get_total_locked(), a_amount + b_amount * 2);

    // Withdrawing one position releases exactly its own tokens.
    env.ledger().set_timestamp(b_end + 1);
    client.withdraw(&b);
    assert_eq!(client.get_total_locked(), a_amount);
}

#[test]
fn test_extension_flows_through_delegation_once() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let amount = 10_000_000_000i128;
    let delegator = lock_for(&env, &client, &yield_token_client, amount, WEEK * 26);
    let delegatee = lock_for(&env, &client, &yield_token_client, amount, WEEK * 26);
    client.delegate(&delegator, &delegatee);

    let now = env.ledger().timestamp();
    let new_end = now + WEEK * 150;
    client.increase_unlock_time(&delegator, &new_end);
    client.increase_unlock_time(&delegator, &(new_end + WEEK));

    let expected = client.get_voting_power(&delegator) + client.get_voting_power(&delegatee);
    assert_eq!(client.get_delegated_voting_power(&delegatee), expected);
    assert_eq!(client.get_delegated_voting_power(&delegator), 0);
}

// ── Delegation cycle detection (#1512) ──────────────────────────────

#[test]
fn test_delegate_moves_voting_weight() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let amount = 10_000_000_000i128;
    let a = lock_for(&env, &client, &yield_token_client, amount, MAX_TIME);
    let b = Address::generate(&env);

    assert_eq!(client.get_delegated_voting_power(&a), amount);
    client.delegate(&a, &b);
    assert_eq!(client.get_delegate(&a), Some(b.clone()));
    assert_eq!(client.get_delegated_voting_power(&a), 0);
    assert_eq!(client.get_delegated_voting_power(&b), amount);
    // Raw lock power is unaffected by delegation.
    assert_eq!(client.get_voting_power(&a), amount);

    client.undelegate(&a);
    assert_eq!(client.get_delegate(&a), None);
    assert_eq!(client.get_delegated_voting_power(&a), amount);
    assert_eq!(client.get_delegated_voting_power(&b), 0);
    assert_eq!(client.try_undelegate(&a), Err(Ok(Error::NotDelegated)));
}

#[test]
fn test_self_delegation_rejected() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let amount = 10_000_000_000i128;
    let a = lock_for(&env, &client, &yield_token_client, amount, MAX_TIME);

    assert_eq!(client.try_delegate(&a, &a), Err(Ok(Error::DelegationCycle)));
    assert_eq!(client.get_delegate(&a), None);
    assert_eq!(client.get_delegated_voting_power(&a), amount);
}

#[test]
fn test_two_account_cycle_rejected() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let amount = 10_000_000_000i128;
    let a = lock_for(&env, &client, &yield_token_client, amount, MAX_TIME);
    let b = lock_for(&env, &client, &yield_token_client, amount, MAX_TIME);

    client.delegate(&a, &b);
    assert_eq!(client.try_delegate(&b, &a), Err(Ok(Error::DelegationCycle)));

    // Weights unchanged by the rejected call.
    assert_eq!(client.get_delegate(&b), None);
    assert_eq!(client.get_delegated_voting_power(&b), amount * 2);
    assert_eq!(client.get_delegated_voting_power(&a), 0);
}

#[test]
fn test_multi_account_cycle_rejected() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let amount = 10_000_000_000i128;
    let a = lock_for(&env, &client, &yield_token_client, amount, MAX_TIME);
    let b = lock_for(&env, &client, &yield_token_client, amount, MAX_TIME);
    let c = lock_for(&env, &client, &yield_token_client, amount, MAX_TIME);
    let d = lock_for(&env, &client, &yield_token_client, amount, MAX_TIME);

    // a -> b -> c -> d
    client.delegate(&a, &b);
    client.delegate(&b, &c);
    client.delegate(&c, &d);
    assert_eq!(client.get_delegated_voting_power(&d), amount * 4);

    // Closing the loop from any point downstream is rejected.
    assert_eq!(client.try_delegate(&d, &a), Err(Ok(Error::DelegationCycle)));
    assert_eq!(client.try_delegate(&d, &b), Err(Ok(Error::DelegationCycle)));
    assert_eq!(client.try_delegate(&c, &a), Err(Ok(Error::DelegationCycle)));

    assert_eq!(client.get_delegate(&d), None);
    assert_eq!(client.get_delegated_voting_power(&d), amount * 4);
    for user in [&a, &b, &c] {
        assert_eq!(client.get_delegated_voting_power(user), 0);
    }
}

#[test]
fn test_redelegation_rejects_cycle_and_keeps_previous_delegate() {
    let (env, client, _, _, yield_token_client) = setup_env();
    let amount = 10_000_000_000i128;
    let a = lock_for(&env, &client, &yield_token_client, amount, MAX_TIME);
    let b = lock_for(&env, &client, &yield_token_client, amount, MAX_TIME);
    let c = lock_for(&env, &client, &yield_token_client, amount, MAX_TIME);

    client.delegate(&b, &c);
    client.delegate(&c, &a);
    // b -> c -> a, so a -> b would loop.
    assert_eq!(client.try_delegate(&a, &b), Err(Ok(Error::DelegationCycle)));

    // Moving c's delegation away from a breaks the chain; now a -> b is fine.
    let e = Address::generate(&env);
    client.delegate(&c, &e);
    client.delegate(&a, &b);
    assert_eq!(client.get_delegated_voting_power(&e), amount * 3);
    assert_eq!(client.get_delegated_voting_power(&a), 0);
}

#[test]
fn test_delegation_chain_depth_bounded() {
    let (env, client, _, _, _) = setup_env();
    let max = crate::storage::MAX_DELEGATION_DEPTH as usize;
    let accounts: std::vec::Vec<Address> = (0..=max + 1).map(|_| Address::generate(&env)).collect();

    // A chain of exactly MAX_DELEGATION_DEPTH edges is allowed...
    for i in 0..max {
        client.delegate(&accounts[i], &accounts[i + 1]);
    }
    // ...one more edge on either end is not.
    assert_eq!(
        client.try_delegate(&accounts[max], &accounts[max + 1]),
        Err(Ok(Error::DelegationTooDeep))
    );
    let outsider = Address::generate(&env);
    assert_eq!(
        client.try_delegate(&outsider, &accounts[0]),
        Err(Ok(Error::DelegationTooDeep))
    );
}
