/*!
# Signer Quorum Progress Tests (#1310)

Covers `get_quorum_progress`: signed/required/remaining counts, progress in
basis points, met flag, and per-signer status for active validators.
*/

use bridge_relayer::{
    BridgeConfig, BridgeRelayer, BridgeRelayerClient, MultiSignature, DEFAULT_QUEUE_THRESHOLD,
    DEFAULT_TIME_LOCK, MAX_QUEUE_SIZE,
};
use soroban_sdk::testutils::Address as TestAddress;
use soroban_sdk::{vec, Address, Bytes, BytesN, Env, Vec};

fn setup() -> (Env, BridgeRelayerClient<'static>, Vec<Address>) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(BridgeRelayer, ());
    let client = BridgeRelayerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let v1 = Address::generate(&env);
    let v2 = Address::generate(&env);
    let v3 = Address::generate(&env);
    let validators = vec![&env, v1, v2, v3];

    let config = BridgeConfig {
        min_validators: 3,
        queue_threshold: DEFAULT_QUEUE_THRESHOLD,
        time_lock: DEFAULT_TIME_LOCK,
        max_queue_size: MAX_QUEUE_SIZE,
        paused: false,
    };

    client.initialize(&admin, &validators, &config);
    (env, client, validators)
}

fn multi_sig(env: &Env, signers: Vec<Address>, n_signatures: u32) -> MultiSignature {
    let mut vals: Vec<Address> = Vec::new(env);
    let mut sigs: Vec<Bytes> = Vec::new(env);
    let mut i: u32 = 0;
    while i < signers.len() && i < n_signatures {
        vals.push_back(signers.get(i).unwrap());
        sigs.push_back(Bytes::from_slice(env, &[0xAAu8; 64]));
        i += 1;
    }
    MultiSignature {
        validators: vals,
        signatures: sigs,
        message_hash: BytesN::from_array(env, &[7u8; 32]),
    }
}

#[test]
fn test_quorum_progress_none_signed() {
    let (env, client, _validators) = setup();

    let empty = MultiSignature {
        validators: Vec::new(&env),
        signatures: Vec::new(&env),
        message_hash: BytesN::from_array(&env, &[1u8; 32]),
    };

    let p = client.get_quorum_progress(&empty);
    assert_eq!(p.signed, 0);
    assert_eq!(p.required, 3);
    assert_eq!(p.remaining, 3);
    assert_eq!(p.progress_bp, 0);
    assert!(!p.met);
    assert_eq!(p.per_signer.len(), 3);
    for i in 0..p.per_signer.len() {
        assert!(!p.per_signer.get(i).unwrap().signed);
    }
}

#[test]
fn test_quorum_progress_partial_signatures() {
    let (env, client, validators) = setup();
    let pair = vec![&env, validators.get(0).unwrap(), validators.get(1).unwrap()];
    let ms = multi_sig(&env, pair, 2);

    let p = client.get_quorum_progress(&ms);
    assert_eq!(p.signed, 2);
    assert_eq!(p.required, 3);
    assert_eq!(p.remaining, 1);
    assert_eq!(p.progress_bp, 6_666);
    assert!(!p.met);

    let mut signed_flags = [false; 3];
    for i in 0..p.per_signer.len() {
        let s = p.per_signer.get(i).unwrap();
        for (j, v) in validators.iter().enumerate() {
            if s.address == v {
                signed_flags[j] = s.signed;
            }
        }
    }
    assert!(signed_flags[0]);
    assert!(signed_flags[1]);
    assert!(!signed_flags[2]);
}

#[test]
fn test_quorum_progress_met_at_threshold() {
    let (env, client, validators) = setup();
    let ms = multi_sig(&env, validators, 3);

    let p = client.get_quorum_progress(&ms);
    assert_eq!(p.signed, 3);
    assert_eq!(p.required, 3);
    assert_eq!(p.remaining, 0);
    assert_eq!(p.progress_bp, 10_000);
    assert!(p.met);
}

#[test]
fn test_quorum_progress_ignores_unknown_signers() {
    let (env, client, validators) = setup();
    let stranger = Address::generate(&env);
    let pair = vec![&env, validators.get(0).unwrap(), stranger];
    let ms = multi_sig(&env, pair, 2);

    let p = client.get_quorum_progress(&ms);
    assert_eq!(p.signed, 1);
    assert_eq!(p.remaining, 2);
    assert!(!p.met);
}

#[test]
fn test_quorum_progress_dedupes_duplicate_signers() {
    let (env, client, validators) = setup();
    let v0 = validators.get(0).unwrap();
    let v1 = validators.get(1).unwrap();
    let dup = vec![&env, v0.clone(), v1, v0];
    let ms = multi_sig(&env, dup, 3);

    let p = client.get_quorum_progress(&ms);
    assert_eq!(p.signed, 2);
    assert_eq!(p.remaining, 1);
    assert!(!p.met);
}
