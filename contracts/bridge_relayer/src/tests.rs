#[cfg(test)]
#[allow(clippy::module_inception)]
mod tests {
    use crate::{types::Payload, BridgeError, BridgeRelayer, BridgeRelayerClient};
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;
    use soroban_sdk::xdr::ToXdr;
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Ledger},
        Address, BytesN, Env, Symbol, Vec,
    };

    #[contract]
    pub struct MockToken;

    #[contractimpl]
    impl MockToken {
        pub fn mint(_e: Env, _to: Address, _amount: i128) {}
        pub fn balance(_e: Env, _to: Address) -> i128 {
            0
        }
    }

    fn setup_env(
        e: &Env,
    ) -> (
        BridgeRelayerClient<'static>,
        Address,
        SigningKey,
        SigningKey,
        i128,
        Address,
    ) {
        e.mock_all_auths();

        let contract_id = e.register(BridgeRelayer, ());
        let client = BridgeRelayerClient::new(e, &contract_id);

        let admin = Address::generate(e);

        let mut rng = OsRng;
        let sk1 = SigningKey::generate(&mut rng);
        let sk2 = SigningKey::generate(&mut rng);

        let pk1 = BytesN::from_array(e, &sk1.verifying_key().to_bytes());
        let pk2 = BytesN::from_array(e, &sk2.verifying_key().to_bytes());

        let validators = Vec::from_array(e, [pk1, pk2]);
        let limit = 1_000_000_i128;

        client.initialize(&admin, &validators, &2, &limit);

        let asset = e.register(MockToken, ());

        (client, admin, sk1, sk2, limit, asset)
    }

    #[test]
    fn test_receive_message_success() {
        let e = Env::default();
        let (client, _admin, sk1, sk2, limit, asset) = setup_env(&e);
        let recipient = Address::generate(&e);

        let payload = Payload {
            src_chain: Symbol::new(&e, "eth"),
            src_address: BytesN::from_array(&e, &[1; 32]),
            asset: asset.clone(),
            amount: limit,
            recipient: recipient.clone(),
            nonce: 1,
        };

        let hash_bytes: [u8; 32] = e.crypto().sha256(&payload.clone().to_xdr(&e)).into();
        let sigs = Vec::from_array(
            &e,
            [
                (0, BytesN::from_array(&e, &sk1.sign(&hash_bytes).to_bytes())),
                (1, BytesN::from_array(&e, &sk2.sign(&hash_bytes).to_bytes())),
            ],
        );

        let res = client.receive_message(&payload, &sigs);
        assert_eq!(res, 0);
    }

    #[test]
    fn test_receive_message_replay() {
        let e = Env::default();
        let (client, _, sk1, sk2, limit, asset) = setup_env(&e);
        let payload = Payload {
            src_chain: Symbol::new(&e, "eth"),
            src_address: BytesN::from_array(&e, &[1; 32]),
            asset: asset.clone(),
            amount: limit,
            recipient: Address::generate(&e),
            nonce: 1,
        };
        let hash_bytes: [u8; 32] = e.crypto().sha256(&payload.clone().to_xdr(&e)).into();
        let sigs = Vec::from_array(
            &e,
            [
                (0, BytesN::from_array(&e, &sk1.sign(&hash_bytes).to_bytes())),
                (1, BytesN::from_array(&e, &sk2.sign(&hash_bytes).to_bytes())),
            ],
        );

        client.receive_message(&payload, &sigs);
        let res = client.try_receive_message(&payload, &sigs);
        assert_eq!(res.err().unwrap().unwrap(), BridgeError::ReplayAttack);
    }

    #[test]
    fn test_queue_and_release() {
        let e = Env::default();
        let (client, admin, sk1, sk2, limit, asset) = setup_env(&e);
        let recipient = Address::generate(&e);

        let payload = Payload {
            src_chain: Symbol::new(&e, "eth"),
            src_address: BytesN::from_array(&e, &[1; 32]),
            asset: asset.clone(),
            amount: limit + 1,
            recipient: recipient.clone(),
            nonce: 1,
        };
        let hash_bytes: [u8; 32] = e.crypto().sha256(&payload.clone().to_xdr(&e)).into();
        let sigs = Vec::from_array(
            &e,
            [
                (0, BytesN::from_array(&e, &sk1.sign(&hash_bytes).to_bytes())),
                (1, BytesN::from_array(&e, &sk2.sign(&hash_bytes).to_bytes())),
            ],
        );

        let queue_id = client.receive_message(&payload, &sigs);
        assert!(queue_id > 0);

        let res = client.try_release_queued(&admin, &queue_id);
        assert_eq!(res.err().unwrap().unwrap(), BridgeError::QueueDelayActive);

        e.ledger().set_timestamp(86401);
        client.release_queued(&admin, &queue_id);
    }

    #[test]
    fn test_invalid_signature() {
        let e = Env::default();
        let (client, _, _sk1, sk2, limit, asset) = setup_env(&e);
        let payload = Payload {
            src_chain: Symbol::new(&e, "eth"),
            src_address: BytesN::from_array(&e, &[1; 32]),
            asset: asset.clone(),
            amount: limit,
            recipient: Address::generate(&e),
            nonce: 1,
        };
        let hash_bytes: [u8; 32] = e.crypto().sha256(&payload.clone().to_xdr(&e)).into();

        let sigs = Vec::from_array(
            &e,
            [
                (0, BytesN::from_array(&e, &sk2.sign(&hash_bytes).to_bytes())),
                (1, BytesN::from_array(&e, &sk2.sign(&hash_bytes).to_bytes())),
            ],
        );

        let res = client.try_receive_message(&payload, &sigs);
        assert!(res.is_err());
    }

    #[test]
    fn test_admin_updates() {
        let e = Env::default();
        let (client, admin, _, _, _, _) = setup_env(&e);

        // Update limit
        client.set_limit(&admin, &500_i128);

        // Update validators
        let new_v = Vec::from_array(&e, [BytesN::from_array(&e, &[0; 32])]);
        client.update_validators(&admin, &new_v, &1);

        // Try unauthorized
        let res = client.try_set_limit(&Address::generate(&e), &300);
        assert!(res.is_err());
    }
}
