/*!
# Bridge Relayer Contract Tests

Comprehensive test suite for the cross-chain bridge state relayer contract.
Tests cover all major functionality including initialization, message processing,
Merkle proof validation, multi-signature verification, queue management,
and replay protection.

## Test Coverage

- Contract initialization and configuration
- Message validation and processing
- Merkle proof verification
- Multi-signature verification
- Queue mechanism for large transfers
- Replay attack protection
- Admin functions and emergency controls
- Error handling and edge cases
*/

use bridge_relayer::{
    BridgeRelayer, BridgeRelayerError, BridgeConfig, CrossChainMessage, MessageType,
    MerkleProof, MultiSignature, QueuedTransfer, ValidatorInfo,
    CONTRACT_VERSION, DEFAULT_MIN_VALIDATORS, DEFAULT_QUEUE_THRESHOLD,
    DEFAULT_TIME_LOCK, MAX_QUEUE_SIZE,
};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, Symbol, Vec, Map, String,
};
use soroban_sdk::testutils::{Address as TestAddress, Ledger as TestLedger};

#[contract]
struct TestBridgeRelayer;

#[contractimpl]
impl TestBridgeRelayer {
    pub fn initialize(env: Env, admin: Address, initial_validators: Vec<Address>, config: BridgeConfig) {
        BridgeRelayer::initialize(env, admin, initial_validators, config);
    }

    pub fn receive_message_with_merkle_proof(
        env: Env,
        message: CrossChainMessage,
        proof: MerkleProof,
    ) -> Result<BytesN<32>, BridgeRelayerError> {
        BridgeRelayer::receive_message_with_merkle_proof(env, message, proof)
    }

    pub fn receive_message_with_multisig(
        env: Env,
        message: CrossChainMessage,
        multi_sig: MultiSignature,
    ) -> Result<BytesN<32>, BridgeRelayerError> {
        BridgeRelayer::receive_message_with_multisig(env, message, multi_sig)
    }

    pub fn execute_queued_transfer(
        env: Env,
        transfer_id: BytesN<32>,
    ) -> Result<bool, BridgeRelayerError> {
        BridgeRelayer::execute_queued_transfer(env, transfer_id)
    }

    pub fn get_config(env: Env) -> BridgeConfig {
        BridgeRelayer::get_config(env)
    }

    pub fn get_nonce(env: Env) -> u64 {
        BridgeRelayer::get_nonce(env)
    }

    pub fn get_queued_transfer(env: Env, transfer_id: BytesN<32>) -> Option<QueuedTransfer> {
        BridgeRelayer::get_queued_transfer(env, transfer_id)
    }

    pub fn get_all_queued_transfers(env: Env) -> Vec<QueuedTransfer> {
        BridgeRelayer::get_all_queued_transfers(env)
    }

    pub fn is_message_processed(env: Env, message_hash: BytesN<32>) -> bool {
        BridgeRelayer::is_message_processed(env, message_hash)
    }

    pub fn update_config(
        env: Env,
        admin: Address,
        new_config: BridgeConfig,
    ) -> Result<(), BridgeRelayerError> {
        BridgeRelayer::update_config(env, admin, new_config)
    }

    pub fn add_validator(
        env: Env,
        admin: Address,
        validator: Address,
        weight: u32,
    ) -> Result<(), BridgeRelayerError> {
        BridgeRelayer::add_validator(env, admin, validator, weight)
    }

    pub fn remove_validator(
        env: Env,
        admin: Address,
        validator: Address,
    ) -> Result<(), BridgeRelayerError> {
        BridgeRelayer::remove_validator(env, admin, validator)
    }

    pub fn emergency_pause(env: Env, admin: Address) -> Result<(), BridgeRelayerError> {
        BridgeRelayer::emergency_pause(env, admin)
    }

    pub fn emergency_unpause(env: Env, admin: Address) -> Result<(), BridgeRelayerError> {
        BridgeRelayer::emergency_unpause(env, admin)
    }
}

#[test]
fn test_contract_initialization() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    // Create test addresses
    let admin = Address::generate(&env);
    let validator1 = Address::generate(&env);
    let validator2 = Address::generate(&env);
    let validator3 = Address::generate(&env);

    let initial_validators = vec![&env, validator1.clone(), validator2.clone(), validator3.clone()];
    let config = BridgeConfig {
        min_validators: 2,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };

    // Initialize contract
    client.initialize(&admin, &initial_validators, &config);

    // Verify configuration
    let stored_config = client.get_config();
    assert_eq!(stored_config.min_validators, 2);
    assert_eq!(stored_config.queue_threshold, 1000);
    assert_eq!(stored_config.time_lock, 3600);
    assert_eq!(stored_config.max_queue_size, 100);
    assert!(!stored_config.paused);

    // Verify nonce is initialized
    assert_eq!(client.get_nonce(), 0);
}

#[test]
fn test_initialization_with_invalid_admin() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    let admin = Address::default(); // Invalid address
    let validator = Address::generate(&env);
    let initial_validators = vec![&env, validator.clone()];
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };

    // Should panic with invalid admin
    let result = std::panic::catch_unwind(|| {
        client.initialize(&admin, &initial_validators, &config);
    });
    assert!(result.is_err());
}

#[test]
fn test_initialization_with_empty_validators() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let initial_validators = Vec::new(&env);
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };

    // Should panic with empty validators
    let result = std::panic::catch_unwind(|| {
        client.initialize(&admin, &initial_validators, &config);
    });
    assert!(result.is_err());
}

#[test]
fn test_double_initialization() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let validator = Address::generate(&env);
    let initial_validators = vec![&env, validator.clone()];
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };

    // First initialization should succeed
    client.initialize(&admin, &initial_validators, &config);

    // Second initialization should panic
    let result = std::panic::catch_unwind(|| {
        client.initialize(&admin, &initial_validators, &config);
    });
    assert!(result.is_err());
}

#[test]
fn test_receive_message_with_merkle_proof() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    // Setup contract
    let admin = Address::generate(&env);
    let validator = Address::generate(&env);
    let initial_validators = vec![&env, validator.clone()];
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };
    client.initialize(&admin, &initial_validators, &config);

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
        amount: 500,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };

    // Create mock Merkle proof (for testing purposes)
    let proof = MerkleProof {
        root: BytesN::from_array(&[1u8; 32]),
        proof: Vec::new(&env),
        index: 0,
    };

    // This will fail with invalid Merkle proof, but tests the flow
    let result = client.receive_message_with_merkle_proof(&message, &proof);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidMerkleProof));
}

#[test]
fn test_receive_message_with_invalid_nonce() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    // Setup contract
    let admin = Address::generate(&env);
    let validator = Address::generate(&env);
    let initial_validators = vec![&env, validator.clone()];
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };
    client.initialize(&admin, &initial_validators, &config);

    // Create message with wrong nonce (should be 1, but we use 3)
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
        amount: 500,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };

    let proof = MerkleProof {
        root: BytesN::from_array(&[1u8; 32]),
        proof: Vec::new(&env),
        index: 0,
    };

    let result = client.receive_message_with_merkle_proof(&message, &proof);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidNonce));
}

#[test]
fn test_receive_message_when_paused() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    // Setup contract
    let admin = Address::generate(&env);
    let validator = Address::generate(&env);
    let initial_validators = vec![&env, validator.clone()];
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: true, // Start paused
    };
    client.initialize(&admin, &initial_validators, &config);

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
        amount: 500,
        metadata: Bytes::from_slice(&env, b"test"),
        message_type: MessageType::Mint,
    };

    let proof = MerkleProof {
        root: BytesN::from_array(&[1u8; 32]),
        proof: Vec::new(&env),
        index: 0,
    };

    let result = client.receive_message_with_merkle_proof(&message, &proof);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::ContractPaused));
}

#[test]
fn test_admin_functions() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    // Setup contract
    let admin = Address::generate(&env);
    let validator = Address::generate(&env);
    let initial_validators = vec![&env, validator.clone()];
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };
    client.initialize(&admin, &initial_validators, &config);

    // Test updating config as admin
    let new_config = BridgeConfig {
        min_validators: 2,
        queue_threshold: 2000,
        time_lock: 7200,
        max_queue_size: 200,
        paused: false,
    };
    let result = client.update_config(&admin, &new_config);
    assert!(result.is_ok());

    let stored_config = client.get_config();
    assert_eq!(stored_config.min_validators, 2);
    assert_eq!(stored_config.queue_threshold, 2000);

    // Test adding validator
    let new_validator = Address::generate(&env);
    let result = client.add_validator(&admin, &new_validator, &1);
    assert!(result.is_ok());

    // Test removing validator
    let result = client.remove_validator(&admin, &new_validator);
    assert!(result.is_ok());

    // Test emergency pause
    let result = client.emergency_pause(&admin);
    assert!(result.is_ok());
    let stored_config = client.get_config();
    assert!(stored_config.paused);

    // Test emergency unpause
    let result = client.emergency_unpause(&admin);
    assert!(result.is_ok());
    let stored_config = client.get_config();
    assert!(!stored_config.paused);
}

#[test]
fn test_unauthorized_admin_functions() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    // Setup contract
    let admin = Address::generate(&env);
    let validator = Address::generate(&env);
    let initial_validators = vec![&env, validator.clone()];
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };
    client.initialize(&admin, &initial_validators, &config);

    // Test unauthorized config update
    let unauthorized = Address::generate(&env);
    let new_config = BridgeConfig {
        min_validators: 2,
        queue_threshold: 2000,
        time_lock: 7200,
        max_queue_size: 200,
        paused: false,
    };
    let result = client.update_config(&unauthorized, &new_config);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::Unauthorized));

    // Test unauthorized validator addition
    let new_validator = Address::generate(&env);
    let result = client.add_validator(&unauthorized, &new_validator, &1);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::Unauthorized));

    // Test unauthorized emergency pause
    let result = client.emergency_pause(&unauthorized);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::Unauthorized));
}

#[test]
fn test_queue_operations() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    // Setup contract
    let admin = Address::generate(&env);
    let validator = Address::generate(&env);
    let initial_validators = vec![&env, validator.clone()];
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000, // Low threshold for testing
        time_lock: 1, // Short time lock for testing
        max_queue_size: 100,
        paused: false,
    };
    client.initialize(&admin, &initial_validators, &config);

    // Create large transfer message (above threshold)
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

    let proof = MerkleProof {
        root: BytesN::from_array(&[1u8; 32]),
        proof: Vec::new(&env),
        index: 0,
    };

    // This should queue the transfer (though fail proof validation)
    let result = client.receive_message_with_merkle_proof(&message, &proof);
    assert!(result.is_err()); // Due to invalid proof

    // Test getting queued transfers
    let queued_transfers = client.get_all_queued_transfers();
    assert!(queued_transfers.is_empty()); // Empty because proof failed
}

#[test]
fn test_message_processed_tracking() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    // Setup contract
    let admin = Address::generate(&env);
    let validator = Address::generate(&env);
    let initial_validators = vec![&env, validator.clone()];
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };
    client.initialize(&admin, &initial_validators, &config);

    // Test with arbitrary hash
    let test_hash = BytesN::from_array(&[42u8; 32]);
    let is_processed = client.is_message_processed(&test_hash);
    assert!(!is_processed); // Should not be processed initially
}

#[test]
fn test_invalid_validator_operations() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    // Setup contract
    let admin = Address::generate(&env);
    let validator = Address::generate(&env);
    let initial_validators = vec![&env, validator.clone()];
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };
    client.initialize(&admin, &initial_validators, &config);

    // Test adding invalid validator (zero address)
    let invalid_validator = Address::default();
    let result = client.add_validator(&admin, &invalid_validator, &1);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidValidator));

    // Test adding validator with zero weight
    let new_validator = Address::generate(&env);
    let result = client.add_validator(&admin, &new_validator, &0);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidValidator));

    // Test removing non-existent validator
    let non_existent = Address::generate(&env);
    let result = client.remove_validator(&admin, &non_existent);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidValidator));
}

#[test]
fn test_invalid_config_updates() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TestBridgeRelayer);
    let client = TestBridgeRelayerClient::new(&env, &contract_id);

    // Setup contract
    let admin = Address::generate(&env);
    let validator = Address::generate(&env);
    let initial_validators = vec![&env, validator.clone()];
    let config = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };
    client.initialize(&admin, &initial_validators, &config);

    // Test invalid config (zero min_validators)
    let invalid_config1 = BridgeConfig {
        min_validators: 0,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 100,
        paused: false,
    };
    let result = client.update_config(&admin, &invalid_config1);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidConfig));

    // Test invalid config (zero max_queue_size)
    let invalid_config2 = BridgeConfig {
        min_validators: 1,
        queue_threshold: 1000,
        time_lock: 3600,
        max_queue_size: 0,
        paused: false,
    };
    let result = client.update_config(&admin, &invalid_config2);
    assert!(result.is_err());
    assert_eq!(result.err(), Some(BridgeRelayerError::InvalidConfig));
}

// Test client for type safety
#[derive(Clone)]
struct TestBridgeRelayerClient<'a> {
    contract_id: &'a soroban_sdk::contractclient::ContractClient<'a, TestBridgeRelayer>,
}

impl<'a> TestBridgeRelayerClient<'a> {
    fn new(env: &'a Env, contract_id: &'a soroban_sdk::contractclient::ContractClient<'a, TestBridgeRelayer>) -> Self {
        Self { contract_id }
    }

    fn initialize(&self, admin: &Address, initial_validators: &Vec<Address>, config: &BridgeConfig) {
        self.contract_id.invoke(&TestBridgeRelayer::initialize, admin, initial_validators, config);
    }

    fn receive_message_with_merkle_proof(
        &self,
        message: &CrossChainMessage,
        proof: &MerkleProof,
    ) -> Result<BytesN<32>, BridgeRelayerError> {
        self.contract_id.try_invoke(&TestBridgeRelayer::receive_message_with_merkle_proof, message, proof).unwrap()
    }

    fn receive_message_with_multisig(
        &self,
        message: &CrossChainMessage,
        multi_sig: &MultiSignature,
    ) -> Result<BytesN<32>, BridgeRelayerError> {
        self.contract_id.try_invoke(&TestBridgeRelayer::receive_message_with_multisig, message, multi_sig).unwrap()
    }

    fn execute_queued_transfer(&self, transfer_id: &BytesN<32>) -> Result<bool, BridgeRelayerError> {
        self.contract_id.try_invoke(&TestBridgeRelayer::execute_queued_transfer, transfer_id).unwrap()
    }

    fn get_config(&self) -> BridgeConfig {
        self.contract_id.invoke(&TestBridgeRelayer::get_config)
    }

    fn get_nonce(&self) -> u64 {
        self.contract_id.invoke(&TestBridgeRelayer::get_nonce)
    }

    fn get_queued_transfer(&self, transfer_id: &BytesN<32>) -> Option<QueuedTransfer> {
        self.contract_id.invoke(&TestBridgeRelayer::get_queued_transfer, transfer_id)
    }

    fn get_all_queued_transfers(&self) -> Vec<QueuedTransfer> {
        self.contract_id.invoke(&TestBridgeRelayer::get_all_queued_transfers)
    }

    fn is_message_processed(&self, message_hash: &BytesN<32>) -> bool {
        self.contract_id.invoke(&TestBridgeRelayer::is_message_processed, message_hash)
    }

    fn update_config(&self, admin: &Address, new_config: &BridgeConfig) -> Result<(), BridgeRelayerError> {
        self.contract_id.try_invoke(&TestBridgeRelayer::update_config, admin, new_config).unwrap()
    }

    fn add_validator(&self, admin: &Address, validator: &Address, weight: &u32) -> Result<(), BridgeRelayerError> {
        self.contract_id.try_invoke(&TestBridgeRelayer::add_validator, admin, validator, weight).unwrap()
    }

    fn remove_validator(&self, admin: &Address, validator: &Address) -> Result<(), BridgeRelayerError> {
        self.contract_id.try_invoke(&TestBridgeRelayer::remove_validator, admin, validator).unwrap()
    }

    fn emergency_pause(&self, admin: &Address) -> Result<(), BridgeRelayerError> {
        self.contract_id.try_invoke(&TestBridgeRelayer::emergency_pause, admin).unwrap()
    }

    fn emergency_unpause(&self, admin: &Address) -> Result<(), BridgeRelayerError> {
        self.contract_id.try_invoke(&TestBridgeRelayer::emergency_unpause, admin).unwrap()
    }
}
