#![no_std]

use soroban_sdk::{
    contract, contractimpl, symbol_short, token, xdr::{FromXdr, ToXdr}, Address, Bytes, BytesN, Env, Vec,
};

pub mod errors;
pub mod storage;
pub mod types;

use crate::errors::RelayerError;
use crate::storage::*;
use crate::types::*;

#[contract]
pub struct BridgeRelayer;

#[contractimpl]
impl BridgeRelayer {
    /// Initialize the contract with admin and configuration.
    pub fn initialize(
        env: Env,
        admin: Address,
        signers: Vec<Address>,
        multi_sig_threshold: u32,
        queue_threshold: i128,
        queue_delay: u64,
        merkle_root: BytesN<32>,
    ) -> Result<(), RelayerError> {
        if is_initialized(&env) {
            return Err(RelayerError::AlreadyInitialized);
        }

        let config = Config {
            admin,
            multi_sig_threshold,
            queue_threshold,
            queue_delay,
        };

        set_config(&env, &config);
        set_signers(&env, &signers);
        set_merkle_root(&env, &merkle_root);
        set_initialized(&env);

        Ok(())
    }

    /// Execute a message using multi-sig verification.
    pub fn execute_multi_sig(
        env: Env,
        payload_bytes: Bytes,
        relayers: Vec<Address>,
    ) -> Result<(), RelayerError> {
        let config = get_config(&env).ok_or(RelayerError::NotInitialized)?;
        
        // 1. Verify threshold of relayers
        if relayers.len() < config.multi_sig_threshold {
            return Err(RelayerError::InsufficientSignatures);
        }

        let authorized_signers = get_signers(&env);
        for relayer in relayers.iter() {
            relayer.require_auth();
            if !authorized_signers.contains(&relayer) {
                return Err(RelayerError::Unauthorized);
            }
        }

        let payload = MessagePayload::from_xdr(&env, &payload_bytes)
            .map_err(|_| RelayerError::InvalidPayload)?;

        Self::process_payload(&env, payload, &config)
    }

    /// Execute a message using Merkle proof verification.
    pub fn execute_merkle(
        env: Env,
        payload_bytes: Bytes,
        proof: Vec<BytesN<32>>,
    ) -> Result<(), RelayerError> {
        let config = get_config(&env).ok_or(RelayerError::NotInitialized)?;
        let root = get_merkle_root(&env);

        let payload_hash: BytesN<32> = env.crypto().sha256(&payload_bytes).into();
        
        if !Self::verify_merkle_proof(&env, &root, &payload_hash, proof) {
            return Err(RelayerError::InvalidMerkleProof);
        }

        let payload = MessagePayload::from_xdr(&env, &payload_bytes)
            .map_err(|_| RelayerError::InvalidPayload)?;

        Self::process_payload(&env, payload, &config)
    }

    /// Process the message payload: replay protection, queueing, and execution.
    fn process_payload(
        env: &Env,
        payload: MessagePayload,
        config: &Config,
    ) -> Result<(), RelayerError> {
        // 1. Replay Protection: Sequential Nonce
        let last_nonce = get_last_nonce(env, payload.source_chain.clone());
        if payload.nonce != last_nonce + 1 {
            return Err(RelayerError::InvalidNonce);
        }

        // 2. Queue Mechanism for Large Transfers
        if payload.amount >= config.queue_threshold {
            let release_ledger = (env.ledger().sequence() as u64) + config.queue_delay;
            let payload_bytes = payload.clone().to_xdr(env);
            let payload_hash: BytesN<32> = env.crypto().sha256(&payload_bytes).into();
            
            set_message_status(env, payload_hash, &MessageStatus::Queued(release_ledger));
            set_last_nonce(env, payload.source_chain.clone(), payload.nonce);

            env.events().publish(
                (symbol_short!("queued"), payload.source_chain, payload.nonce),
                (payload.recipient, payload.amount, release_ledger),
            );
            return Ok(());
        }

        // 3. Immediate Execution
        Self::execute_transfer(env, &payload)?;
        set_last_nonce(env, payload.source_chain, payload.nonce);

        Ok(())
    }

    /// Execute the actual asset transfer/minting.
    fn execute_transfer(env: &Env, payload: &MessagePayload) -> Result<(), RelayerError> {
        let sac_client = token::StellarAssetClient::new(env, &payload.asset);
        sac_client.mint(&payload.recipient, &payload.amount);

        env.events().publish(
            (symbol_short!("executed"), payload.source_chain.clone(), payload.nonce),
            (payload.recipient.clone(), payload.amount),
        );

        Ok(())
    }

    /// Release a message from the queue after the delay.
    pub fn release_queued(env: Env, payload_bytes: Bytes) -> Result<(), RelayerError> {
        let payload_hash: BytesN<32> = env.crypto().sha256(&payload_bytes).into();
        let status = get_message_status(&env, payload_hash.clone())
            .ok_or(RelayerError::QueueEmpty)?;

        if let MessageStatus::Queued(release_ledger) = status {
            if (env.ledger().sequence() as u64) < release_ledger {
                return Err(RelayerError::QueueActive);
            }

            let payload = MessagePayload::from_xdr(&env, &payload_bytes)
                .map_err(|_| RelayerError::InvalidPayload)?;

            Self::execute_transfer(&env, &payload)?;
            set_message_status(&env, payload_hash, &MessageStatus::Processed);

            Ok(())
        } else {
            Err(RelayerError::MessageAlreadyProcessed)
        }
    }

    /// Verify a Merkle proof.
    fn verify_merkle_proof(
        env: &Env,
        root: &BytesN<32>,
        leaf: &BytesN<32>,
        proof: Vec<BytesN<32>>,
    ) -> bool {
        let mut computed_hash = leaf.clone();

        for node in proof.iter() {
            let mut data = Bytes::new(env);
            let node_bytes: Bytes = node.into();
            let computed_bytes: Bytes = computed_hash.into();
            if computed_bytes < node_bytes {
                data.append(&computed_bytes);
                data.append(&node_bytes);
            } else {
                data.append(&node_bytes);
                data.append(&computed_bytes);
            }
            computed_hash = env.crypto().sha256(&data).into();
        }

        &computed_hash == root
    }

    // --- Admin Functions ---

    pub fn update_config(
        env: Env,
        admin: Address,
        new_multi_sig_threshold: u32,
        new_queue_threshold: i128,
        new_queue_delay: u64,
    ) -> Result<(), RelayerError> {
        let mut config = get_config(&env).ok_or(RelayerError::NotInitialized)?;
        config.admin.require_auth();
        if admin != config.admin {
            return Err(RelayerError::Unauthorized);
        }

        config.multi_sig_threshold = new_multi_sig_threshold;
        config.queue_threshold = new_queue_threshold;
        config.queue_delay = new_queue_delay;

        set_config(&env, &config);
        Ok(())
    }

    pub fn update_signers(env: Env, admin: Address, new_signers: Vec<Address>) -> Result<(), RelayerError> {
        let config = get_config(&env).ok_or(RelayerError::NotInitialized)?;
        config.admin.require_auth();
        if admin != config.admin {
            return Err(RelayerError::Unauthorized);
        }

        set_signers(&env, &new_signers);
        Ok(())
    }

    pub fn update_merkle_root(env: Env, admin: Address, new_root: BytesN<32>) -> Result<(), RelayerError> {
        let config = get_config(&env).ok_or(RelayerError::NotInitialized)?;
        config.admin.require_auth();
        if admin != config.admin {
            return Err(RelayerError::Unauthorized);
        }

        set_merkle_root(&env, &new_root);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
    use soroban_sdk::{Env, Vec};

    fn setup_test(env: &Env) -> (BridgeRelayerClient<'static>, Address, Vec<Address>, Address) {
        env.mock_all_auths();
        let contract_id = env.register(BridgeRelayer, ());
        let client = BridgeRelayerClient::new(env, &contract_id);

        let admin = Address::generate(env);
        let relayer1 = Address::generate(env);
        let relayer2 = Address::generate(env);
        let signers = Vec::from_array(env, [relayer1.clone(), relayer2.clone()]);
        
        let token_id = env.register_stellar_asset_contract_v2(contract_id.clone());
        let token_addr = token_id.address();

        client.initialize(
            &admin,
            &signers,
            &2, // threshold
            &1000, // queue threshold
            &100, // queue delay
            &BytesN::from_array(env, &[0u8; 32]), // merkle root
        );

        (client, admin, signers, token_addr)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let (_client, _admin, _, _) = setup_test(&env);
    }

    #[test]
    fn test_execute_multi_sig_success() {
        let env = Env::default();
        let (client, _, signers, token_addr) = setup_test(&env);
        let recipient = Address::generate(&env);

        let payload = MessagePayload {
            source_chain: symbol_short!("ETH"),
            nonce: 1,
            recipient: recipient.clone(),
            asset: token_addr.clone(),
            amount: 500,
        };

        let payload_bytes = payload.to_xdr(&env);
        client.execute_multi_sig(&payload_bytes, &signers);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&recipient), 500);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")]
    fn test_invalid_nonce() {
        let env = Env::default();
        let (client, _, signers, token_addr) = setup_test(&env);
        let recipient = Address::generate(&env);

        let payload = MessagePayload {
            source_chain: symbol_short!("ETH"),
            nonce: 2, // Should be 1
            recipient: recipient.clone(),
            asset: token_addr.clone(),
            amount: 500,
        };

        let payload_bytes = payload.to_xdr(&env);
        client.execute_multi_sig(&payload_bytes, &signers);
    }

    #[test]
    fn test_queue_mechanism() {
        let env = Env::default();
        let (client, _, signers, token_addr) = setup_test(&env);
        let recipient = Address::generate(&env);

        let payload = MessagePayload {
            source_chain: symbol_short!("ETH"),
            nonce: 1,
            recipient: recipient.clone(),
            asset: token_addr.clone(),
            amount: 1500, // Above 1000 threshold
        };

        let payload_bytes = payload.to_xdr(&env);
        client.execute_multi_sig(&payload_bytes, &signers);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&recipient), 0); // Queued, not minted yet

        // Try to release before delay
        env.ledger().set(LedgerInfo {
            sequence_number: 50,
            ..env.ledger().get()
        });
        let res = client.try_release_queued(&payload_bytes);
        assert!(res.is_err());

        // Release after delay
        env.ledger().set(LedgerInfo {
            sequence_number: 101,
            ..env.ledger().get()
        });
        client.release_queued(&payload_bytes);
        assert_eq!(token_client.balance(&recipient), 1500);
    }

    #[test]
    fn test_merkle_verification() {
        let env = Env::default();
        let (client, admin, _, token_addr) = setup_test(&env);
        let recipient = Address::generate(&env);

        let payload1 = MessagePayload {
            source_chain: symbol_short!("ETH"),
            nonce: 1,
            recipient: recipient.clone(),
            asset: token_addr.clone(),
            amount: 100,
        };
        let payload1_bytes = payload1.to_xdr(&env);
        let leaf1: BytesN<32> = env.crypto().sha256(&payload1_bytes).into();

        let leaf2 = BytesN::from_array(&env, &[1u8; 32]);

        let mut data = Bytes::new(&env);
        let leaf1_bytes: Bytes = leaf1.clone().into();
        let leaf2_bytes: Bytes = leaf2.clone().into();
        if leaf1_bytes < leaf2_bytes {
            data.append(&leaf1_bytes);
            data.append(&leaf2_bytes);
        } else {
            data.append(&leaf2_bytes);
            data.append(&leaf1_bytes);
        }
        let root: BytesN<32> = env.crypto().sha256(&data).into();

        client.update_merkle_root(&admin, &root);

        let mut proof = Vec::new(&env);
        proof.push_back(leaf2);

        client.execute_merkle(&payload1_bytes, &proof);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&recipient), 100);
    }
}
