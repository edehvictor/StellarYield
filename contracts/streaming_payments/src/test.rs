use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env, Symbol, Val,
};

fn mint_stellar_asset(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
    soroban_sdk::token::StellarAssetClient::new(env, token_addr).mint(to, &amount);
}

fn setup_env() -> (
    Env,
    StreamingPaymentsClient<'static>,
    Address, // sender
    Address, // recipient
    Address, // token
    Address, // token_admin
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(StreamingPayments, ());
    let client = StreamingPaymentsClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = token_contract.address();

    (env, client, sender, recipient, token_addr, token_admin)
}

#[test]
fn test_create_stream_success() {
    let (env, client, sender, recipient, token_addr, _) = setup_env();
    let start_time: u64 = 100;
    let end_time: u64 = 200;
    let total_amount: i128 = 1200;

    env.ledger().set_timestamp(50);
    mint_stellar_asset(&env, &token_addr, &sender, total_amount);

    let stream_id = client.create_stream(
        &sender,
        &recipient,
        &token_addr,
        &start_time,
        &end_time,
        &total_amount,
    );

    assert_eq!(stream_id, 1);
    let stream = client.get_stream(&stream_id);
    assert_eq!(stream.sender, sender);
    assert_eq!(stream.recipient, recipient);
    assert_eq!(stream.token, token_addr);
    assert_eq!(stream.start_time, start_time);
    assert_eq!(stream.end_time, end_time);
    assert_eq!(stream.total_amount, total_amount);
    assert_eq!(stream.withdrawn_amount, 0);
    assert!(!stream.cancelled);

    let token_client = token::Client::new(&env, &token_addr);
    assert_eq!(token_client.balance(&sender), 0);
    assert_eq!(token_client.balance(&client.address), total_amount);
}

#[test]
fn test_withdraw_unlocks_linearly() {
    let (env, client, sender, recipient, token_addr, _) = setup_env();
    let start_time: u64 = 100;
    let end_time: u64 = 200;
    let total_amount: i128 = 1200;

    env.ledger().set_timestamp(50);
    mint_stellar_asset(&env, &token_addr, &sender, total_amount);

    let stream_id = client.create_stream(
        &sender,
        &recipient,
        &token_addr,
        &start_time,
        &end_time,
        &total_amount,
    );

    let token_client = token::Client::new(&env, &token_addr);

    // At t=150: elapsed 50/100 => 600 unlocked.
    env.ledger().set_timestamp(150);
    assert_eq!(
        client.get_withdrawable_amount(&stream_id),
        600,
        "withdrawable should match linear formula"
    );
    let got1 = client.withdraw_from_stream(&recipient, &stream_id);
    assert_eq!(got1, 600);
    assert_eq!(token_client.balance(&recipient), 600);

    // Withdraw again at same timestamp: no new unlock.
    let got1b = client.withdraw_from_stream(&recipient, &stream_id);
    assert_eq!(got1b, 0);

    // At t=160: elapsed 60/100 => 720 total unlocked; new = 120.
    env.ledger().set_timestamp(160);
    assert_eq!(client.get_withdrawable_amount(&stream_id), 120);
    let got2 = client.withdraw_from_stream(&recipient, &stream_id);
    assert_eq!(got2, 120);
    assert_eq!(token_client.balance(&recipient), 720);

    // Final at t=end_time.
    env.ledger().set_timestamp(200);
    assert_eq!(client.get_withdrawable_amount(&stream_id), 480);
    let got3 = client.withdraw_from_stream(&recipient, &stream_id);
    assert_eq!(got3, 480);
    assert_eq!(token_client.balance(&recipient), total_amount);
    assert_eq!(token_client.balance(&client.address), 0);
}

#[test]
fn test_cancel_refunds_remaining_and_locks_unlock_schedule() {
    let (env, client, sender, recipient, token_addr, _) = setup_env();
    let start_time: u64 = 100;
    let end_time: u64 = 200;
    let total_amount: i128 = 1200;

    env.ledger().set_timestamp(50);
    mint_stellar_asset(&env, &token_addr, &sender, total_amount);

    let stream_id = client.create_stream(
        &sender,
        &recipient,
        &token_addr,
        &start_time,
        &end_time,
        &total_amount,
    );

    let token_client = token::Client::new(&env, &token_addr);

    // Cancel at t=160.
    env.ledger().set_timestamp(160);
    let refunded = client.cancel_stream(&sender, &stream_id);
    assert_eq!(
        refunded, 480,
        "refund should equal total - unlocked_total(160)"
    );

    assert_eq!(token_client.balance(&sender), 480);
    assert_eq!(token_client.balance(&client.address), 720);

    // Even after time passes, unlocked total is capped at cancel_time.
    env.ledger().set_timestamp(180);
    assert_eq!(client.get_withdrawable_amount(&stream_id), 720);
    let got = client.withdraw_from_stream(&recipient, &stream_id);
    assert_eq!(got, 720);
    assert_eq!(token_client.balance(&recipient), 720);
    assert_eq!(token_client.balance(&client.address), 0);
}

#[test]
fn test_cancel_after_partial_withdraw_only_refunds_once() {
    let (env, client, sender, recipient, token_addr, _) = setup_env();
    let start_time: u64 = 100;
    let end_time: u64 = 200;
    let total_amount: i128 = 1200;

    env.ledger().set_timestamp(50);
    mint_stellar_asset(&env, &token_addr, &sender, total_amount);

    let stream_id = client.create_stream(
        &sender,
        &recipient,
        &token_addr,
        &start_time,
        &end_time,
        &total_amount,
    );

    let token_client = token::Client::new(&env, &token_addr);

    // Withdraw some at t=150: unlocked=600.
    env.ledger().set_timestamp(150);
    assert_eq!(client.get_withdrawable_amount(&stream_id), 600);
    let got1 = client.withdraw_from_stream(&recipient, &stream_id);
    assert_eq!(got1, 600);
    assert_eq!(token_client.balance(&recipient), 600);

    // Cancel at t=160:
    // unlocked_total(160)=720, withdrawn_amount=600, refund=total-unlocked_total=480.
    env.ledger().set_timestamp(160);
    let refunded = client.cancel_stream(&sender, &stream_id);
    assert_eq!(refunded, 480);

    // Idempotent cancel: second cancel returns 0.
    let refunded2 = client.cancel_stream(&sender, &stream_id);
    assert_eq!(refunded2, 0);

    // Withdraw remainder at later timestamps.
    env.ledger().set_timestamp(180);
    assert_eq!(client.get_withdrawable_amount(&stream_id), 120);
    let got2 = client.withdraw_from_stream(&recipient, &stream_id);
    assert_eq!(got2, 120);
    assert_eq!(token_client.balance(&recipient), 720);
    assert_eq!(token_client.balance(&client.address), 0);

    // Further withdraws unlock nothing after cancellation.
    env.ledger().set_timestamp(200);
    let got3 = client.withdraw_from_stream(&recipient, &stream_id);
    assert_eq!(got3, 0);
}

#[test]
fn test_cancel_before_start_refunds_full_amount_and_allows_zero_withdraw() {
    let (env, client, sender, recipient, token_addr, _) = setup_env();
    let start_time: u64 = 200;
    let end_time: u64 = 300;
    let total_amount: i128 = 1200;

    env.ledger().set_timestamp(100);
    mint_stellar_asset(&env, &token_addr, &sender, total_amount);

    let stream_id = client.create_stream(
        &sender,
        &recipient,
        &token_addr,
        &start_time,
        &end_time,
        &total_amount,
    );

    // Cancel at t=150 (< start_time): unlocked_total is 0 => refund full amount.
    env.ledger().set_timestamp(150);
    let refunded = client.cancel_stream(&sender, &stream_id);
    assert_eq!(refunded, total_amount);

    let token_client = token::Client::new(&env, &token_addr);
    assert_eq!(token_client.balance(&sender), total_amount);
    assert_eq!(token_client.balance(&client.address), 0);

    // Recipient withdraws after cancellation but should get nothing.
    env.ledger().set_timestamp(180);
    assert_eq!(client.get_withdrawable_amount(&stream_id), 0);
    let got = client.withdraw_from_stream(&recipient, &stream_id);
    assert_eq!(got, 0);
}

#[test]
fn test_invalid_time_and_zero_amount_rejected() {
    let (env, client, sender, recipient, token_addr, _) = setup_env();
    mint_stellar_asset(&env, &token_addr, &sender, 1000);

    // end_time == start_time
    let res = client.try_create_stream(&sender, &recipient, &token_addr, &100u64, &100u64, &1i128);
    assert!(res.is_err());

    // total_amount == 0
    let res2 = client.try_create_stream(&sender, &recipient, &token_addr, &100u64, &101u64, &0i128);
    assert!(res2.is_err());
}

#[test]
fn test_withdraw_and_cancel_unauthorized_rejected() {
    let (env, client, sender, recipient, token_addr, _) = setup_env();
    let start_time: u64 = 100;
    let end_time: u64 = 200;
    let total_amount: i128 = 1200;

    env.ledger().set_timestamp(50);
    mint_stellar_asset(&env, &token_addr, &sender, total_amount);

    let stream_id = client.create_stream(
        &sender,
        &recipient,
        &token_addr,
        &start_time,
        &end_time,
        &total_amount,
    );

    let other = Address::generate(&env);
    let withdraw_res = client.try_withdraw_from_stream(&other, &stream_id);
    assert!(withdraw_res.is_err());

    let cancel_res = client.try_cancel_stream(&other, &stream_id);
    assert!(cancel_res.is_err());
}

// ── Re-entrancy tests ─────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
enum TokenBalanceKey {
    Balance(Address),
}

#[contracttype]
#[derive(Clone)]
enum TokenInstanceKey {
    CallbackRecipient,
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        if amount <= 0 {
            return;
        }
        let key = TokenBalanceKey::Balance(to.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0i128);
        if let Some(new_bal) = bal.checked_add(amount) {
            env.storage().persistent().set(&key, &new_bal);
        }
    }

    pub fn balance(env: Env, owner: Address) -> i128 {
        let key = TokenBalanceKey::Balance(owner.clone());
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    pub fn set_callback_recipient(env: Env, recipient: Address) {
        env.storage()
            .instance()
            .set(&TokenInstanceKey::CallbackRecipient, &recipient);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        if amount <= 0 {
            return;
        }

        let from_key = TokenBalanceKey::Balance(from.clone());
        let from_bal = env.storage().persistent().get(&from_key).unwrap_or(0);
        if from_bal < amount {
            return;
        }

        // Invoke receiver callback BEFORE the balances are updated.
        let callback_opt: Option<Address> = env
            .storage()
            .instance()
            .get(&TokenInstanceKey::CallbackRecipient);
        if let Some(callback) = callback_opt {
            if to == callback {
                let args: soroban_sdk::Vec<Val> = soroban_sdk::Vec::new(&env);
                env.invoke_contract::<()>(&to, &Symbol::new(&env, "on_token_received"), args);
            }
        }

        env.storage()
            .persistent()
            .set(&from_key, &from_bal.checked_sub(amount).unwrap_or(0));
        let to_key = TokenBalanceKey::Balance(to.clone());
        let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0i128);
        if let Some(new_to_bal) = to_bal.checked_add(amount) {
            env.storage().persistent().set(&to_key, &new_to_bal);
        }
    }
}

#[contracttype]
#[derive(Clone)]
enum ReceiverInstanceKey {
    StreamingContract,
    StreamId,
}

#[contract]
pub struct ReentrantReceiver;

#[contractimpl]
impl ReentrantReceiver {
    pub fn initialize(env: Env, streaming_contract: Address, stream_id: u64) {
        env.storage()
            .instance()
            .set(&ReceiverInstanceKey::StreamingContract, &streaming_contract);
        env.storage()
            .instance()
            .set(&ReceiverInstanceKey::StreamId, &stream_id);
    }

    pub fn on_token_received(env: Env) {
        let streaming_opt: Option<Address> = env
            .storage()
            .instance()
            .get(&ReceiverInstanceKey::StreamingContract);
        let stream_id_opt: Option<u64> =
            env.storage().instance().get(&ReceiverInstanceKey::StreamId);

        if let (Some(streaming), Some(stream_id)) = (streaming_opt, stream_id_opt) {
            let my_addr = env.current_contract_address();
            let client = StreamingPaymentsClient::new(&env, &streaming);

            // Second call attempt must fail due to the withdrawal guard.
            client.withdraw_from_stream(&my_addr, &stream_id);
        }
    }
}

#[test]
fn test_withdraw_reentrancy_is_blocked() {
    let env = Env::default();
    env.mock_all_auths();

    let streaming_contract_id = env.register(StreamingPayments, ());
    let streaming_client = StreamingPaymentsClient::new(&env, &streaming_contract_id);

    let sender = Address::generate(&env);
    let receiver_contract_id = env.register(ReentrantReceiver, ());

    let token_contract_id = env.register(MockToken, ());
    let token_client = MockTokenClient::new(&env, &token_contract_id);
    let receiver_client = ReentrantReceiverClient::new(&env, &receiver_contract_id);

    let start_time: u64 = 100;
    let end_time: u64 = 200;
    let total_amount: i128 = 1200;

    // Mint tokens to sender and configure the token callback target.
    token_client.mint(&sender, &total_amount);
    token_client.set_callback_recipient(&receiver_contract_id);

    env.ledger().set_timestamp(50);
    let stream_id = streaming_client.create_stream(
        &sender,
        &receiver_contract_id,
        &token_contract_id,
        &start_time,
        &end_time,
        &total_amount,
    );

    receiver_client.initialize(&streaming_contract_id, &stream_id);

    // Move to an unlock point.
    env.ledger().set_timestamp(150);
    assert_eq!(streaming_client.get_withdrawable_amount(&stream_id), 600);

    // The receiver callback tries to withdraw again while the first withdraw
    // is mid-transfer; the re-entrancy guard must block it.
    let res = streaming_client.try_withdraw_from_stream(&receiver_contract_id, &stream_id);
    assert!(res.is_err());

    // Transaction reverted: withdrawn accounting and balances should be unchanged.
    assert_eq!(streaming_client.get_withdrawable_amount(&stream_id), 600);
    assert_eq!(
        token_client.balance(&streaming_client.address),
        total_amount
    );
    assert_eq!(token_client.balance(&sender), 0);
}
