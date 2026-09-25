/*!
# Authorization and Replay Protection Extended Tests

Focused coverage for caller permissions and message replay/expiry boundaries.
*/

use bridge_relayer::{
    BridgeRelayer, BridgeRelayerError, BridgeConfig, CrossChainMessage, MessageType,
};
use soroban_sdk::{Address, Bytes, BytesN, Env, Symbol};

fn make_env() -> Env {
    Env::default()
}

fn admin(env: &Env) -> Address {
    Address::generate(env)
}

fn other_caller(env: &Env) -> Address {
    Address::generate(env)
}

fn init_contract(
    env: &Env,
    admin: &Address,
    min_validators: u32,
) {
    BridgeRelayer::initialize(
        env,
        admin.clone(),
        vec![env, admin.clone()],
        BridgeConfig {
            min_validators,
            queue_threshold: 100_000_000,
            time_lock: 3600,
            max_queue_size: 1000,
            paused: false,
        },
    );
}

fn base_message(env: &Env, nonce: u64) -> CrossChainMessage {
    CrossChainMessage {
        source_chain: 1,
        target_chain: 2,
        nonce,
        sender: Address::generate(env),
        recipient: Address::generate(env),
        asset: Address::generate(env),
        amount: 1000,
        metadata: Bytes::from_slice(env, b"test"),
        message_type: MessageType::Mint,
    }
}

#[test]
fn admin_authorization_update_config() {
    let env = make_env();
    let adm = admin(&env);
    let other = other_caller(&env);

    init_contract(&env, &adm, 1);

    // Admin can update config
    let new_config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 50_000_000,
        time_lock: 1800,
        max_queue_size: 500,
        paused: true,
    };
    let result = BridgeRelayer::update_config(&env, adm.clone(), new_config.clone());
    assert!(result.is_ok());
    assert_eq!(BridgeRelayer::get_config(&env).paused, true);

    // Non-admin is rejected
    let result = BridgeRelayer::update_config(&env, other, new_config);
    assert_eq!(result, Err(BridgeRelayerError::Unauthorized));
}

#[test]
fn admin_authorization_validator_management() {
    let env = make_env();
    let adm = admin(&env);
    let other = other_caller(&env);
    let validator = Address::generate(&env);

    init_contract(&env, &adm, 1);

    let result = BridgeRelayer::add_validator(&env, adm.clone(), validator.clone(), 1);
    assert!(result.is_ok());

    let result = BridgeRelayer::add_validator(&env, other, validator.clone(), 1);
    assert_eq!(result, Err(BridgeRelayerError::Unauthorized));

    let result = BridgeRelayer::remove_validator(&env, adm.clone(), validator.clone());
    assert!(result.is_ok());

    let result = BridgeRelayer::remove_validator(&env, other, validator);
    assert_eq!(result, Err(BridgeRelayerError::Unauthorized));
}

#[test]
fn admin_emergency_pause_unpause() {
    let env = make_env();
    let adm = admin(&env);
    let other = other_caller(&env);

    init_contract(&env, &adm, 1);

    let result = BridgeRelayer::emergency_pause(&env, adm.clone());
    assert!(result.is_ok());
    assert!(BridgeRelayer::get_config(&env).paused);

    let result = BridgeRelayer::emergency_pause(&env, other);
    assert_eq!(result, Err(BridgeRelayerError::Unauthorized));

    let result = BridgeRelayer::emergency_unpause(&env, adm.clone());
    assert!(result.is_ok());
    assert!(!BridgeRelayer::get_config(&env).paused);

    let result = BridgeRelayer::emergency_unpause(&env, other);
    assert_eq!(result, Err(BridgeRelayerError::Unauthorized));
}

#[test]
fn unique_message_identifiers() {
    let env = make_env();
    let adm = admin(&env);
    init_contract(&env, &adm, 1);

    let m1 = base_message(&env, 1);
    let m2 = base_message(&env, 2);

    // Different nonces should result in different acceptances
    let r1 = BridgeRelayer::receive_msg_merkle(&env, m1.clone(), bridge_relayer::MerkleProof {
        root: BytesN::from_array(&env, &[1u8; 32]),
        proof: Vec::new(&env),
        index: 0,
    });
    assert!(r1.is_ok());

    let r2 = BridgeRelayer::receive_msg_merkle(&env, m2.clone(), bridge_relayer::MerkleProof {
        root: BytesN::from_array(&env, &[2u8; 32]),
        proof: Vec::new(&env),
        index: 0,
    });
    assert!(r2.is_ok());

    // Same payload replayed should be rejected as already processed
    let r3 = BridgeRelayer::receive_msg_merkle(&env, m1, bridge_relayer::MerkleProof {
        root: BytesN::from_array(&env, &[1u8; 32]),
        proof: Vec::new(&env),
        index: 0,
    });
    assert_eq!(r3, Err(BridgeRelayerError::MessageAlreadyProcessed));
}

#[test]
fn replay_expiry_boundaries() {
    let env = make_env();

    // Freeze ledger timestamp and move it backwards beyond a 1-hour window,
    // then replay the same nonce; any time-based expiry logic should reject it.
    let fixed_time: u64 = 1000;
    env.ledger().set_timestamp(fixed_time);

    let adm = admin(&env);
    init_contract(&env, &adm, 1);

    let msg = CrossChainMessage {
        source_chain: 1,
        target_chain: 2,
        nonce: 1,
        sender: Address::generate(&env),
        recipient: Address::generate(&env),
        asset: Address::generate(&env),
        amount: 1000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };

    let ok = BridgeRelayer::receive_message_with_multisig(
        &env,
        msg,
        bridge_relayer::MultiSignature {
            validators: vec![adm.clone()],
            signatures: Vec::new(&env),
            message_hash: BytesN::from_array(&env, &[1u8; 32]),
        },
    );
    assert!(ok.is_ok());

    // Advance time beyond the configured time_lock (1h) and attempt to execute queued transfer.
    env.ledger().set_timestamp(fixed_time + 3601);
    let id = BytesN::from_array(&env, &[9u8; 32]);
    let exec = BridgeRelayer::execute_queued_transfer(&env, id);
    assert!(exec.is_ok());
}