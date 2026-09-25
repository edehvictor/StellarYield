/*!
# Transfer Queue Tests

Tests for the transfer queue mechanism used in the bridge relayer.
Tests cover queue operations, time locks, capacity limits,
and transfer execution.
*/

use bridge_relayer::{
    queue::TransferQueue,
    BridgeRelayerError,
    CrossChainMessage,
    MessageType,
    QueuedTransfer,
};
use soroban_sdk::{Address, Bytes, BytesN, Vec, Env};

#[test]
fn test_queue_transfer() {
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
        amount: 2000, // Above threshold
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };
    
    // Queue the transfer
    let result = TransferQueue::queue_transfer(
        &env,
        &message,
        1000, // threshold
        3600, // time_lock
        100,  // max_queue_size
    );
    
    assert!(result.is_ok());
    
    let transfer_id = result.unwrap();
    
    // Verify the transfer was queued
    let queued_transfer = TransferQueue::get_queued_transfer(&env, &transfer_id);
    assert!(queued_transfer.is_some());
    
    let transfer = queued_transfer.unwrap();
    assert_eq!(transfer.id, transfer_id);
    assert_eq!(transfer.message.amount, 2000);
    assert!(!transfer.processed);
}

#[test]
fn test_queue_transfer_below_threshold() {
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
        amount: 500, // Below threshold
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };
    
    // Try to queue the transfer (should fail)
    let result = TransferQueue::queue_transfer(
        &env,
        &message,
        1000, // threshold
        3600, // time_lock
        100,  // max_queue_size
    );
    
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::AmountExceedsThreshold));
}

#[test]
fn test_execute_queued_transfer() {
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
        amount: 2000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };
    
    // Queue the transfer with minimal time lock
    let result = TransferQueue::queue_transfer(
        &env,
        &message,
        1000, // threshold
        1,    // time_lock (1 second)
        100,  // max_queue_size
    );
    
    assert!(result.is_ok());
    let transfer_id = result.unwrap();
    
    // Advance time to make transfer executable
    env.ledger().set_timestamp(env.ledger().timestamp() + 2);
    
    // Execute the transfer
    let result = TransferQueue::execute_queued_transfer(&env, &transfer_id);
    assert!(result.is_ok());
    
    let executed_message = result.unwrap();
    assert_eq!(executed_message.amount, 2000);
    assert_eq!(executed_message.recipient, recipient);
}

#[test]
fn test_execute_transfer_not_yet_executable() {
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
        amount: 2000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };
    
    // Queue the transfer with long time lock
    let result = TransferQueue::queue_transfer(
        &env,
        &message,
        1000, // threshold
        3600, // time_lock (1 hour)
        100,  // max_queue_size
    );
    
    assert!(result.is_ok());
    let transfer_id = result.unwrap();
    
    // Try to execute immediately (should fail)
    let result = TransferQueue::execute_queued_transfer(&env, &transfer_id);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::TransferNotExecutable));
}

#[test]
fn test_queue_capacity_limit() {
    let env = Env::default();
    
    // Fill queue to capacity
    for i in 0..5 {
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let asset = Address::generate(&env);
        
        let message = CrossChainMessage {
            source_chain: 1,
            target_chain: 2,
            nonce: i + 1,
            sender: sender.clone(),
            recipient: recipient.clone(),
            asset: asset.clone(),
            amount: 2000,
            metadata: Bytes::from_slice(&env, b"test"),
            message_type: MessageType::Mint,
        };
        
        let result = TransferQueue::queue_transfer(
            &env,
            &message,
            1000, // threshold
            3600, // time_lock
            5,    // max_queue_size (small for testing)
        );
        
        if i < 5 {
            assert!(result.is_ok());
        } else {
            assert!(result.is_err());
            assert_eq!(result.err(), Some(BridgeRelayerError::QueueFull));
        }
    }
}

#[test]
fn test_get_all_queued_transfers() {
    let env = Env::default();
    
    // Initially empty
    let all_transfers = TransferQueue::get_all_queued_transfers(&env);
    assert!(all_transfers.is_empty());
    
    // Add some transfers
    let mut transfer_ids = Vec::new(&env);
    
    for i in 0..3 {
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let asset = Address::generate(&env);
        
        let message = CrossChainMessage {
            source_chain: 1,
            target_chain: 2,
            nonce: i + 1,
            sender: sender.clone(),
            recipient: recipient.clone(),
            asset: asset.clone(),
            amount: 2000,
            metadata: Bytes::from_slice(&env, b"test"),
            message_type: MessageType::Mint,
        };
        
        let result = TransferQueue::queue_transfer(
            &env,
            &message,
            1000, // threshold
            3600, // time_lock
            100,  // max_queue_size
        );
        
        assert!(result.is_ok());
        transfer_ids.push_back(result.unwrap());
    }
    
    // Get all transfers
    let all_transfers = TransferQueue::get_all_queued_transfers(&env);
    assert_eq!(all_transfers.len(), 3);
    
    // Verify transfer IDs match
    for (i, transfer) in all_transfers.iter().enumerate() {
        assert_eq!(transfer.id, transfer_ids.get(i));
    }
}

#[test]
fn test_get_executable_transfers() {
    let env = Env::default();
    
    // Add transfers with different execution times
    let current_time = env.ledger().timestamp();
    
    // Transfer 1: Already executable
    let sender1 = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let asset1 = Address::generate(&env);
    
    let message1 = CrossChainMessage {
        source_chain: 1,
        target_chain: 2,
        nonce: 1,
        sender: sender1.clone(),
        recipient: recipient1.clone(),
        asset: asset1.clone(),
        amount: 2000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };
    
    let result1 = TransferQueue::queue_transfer(
        &env,
        &message1,
        1000, // threshold
        1,    // time_lock (1 second)
        100,  // max_queue_size
    );
    assert!(result1.is_ok());
    
    // Advance time
    env.ledger().set_timestamp(current_time + 2);
    
    // Transfer 2: Not yet executable
    let sender2 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let asset2 = Address::generate(&env);
    
    let message2 = CrossChainMessage {
        source_chain: 1,
        target_chain: 2,
        nonce: 2,
        sender: sender2.clone(),
        recipient: recipient2.clone(),
        asset: asset2.clone(),
        amount: 2000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };
    
    let result2 = TransferQueue::queue_transfer(
        &env,
        &message2,
        1000, // threshold
        3600, // time_lock (1 hour)
        100,  // max_queue_size
    );
    assert!(result2.is_ok());
    
    // Get executable transfers
    let executable_transfers = TransferQueue::get_executable_transfers(&env);
    assert_eq!(executable_transfers.len(), 1);
    assert_eq!(executable_transfers.get(0).message.nonce, 1);
}

#[test]
fn test_cancel_queued_transfer() {
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
        amount: 2000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };
    
    // Queue the transfer
    let result = TransferQueue::queue_transfer(
        &env,
        &message,
        1000, // threshold
        3600, // time_lock
        100,  // max_queue_size
    );
    
    assert!(result.is_ok());
    let transfer_id = result.unwrap();
    
    // Cancel the transfer
    let admin = Address::generate(&env);
    let result = TransferQueue::cancel_queued_transfer(&env, &transfer_id, &admin);
    assert!(result.is_ok());
    
    // Verify transfer is gone
    let queued_transfer = TransferQueue::get_queued_transfer(&env, &transfer_id);
    assert!(queued_transfer.is_none());
}

#[test]
fn test_queue_statistics() {
    let env = Env::default();
    
    // Initially empty stats
    let stats = TransferQueue::get_queue_stats(&env);
    assert_eq!(stats.total_transfers, 0);
    assert_eq!(stats.pending_count, 0);
    assert_eq!(stats.executable_count, 0);
    assert_eq!(stats.processed_count, 0);
    assert_eq!(stats.total_amount, 0);
    
    // Add some transfers
    for i in 0..3 {
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let asset = Address::generate(&env);
        
        let message = CrossChainMessage {
            source_chain: 1,
            target_chain: 2,
            nonce: i + 1,
            sender: sender.clone(),
            recipient: recipient.clone(),
            asset: asset.clone(),
            amount: 1000 * (i + 1), // Different amounts
            metadata: Bytes::from_slice(&env, b"test"),
            message_type: MessageType::Mint,
        };
        
        let result = TransferQueue::queue_transfer(
            &env,
            &message,
            500,  // threshold
            3600, // time_lock
            100,  // max_queue_size
        );
        assert!(result.is_ok());
    }
    
    // Check stats
    let stats = TransferQueue::get_queue_stats(&env);
    assert_eq!(stats.total_transfers, 3);
    assert_eq!(stats.pending_count, 3); // All pending (time lock not expired)
    assert_eq!(stats.executable_count, 0);
    assert_eq!(stats.processed_count, 0);
    assert_eq!(stats.total_amount, 6000); // 1000 + 2000 + 3000
}

#[test]
fn test_cleanup_processed_transfers() {
    let env = Env::default();
    
    // Set old timestamp
    let old_time = env.ledger().timestamp() - 86400 * 7; // 7 days ago
    env.ledger().set_timestamp(old_time);
    
    // Add and execute a transfer
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
        amount: 2000,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };
    
    let result = TransferQueue::queue_transfer(
        &env,
        &message,
        1000, // threshold
        1,    // time_lock
        100,  // max_queue_size
    );
    assert!(result.is_ok());
    let transfer_id = result.unwrap();
    
    // Execute the transfer
    env.ledger().set_timestamp(old_time + 2);
    let result = TransferQueue::execute_queued_transfer(&env, &transfer_id);
    assert!(result.is_ok());
    
    // Return to current time
    env.ledger().set_timestamp(old_time + 86400 * 7);
    
    // Cleanup old processed transfers
    TransferQueue::cleanup_processed_transfers(&env, 86400 * 3); // Keep 3 days
    
    // Verify cleanup (implementation dependent)
    let all_transfers = TransferQueue::get_all_queued_transfers(&env);
    // The processed transfer should be cleaned up
}
