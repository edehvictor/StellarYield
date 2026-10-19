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

// ── Historical lock state (#1513) ─────────────────────────────────

const AMOUNT: i128 = 10_000_000_000;

fn lock_tokens(
    env: &Env,
    client: &VeTokenomicsClient<'static>,
    tokens: &token::StellarAssetClient<'static>,
    user: &Address,
    amount: i128,
    weeks: u64,
) {
    tokens.mint(user, &amount);
    let unlock = env.ledger().timestamp() + weeks * WEEK;
    client.create_lock(user, &amount, &unlock);
}

#[test]
fn test_voting_power_at_matches_the_power_held_then() {
    let (env, client, _, _, tokens) = setup_env();
    let user = Address::generate(&env);
    let created = env.ledger().timestamp();
    lock_tokens(&env, &client, &tokens, &user, AMOUNT, 52);
    let power_then = client.get_voting_power(&user);

    env.ledger().set_timestamp(created + 10 * WEEK);
    tokens.mint(&user, &AMOUNT);
    client.increase_amount(&user, &AMOUNT);

    // History is unchanged by the later deposit.
    assert_eq!(client.get_voting_power_at(&user, &created), power_then);
    assert_eq!(
        client.get_lock_at(&user, &created),
        Some(UserLock {
            amount: AMOUNT,
            end: created + 52 * WEEK,
        })
    );
    // Power at a time in between decays along the original lock.
    let mid = created + 5 * WEEK;
    assert_eq!(
        client.get_voting_power_at(&user, &mid),
        calculate_voting_power(AMOUNT, created + 52 * WEEK, mid)
    );
    // And the current figure uses the larger lock.
    assert_eq!(
        client.get_voting_power_at(&user, &(created + 10 * WEEK)),
        client.get_voting_power(&user)
    );
}

#[test]
fn test_no_power_before_the_lock_existed() {
    let (env, client, _, _, tokens) = setup_env();
    let user = Address::generate(&env);
    let before = env.ledger().timestamp();
    env.ledger().set_timestamp(before + 100);
    lock_tokens(&env, &client, &tokens, &user, AMOUNT, 4);

    assert_eq!(client.get_voting_power_at(&user, &before), 0);
    assert_eq!(client.get_lock_at(&user, &before), None);
    assert_eq!(client.get_total_locked_at(&before), 0);
    assert!(client.get_voting_power_at(&user, &(before + 100)) > 0);
}

#[test]
fn test_power_survives_in_history_after_withdrawal() {
    let (env, client, _, _, tokens) = setup_env();
    let user = Address::generate(&env);
    let created = env.ledger().timestamp();
    lock_tokens(&env, &client, &tokens, &user, AMOUNT, 2);
    let power_then = client.get_voting_power(&user);

    env.ledger().set_timestamp(created + 2 * WEEK + 1);
    client.withdraw(&user);

    assert_eq!(client.get_voting_power(&user), 0);
    assert_eq!(client.get_voting_power_at(&user, &created), power_then);
    assert_eq!(client.get_lock_at(&user, &(created + 2 * WEEK + 1)), None);
    assert_eq!(
        client.get_voting_power_at(&user, &(created + 2 * WEEK + 1)),
        0
    );
    assert_eq!(client.get_total_locked_at(&created), AMOUNT);
    assert_eq!(client.get_total_locked_at(&(created + 2 * WEEK + 1)), 0);
}

#[test]
fn test_extending_a_lock_does_not_change_the_past() {
    let (env, client, _, _, tokens) = setup_env();
    let user = Address::generate(&env);
    let created = env.ledger().timestamp();
    lock_tokens(&env, &client, &tokens, &user, AMOUNT, 4);
    let power_then = client.get_voting_power_at(&user, &created);

    env.ledger().set_timestamp(created + WEEK);
    client.increase_unlock_time(&user, &(created + 40 * WEEK));

    assert_eq!(client.get_voting_power_at(&user, &created), power_then);
    assert!(client.get_voting_power_at(&user, &(created + WEEK)) > power_then / 2);
}

#[test]
fn test_changes_within_one_second_share_a_checkpoint() {
    let (env, client, _, _, tokens) = setup_env();
    let user = Address::generate(&env);
    let now = env.ledger().timestamp();
    lock_tokens(&env, &client, &tokens, &user, AMOUNT, 4);
    tokens.mint(&user, &AMOUNT);
    client.increase_amount(&user, &AMOUNT);

    // The state at the end of that second is what is reported.
    assert_eq!(client.get_lock_at(&user, &now).unwrap().amount, 2 * AMOUNT);
    assert_eq!(client.get_total_locked_at(&now), 2 * AMOUNT);
    env.as_contract(&client.address, || {
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserCheckpointCount(user.clone()))
            .unwrap();
        assert_eq!(count, 1);
    });
}

#[test]
fn test_future_timestamps_are_rejected() {
    let (env, client, _, _, _) = setup_env();
    let user = Address::generate(&env);
    let future = env.ledger().timestamp() + 1;

    assert_eq!(
        client.try_get_voting_power_at(&user, &future),
        Err(Ok(Error::FutureTimestamp))
    );
    assert_eq!(
        client.try_get_lock_at(&user, &future),
        Err(Ok(Error::FutureTimestamp))
    );
    assert_eq!(
        client.try_get_total_locked_at(&future),
        Err(Ok(Error::FutureTimestamp))
    );
}

#[test]
fn test_total_locked_history_tracks_every_account() {
    let (env, client, _, _, tokens) = setup_env();
    let (a, b) = (Address::generate(&env), Address::generate(&env));
    let t0 = env.ledger().timestamp();
    lock_tokens(&env, &client, &tokens, &a, AMOUNT, 4);
    env.ledger().set_timestamp(t0 + 100);
    lock_tokens(&env, &client, &tokens, &b, 3 * AMOUNT, 4);

    assert_eq!(client.get_total_locked_at(&t0), AMOUNT);
    assert_eq!(client.get_total_locked_at(&(t0 + 99)), AMOUNT);
    assert_eq!(client.get_total_locked_at(&(t0 + 100)), 4 * AMOUNT);
    assert_eq!(client.get_total_locked(), 4 * AMOUNT);
}

#[test]
fn test_a_lock_made_before_checkpoints_existed_keeps_its_history() {
    let (env, client, _, yield_token, tokens) = setup_env();
    let user = Address::generate(&env);
    let created = env.ledger().timestamp();
    let unlock = created + 20 * WEEK;
    // Recreate the state an older version of the contract left behind: a lock
    // and a total, but no checkpoints.
    tokens.mint(&client.address, &AMOUNT);
    env.as_contract(&client.address, || {
        env.storage().persistent().set(
            &DataKey::UserLock(user.clone()),
            &UserLock {
                amount: AMOUNT,
                end: unlock,
            },
        );
        env.storage().instance().set(&DataKey::TotalLocked, &AMOUNT);
    });
    let _ = yield_token;

    // Until it changes, history is the lock as it stands.
    assert_eq!(client.get_lock_at(&user, &created).unwrap().amount, AMOUNT);
    assert_eq!(client.get_total_locked_at(&created), AMOUNT);

    env.ledger().set_timestamp(created + WEEK);
    tokens.mint(&user, &AMOUNT);
    client.increase_amount(&user, &AMOUNT);

    // The first change records what came before it.
    assert_eq!(client.get_lock_at(&user, &created).unwrap().amount, AMOUNT);
    assert_eq!(client.get_total_locked_at(&created), AMOUNT);
    assert_eq!(
        client.get_lock_at(&user, &(created + WEEK)).unwrap().amount,
        2 * AMOUNT
    );
    assert_eq!(client.get_total_locked_at(&(created + WEEK)), 2 * AMOUNT);
}

// ── Fee distribution claims (#1514) ───────────────────────────────

fn epoch_start(epoch: u64) -> u64 {
    epoch * WEEK
}

fn go_to_epoch(env: &Env, epoch: u64) {
    env.ledger().set_timestamp(epoch_start(epoch) + 100);
}

fn deposit(
    env: &Env,
    client: &VeTokenomicsClient<'static>,
    tokens: &token::StellarAssetClient<'static>,
    amount: i128,
) {
    let depositor = Address::generate(env);
    tokens.mint(&depositor, &amount);
    client.deposit_fees(&depositor, &amount);
}

fn balance(env: &Env, token_addr: &Address, who: &Address) -> i128 {
    token::Client::new(env, token_addr).balance(who)
}

/// Two lockers (1:3) who locked before epoch 5 starts, with the clock in epoch 5.
fn two_lockers() -> (
    Env,
    VeTokenomicsClient<'static>,
    Address,
    token::StellarAssetClient<'static>,
    Address,
    Address,
) {
    let (env, client, _, yield_token, tokens) = setup_env();
    let (a, b) = (Address::generate(&env), Address::generate(&env));
    go_to_epoch(&env, 3);
    lock_tokens(&env, &client, &tokens, &a, AMOUNT, 100);
    lock_tokens(&env, &client, &tokens, &b, 3 * AMOUNT, 100);
    go_to_epoch(&env, 5);
    (env, client, yield_token, tokens, a, b)
}

#[test]
fn test_fees_are_shared_by_the_amount_locked_when_the_epoch_began() {
    let (env, client, yield_token, tokens, a, b) = two_lockers();
    deposit(&env, &client, &tokens, 4_000);
    deposit(&env, &client, &tokens, 400);
    assert_eq!(client.get_epoch_fees(&5), 4_400);

    go_to_epoch(&env, 6);
    assert_eq!(client.get_unclaimed_fees(&a, &5, &5), 1_100);
    assert_eq!(client.claim_fees(&a, &5, &5), 1_100);
    assert_eq!(client.claim_fees(&b, &5, &5), 3_300);

    assert_eq!(balance(&env, &yield_token, &a), 1_100);
    assert_eq!(balance(&env, &yield_token, &b), 3_300);
    assert_eq!(client.get_claimed_fees(&a, &5), 1_100);
    assert_eq!(client.get_epoch_fees_claimed(&5), 4_400);
}

#[test]
fn test_fees_cannot_be_claimed_until_the_epoch_has_ended() {
    let (env, client, _, tokens, a, _) = two_lockers();
    deposit(&env, &client, &tokens, 4_000);

    assert_eq!(
        client.try_claim_fees(&a, &5, &5),
        Err(Ok(Error::EpochNotFinished))
    );
    assert_eq!(client.get_unclaimed_fees(&a, &5, &5), 0);
    go_to_epoch(&env, 6);
    assert_eq!(client.claim_fees(&a, &5, &5), 1_000);
}

#[test]
fn test_an_epoch_cannot_be_claimed_twice() {
    let (env, client, yield_token, tokens, a, _) = two_lockers();
    deposit(&env, &client, &tokens, 4_000);
    go_to_epoch(&env, 6);

    client.claim_fees(&a, &5, &5);

    assert!(client.has_claimed_fees(&a, &5));
    assert_eq!(
        client.try_claim_fees(&a, &5, &5),
        Err(Ok(Error::NothingToClaim))
    );
    assert_eq!(client.get_unclaimed_fees(&a, &5, &5), 0);
    assert_eq!(balance(&env, &yield_token, &a), 1_000);
}

#[test]
fn test_overlapping_claim_ranges_pay_each_epoch_once() {
    let (env, client, yield_token, tokens, a, _) = two_lockers();
    deposit(&env, &client, &tokens, 4_000); // epoch 5
    go_to_epoch(&env, 6);
    deposit(&env, &client, &tokens, 8_000); // epoch 6
    go_to_epoch(&env, 7);
    deposit(&env, &client, &tokens, 12_000); // epoch 7
    go_to_epoch(&env, 8);

    // Epochs 5 and 6, then 6 and 7: epoch 6 must not be paid a second time.
    assert_eq!(client.claim_fees(&a, &5, &6), 1_000 + 2_000);
    assert_eq!(client.get_unclaimed_fees(&a, &6, &7), 3_000);
    assert_eq!(client.claim_fees(&a, &6, &7), 3_000);
    // The whole range is now spent.
    assert_eq!(client.get_unclaimed_fees(&a, &5, &7), 0);
    assert_eq!(
        client.try_claim_fees(&a, &5, &7),
        Err(Ok(Error::NothingToClaim))
    );
    assert_eq!(balance(&env, &yield_token, &a), 1_000 + 2_000 + 3_000);
}

#[test]
fn test_partial_claims_leave_the_rest_claimable() {
    let (env, client, yield_token, tokens, a, _) = two_lockers();
    deposit(&env, &client, &tokens, 4_000); // epoch 5
    go_to_epoch(&env, 6);
    deposit(&env, &client, &tokens, 8_000); // epoch 6
    go_to_epoch(&env, 7);
    deposit(&env, &client, &tokens, 12_000); // epoch 7
    go_to_epoch(&env, 8);

    // Claim only the middle epoch.
    assert_eq!(client.claim_fees(&a, &6, &6), 2_000);
    assert!(client.has_claimed_fees(&a, &6));
    assert!(!client.has_claimed_fees(&a, &5));
    assert_eq!(client.get_unclaimed_fees(&a, &5, &7), 1_000 + 3_000);

    // A claim over everything pays the epochs that are left.
    assert_eq!(client.claim_fees(&a, &5, &7), 1_000 + 3_000);
    assert_eq!(balance(&env, &yield_token, &a), 6_000);
}

#[test]
fn test_claims_by_one_locker_do_not_affect_another() {
    let (env, client, _, tokens, a, b) = two_lockers();
    deposit(&env, &client, &tokens, 4_000);
    go_to_epoch(&env, 6);

    client.claim_fees(&a, &5, &5);

    assert!(!client.has_claimed_fees(&b, &5));
    assert_eq!(client.get_unclaimed_fees(&b, &5, &5), 3_000);
    assert_eq!(client.claim_fees(&b, &5, &5), 3_000);
}

#[test]
fn test_locking_after_an_epoch_began_earns_nothing_from_it() {
    let (env, client, _, tokens, a, _) = two_lockers();
    let latecomer = Address::generate(&env);
    // Epoch 5 is under way and the latecomer joins with a huge lock.
    lock_tokens(&env, &client, &tokens, &latecomer, 100 * AMOUNT, 100);
    deposit(&env, &client, &tokens, 4_000);
    go_to_epoch(&env, 6);

    assert_eq!(client.get_unclaimed_fees(&latecomer, &5, &5), 0);
    assert_eq!(
        client.try_claim_fees(&latecomer, &5, &5),
        Err(Ok(Error::NothingToClaim))
    );
    // The existing lockers still split the whole epoch.
    assert_eq!(client.claim_fees(&a, &5, &5), 1_000);

    // From the next epoch on the latecomer shares in the fees.
    deposit(&env, &client, &tokens, 10_400);
    go_to_epoch(&env, 7);
    assert_eq!(client.claim_fees(&latecomer, &6, &6), 10_000);
}

#[test]
fn test_each_epoch_uses_the_amount_locked_at_its_own_start() {
    let (env, client, _, tokens, a, b) = two_lockers();
    deposit(&env, &client, &tokens, 4_000); // epoch 5: a 1/4, b 3/4

    go_to_epoch(&env, 6);
    // `a` triples their lock during epoch 6, which only counts from epoch 7.
    tokens.mint(&a, &(2 * AMOUNT));
    client.increase_amount(&a, &(2 * AMOUNT));
    deposit(&env, &client, &tokens, 6_000); // epoch 6: still 1/4 and 3/4

    go_to_epoch(&env, 7);
    deposit(&env, &client, &tokens, 6_000); // epoch 7: 3/6 and 3/6
    go_to_epoch(&env, 8);

    assert_eq!(client.claim_fees(&a, &5, &7), 1_000 + 1_500 + 3_000);
    assert_eq!(client.claim_fees(&b, &5, &7), 3_000 + 4_500 + 3_000);
}

#[test]
fn test_fees_can_still_be_claimed_after_withdrawing_the_lock() {
    let (env, client, _, tokens, a, _) = two_lockers();
    deposit(&env, &client, &tokens, 4_000);

    // The lock ends and is withdrawn in epoch 7, after the epoch-5 deposit.
    env.ledger()
        .set_timestamp(epoch_start(3) + 100 + 100 * WEEK + 1);
    client.withdraw(&a);
    assert_eq!(client.get_lock(&a), None);

    assert_eq!(client.claim_fees(&a, &5, &5), 1_000);
}

#[test]
fn test_rounding_never_pays_out_more_than_was_deposited() {
    let (env, client, yield_token, tokens, a, b) = two_lockers();
    let c = Address::generate(&env);
    go_to_epoch(&env, 4);
    lock_tokens(&env, &client, &tokens, &c, AMOUNT, 100);
    go_to_epoch(&env, 5);
    // 1 : 3 : 1 of 10 tokens is 2 / 6 / 2, but 7 does not divide evenly.
    deposit(&env, &client, &tokens, 7);
    go_to_epoch(&env, 6);

    let paid = client.claim_fees(&a, &5, &5)
        + client.claim_fees(&b, &5, &5)
        + client
            .try_claim_fees(&c, &5, &5)
            .unwrap_or(Ok(0))
            .unwrap_or(0);

    assert!(paid <= 7);
    assert_eq!(client.get_epoch_fees_claimed(&5), paid);
    assert_eq!(balance(&env, &yield_token, &a), 1);
}

#[test]
fn test_epochs_without_fees_or_lockers_pay_nothing() {
    let (env, client, _, tokens, a, _) = two_lockers();
    go_to_epoch(&env, 6);
    // No fees were deposited in epoch 5.
    assert_eq!(
        client.try_claim_fees(&a, &5, &5),
        Err(Ok(Error::NothingToClaim))
    );

    // Fees deposited when nobody had locked anything are not claimable.
    let (env2, client2, _, _, tokens2) = setup_env();
    go_to_epoch(&env2, 5);
    deposit(&env2, &client2, &tokens2, 1_000);
    go_to_epoch(&env2, 6);
    let stranger = Address::generate(&env2);
    assert_eq!(
        client2.try_claim_fees(&stranger, &5, &5),
        Err(Ok(Error::NothingToClaim))
    );
    let _ = tokens;
}

#[test]
fn test_invalid_claim_ranges_are_rejected() {
    let (env, client, _, _, a, _) = {
        let (env, client, yield_token, tokens, a, b) = two_lockers();
        (env, client, yield_token, tokens, a, b)
    };
    go_to_epoch(&env, 100);

    assert_eq!(
        client.try_claim_fees(&a, &6, &5),
        Err(Ok(Error::InvalidEpochRange))
    );
    assert_eq!(
        client.try_claim_fees(&a, &5, &(5 + MAX_CLAIM_EPOCHS)),
        Err(Ok(Error::InvalidEpochRange))
    );
    assert_eq!(
        client.try_get_unclaimed_fees(&a, &5, &(5 + MAX_CLAIM_EPOCHS)),
        Err(Ok(Error::InvalidEpochRange))
    );
    // Exactly MAX_CLAIM_EPOCHS epochs is fine.
    assert_eq!(
        client.try_claim_fees(&a, &5, &(4 + MAX_CLAIM_EPOCHS)),
        Err(Ok(Error::NothingToClaim))
    );
}

#[test]
fn test_deposits_must_be_positive_and_are_held_by_the_contract() {
    let (env, client, _, yield_token, tokens) = setup_env();
    let depositor = Address::generate(&env);
    tokens.mint(&depositor, &500);

    assert_eq!(
        client.try_deposit_fees(&depositor, &0),
        Err(Ok(Error::ZeroAmount))
    );
    client.deposit_fees(&depositor, &500);

    assert_eq!(balance(&env, &yield_token, &depositor), 0);
    assert_eq!(balance(&env, &yield_token, &client.address), 500);
    assert_eq!(client.get_epoch_fees(&client.get_current_epoch()), 500);
    // Fees are not counted as locked tokens.
    assert_eq!(client.get_total_locked(), 0);
}

#[test]
fn test_fee_claims_need_authorization() {
    let (env, client, _, tokens, a, _) = two_lockers();
    deposit(&env, &client, &tokens, 4_000);
    go_to_epoch(&env, 6);
    env.set_auths(&[]);

    assert!(client.try_claim_fees(&a, &5, &5).is_err());
}
