/*!
# Replay Protection Tests

Tests for the replay attack protection mechanisms used in the bridge relayer.
Tests cover nonce validation, message hashing, processed message tracking,
and timestamp validation.
*/

use bridge_relayer::{
    replay::ReplayProtection, BridgeRelayerError, CrossChainMessage, MessageType, ReplayStats,
};
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, testutils::Ledger as _, Address, Bytes,
    BytesN, Env, Vec,
};

#[contract]
pub struct ReplayTestContract;

#[contractimpl]
impl ReplayTestContract {
    pub fn validate_and_update_nonce(
        env: Env,
        message: CrossChainMessage,
    ) -> Result<(), BridgeRelayerError> {
        ReplayProtection::validate_and_update_nonce(&env, &message)
    }

    pub fn get_current_nonce(env: Env) -> u64 {
        ReplayProtection::get_current_nonce(&env)
    }

    pub fn check_message_processed(
        env: Env,
        message: CrossChainMessage,
    ) -> Result<(), BridgeRelayerError> {
        ReplayProtection::check_message_processed(&env, &message)
    }

    pub fn mark_message_processed(env: Env, message: CrossChainMessage) {
        ReplayProtection::mark_message_processed(&env, &message)
    }

    pub fn reset_nonce(env: Env, nonce: u64, admin: Address) -> Result<(), BridgeRelayerError> {
        ReplayProtection::reset_nonce(&env, nonce, &admin)
    }

    pub fn cleanup_processed_hashes(env: Env, max_age: u64) {
        ReplayProtection::cleanup_processed_hashes(&env, max_age)
    }

    pub fn get_replay_stats(env: Env) -> ReplayStats {
        ReplayProtection::get_replay_stats(&env)
    }

    pub fn batch_validate_messages(
        env: Env,
        messages: Vec<CrossChainMessage>,
        source_chain: u32,
        target_chain: u32,
    ) -> Vec<Result<(), BridgeRelayerError>> {
        ReplayProtection::batch_validate_messages(&env, &messages, source_chain, target_chain)
    }

    pub fn validate_message_timestamp(
        env: Env,
        message: CrossChainMessage,
        max_age: u64,
    ) -> Result<(), BridgeRelayerError> {
        ReplayProtection::validate_message_timestamp(&env, &message, max_age)
    }
}

fn setup_client(env: &Env) -> ReplayTestContractClient<'static> {
    let contract_id = env.register(ReplayTestContract, ());
    ReplayTestContractClient::new(env, &contract_id)
}

#[test]
fn test_nonce_validation() {
    let env = Env::default();
    let client = setup_client(&env);

    // Create test message with nonce 1
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);

    let message = CrossChainMessage {
        source_chain: 1,
        target_chain: 2,
        nonce: 1, // Correct nonce (current + 1)
        sender: sender.clone(),
        recipient: recipient.clone(),
        asset: asset.clone(),
        amount: 1000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };

    // Validate and update nonce (should succeed)
    let result = client.try_validate_and_update_nonce(&message);
    assert!(result.is_ok());

    // Check nonce was updated
    assert_eq!(client.get_current_nonce(), 2);

    let result = client.try_validate_and_update_nonce(&message);
    assert_eq!(
        result.err().unwrap().ok(),
        Some(BridgeRelayerError::InvalidNonce)
    );
}

#[test]
fn test_invalid_nonce_sequence() {
    let env = Env::default();
    let client = setup_client(&env);

    // Create test message with wrong nonce (should be 1, but we use 3)
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);

    let message = CrossChainMessage {
        source_chain: 1,
        target_chain: 2,
        nonce: 3, // Wrong nonce
        sender: sender.clone(),
        recipient: recipient.clone(),
        asset: asset.clone(),
        amount: 1000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };

    // Should fail with invalid nonce
    let result = client.try_validate_and_update_nonce(&message);
    assert_eq!(
        result.err().unwrap().ok(),
        Some(BridgeRelayerError::InvalidNonce)
    );
}

#[test]
fn test_message_processed_tracking() {
    let env = Env::default();
    let client = setup_client(&env);

    // Create test message
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);

    let message = CrossChainMessage {
        source_chain: 1,
        target_chain: 2,
        nonce: 1,
        sender: sender.clone(),
        recipient: recipient.clone(),
        asset: asset.clone(),
        amount: 1000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };

    // Check message is not processed initially
    let result = client.try_check_message_processed(&message);
    assert!(result.is_ok());

    // Mark message as processed
    client.mark_message_processed(&message);

    // Check message is now processed
    let result = client.try_check_message_processed(&message);
    assert_eq!(
        result.err().unwrap().ok(),
        Some(BridgeRelayerError::MessageAlreadyProcessed)
    );
}

#[test]
fn test_message_hash_computation() {
    let env = Env::default();

    // Create test message
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);

    let message = CrossChainMessage {
        source_chain: 1,
        target_chain: 2,
        nonce: 1,
        sender: sender.clone(),
        recipient: recipient.clone(),
        asset: asset.clone(),
        amount: 1000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };

    // Compute hash
    let hash1 = ReplayProtection::compute_message_hash(&env, &message);
    let hash2 = ReplayProtection::compute_message_hash(&env, &message);

    // Hash should be deterministic
    assert_eq!(hash1, hash2);

    // Different message should produce different hash
    let mut different_message = message.clone();
    different_message.amount = 2000;
    let hash3 = ReplayProtection::compute_message_hash(&env, &different_message);
    assert_ne!(hash1, hash3);
}

#[test]
fn test_message_format_validation() {
    let env = Env::default();

    // Valid message
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);

    let valid_message = CrossChainMessage {
        source_chain: 1,
        target_chain: 2,
        nonce: 1,
        sender: sender.clone(),
        recipient: recipient.clone(),
        asset: asset.clone(),
        amount: 1000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };

    let result = ReplayProtection::validate_message_format(&valid_message);
    assert!(result.is_ok());

    // Invalid message (zero chain ID)
    let mut invalid_message = valid_message.clone();
    invalid_message.source_chain = 0;
    let result = ReplayProtection::validate_message_format(&invalid_message);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidMessage));

    // Invalid message (zero nonce)
    let mut invalid_message = valid_message.clone();
    invalid_message.nonce = 0;
    let result = ReplayProtection::validate_message_format(&invalid_message);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidMessage));

    // Invalid message (zero amount)
    let mut invalid_message = valid_message.clone();
    invalid_message.amount = 0;
    let result = ReplayProtection::validate_message_format(&invalid_message);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidMessage));
}

#[test]
fn test_chain_id_validation() {
    let env = Env::default();

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);

    let message = CrossChainMessage {
        source_chain: 1,
        target_chain: 2,
        nonce: 1,
        sender: sender.clone(),
        recipient: recipient.clone(),
        asset: asset.clone(),
        amount: 1000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };

    // Valid chain IDs
    let result = ReplayProtection::validate_chain_ids(&env, &message, 1, 2);
    assert!(result.is_ok());

    // Invalid source chain
    let result = ReplayProtection::validate_chain_ids(&env, &message, 99, 2);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidMessage));

    // Invalid target chain
    let result = ReplayProtection::validate_chain_ids(&env, &message, 1, 99);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidMessage));
}

#[test]
fn test_message_timestamp_validation() {
    let env = Env::default();
    let client = setup_client(&env);

    // Set ledger timestamp to a reasonable non-zero value to prevent subtraction underflow
    env.ledger().set_timestamp(86400 * 10);
    let current_time = env.ledger().timestamp();

    // Create metadata with timestamp
    let mut timestamp_bytes = [0u8; 8];
    timestamp_bytes.copy_from_slice(&current_time.to_be_bytes());
    let metadata = Bytes::from_slice(&env, &timestamp_bytes);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);

    let message = CrossChainMessage {
        source_chain: 1,
        target_chain: 2,
        nonce: 1,
        sender: sender.clone(),
        recipient: recipient.clone(),
        asset: asset.clone(),
        amount: 1000,
        metadata: metadata.clone(),
        message_type: MessageType::Mint,
    };

    // Valid timestamp (current time)
    let result = client.try_validate_message_timestamp(&message, &86400); // 24 hour max age
    assert!(result.is_ok());

    // Create old timestamp
    let old_time = current_time - 86400 * 2; // 2 days ago
    let mut old_timestamp_bytes = [0u8; 8];
    old_timestamp_bytes.copy_from_slice(&old_time.to_be_bytes());
    let old_metadata = Bytes::from_slice(&env, &old_timestamp_bytes);

    let mut old_message = message.clone();
    old_message.metadata = old_metadata;

    // Old timestamp should fail
    let result = client.try_validate_message_timestamp(&old_message, &86400);
    assert_eq!(
        result.err().unwrap().ok(),
        Some(BridgeRelayerError::InvalidMessage)
    );

    // Create future timestamp (beyond tolerance)
    let future_time = current_time + 600; // 10 minutes in future
    let mut future_timestamp_bytes = [0u8; 8];
    future_timestamp_bytes.copy_from_slice(&future_time.to_be_bytes());
    let future_metadata = Bytes::from_slice(&env, &future_timestamp_bytes);

    let mut future_message = message.clone();
    future_message.metadata = future_metadata;

    // Future timestamp should fail
    let result = client.try_validate_message_timestamp(&future_message, &86400);
    assert_eq!(
        result.err().unwrap().ok(),
        Some(BridgeRelayerError::InvalidMessage)
    );
}

#[test]
fn test_nonce_reset() {
    let env = Env::default();
    let client = setup_client(&env);

    // Set initial nonce
    client.reset_nonce(&100, &Address::generate(&env));
    assert_eq!(client.get_current_nonce(), 100);

    // Reset nonce
    let admin = Address::generate(&env);
    let result = client.try_reset_nonce(&200, &admin);
    assert!(result.is_ok());
    assert_eq!(client.get_current_nonce(), 200);
}

#[test]
fn test_cleanup_processed_hashes() {
    let env = Env::default();
    let client = setup_client(&env);

    // Set ledger timestamp to a reasonable non-zero value to prevent subtraction underflow
    env.ledger().set_timestamp(86400 * 10);
    let base_time = env.ledger().timestamp();

    // Set old timestamp for registering messages
    let old_time = base_time - 86400 * 7; // 7 days ago
    env.ledger().set_timestamp(old_time);

    // Mark some messages as processed
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);

    for i in 0..3 {
        let message = CrossChainMessage {
            source_chain: 1,
            target_chain: 2,
            nonce: i + 1,
            sender: sender.clone(),
            recipient: recipient.clone(),
            asset: asset.clone(),
            amount: 1000,
            metadata: Bytes::from_slice(&env, b"test"),
            message_type: MessageType::Mint,
        };

        client.mark_message_processed(&message);
    }

    // Return to current time
    env.ledger().set_timestamp(old_time + 86400 * 7);

    // Cleanup old processed hashes
    client.cleanup_processed_hashes(&(86400 * 3)); // Keep 3 days

    // Verify cleanup
    let stats = client.get_replay_stats();
    assert_eq!(stats.total_processed, 0);
}

#[test]
fn test_replay_stats() {
    let env = Env::default();
    let client = setup_client(&env);

    env.ledger().set_timestamp(86400 * 10);

    // Initial stats
    let stats = client.get_replay_stats();
    assert_eq!(stats.current_nonce, 0);
    assert_eq!(stats.total_processed, 0);
    assert_eq!(stats.recent_processed, 0);
    assert_eq!(stats.old_processed, 0);

    // Process some messages
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);

    for i in 0..3 {
        let message = CrossChainMessage {
            source_chain: 1,
            target_chain: 2,
            nonce: i + 1,
            sender: sender.clone(),
            recipient: recipient.clone(),
            asset: asset.clone(),
            amount: 1000,
            metadata: Bytes::from_slice(&env, b"test"),
            message_type: MessageType::Mint,
        };

        client.mark_message_processed(&message);
    }

    // Check updated stats
    let stats = client.get_replay_stats();
    assert_eq!(stats.total_processed, 3);
    assert_eq!(stats.recent_processed, 3); // All recent (within 24h)
    assert_eq!(stats.old_processed, 0);
}

#[test]
fn test_batch_message_validation() {
    let env = Env::default();
    let client = setup_client(&env);

    // Create test messages
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let asset = Address::generate(&env);

    let mut messages = Vec::new(&env);

    for i in 0..3 {
        let message = CrossChainMessage {
            source_chain: 1,
            target_chain: 2,
            nonce: i + 1,
            sender: sender.clone(),
            recipient: recipient.clone(),
            asset: asset.clone(),
            amount: 1000,
            metadata: Bytes::from_slice(&env, b"test"),
            message_type: MessageType::Mint,
        };

        messages.push_back(message);
    }

    // Validate batch
    let results = client.batch_validate_messages(&messages, &1, &2);
    assert_eq!(results.len(), 3);

    // All should be valid (not processed yet)
    for result in results.iter() {
        assert!(result.is_ok());
    }

    // Mark one message as processed
    let msg_to_mark = messages.get(1).unwrap();
    client.mark_message_processed(&msg_to_mark);

    // Validate batch again
    let results = client.batch_validate_messages(&messages, &1, &2);
    assert_eq!(results.len(), 3);

    // First should be valid, second should fail (already processed), third should be valid
    assert!(results.get(0).unwrap().is_ok());
    assert!(results.get(1).unwrap().is_err());
    assert!(results.get(2).unwrap().is_ok());
}
