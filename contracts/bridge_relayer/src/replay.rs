use crate::{BridgeRelayerError, CrossChainMessage, NONCE_KEY};
use soroban_sdk::{contracttype, symbol_short, Address, BytesN, Env, Map, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplayStats {
    pub current_nonce: u64,
    pub total_processed: u32,
    pub recent_processed: u32,
    pub old_processed: u32,
}

pub struct ReplayProtection;

impl ReplayProtection {
    pub fn validate_and_update_nonce(
        env: &Env,
        message: &CrossChainMessage,
    ) -> Result<(), BridgeRelayerError> {
        let current_nonce = Self::get_current_nonce(env);
        let expected = if current_nonce == 0 { 1 } else { current_nonce };
        if message.nonce != expected {
            return Err(BridgeRelayerError::InvalidNonce);
        }
        env.storage()
            .instance()
            .set(&NONCE_KEY, &(message.nonce + 1));
        Ok(())
    }

    pub fn get_current_nonce(env: &Env) -> u64 {
        env.storage().instance().get(&NONCE_KEY).unwrap_or(0)
    }

    pub fn check_message_processed(
        env: &Env,
        message: &CrossChainMessage,
    ) -> Result<(), BridgeRelayerError> {
        let hash = Self::compute_message_hash(env, message);
        let processed_key = symbol_short!("HASHES");
        let processed_hashes: Map<BytesN<32>, u64> = env
            .storage()
            .instance()
            .get(&processed_key)
            .unwrap_or_else(|| Map::new(env));
        if processed_hashes.contains_key(hash) {
            return Err(BridgeRelayerError::MessageAlreadyProcessed);
        }
        Ok(())
    }

    pub fn mark_message_processed(env: &Env, message: &CrossChainMessage) {
        let hash = Self::compute_message_hash(env, message);
        let processed_key = symbol_short!("HASHES");
        let mut processed_hashes: Map<BytesN<32>, u64> = env
            .storage()
            .instance()
            .get(&processed_key)
            .unwrap_or_else(|| Map::new(env));
        processed_hashes.set(hash, env.ledger().timestamp());
        env.storage()
            .instance()
            .set(&processed_key, &processed_hashes);
    }

    pub fn compute_message_hash(env: &Env, message: &CrossChainMessage) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = message.source_chain as u8;
        arr[1] = message.target_chain as u8;
        let nonce_bytes = message.nonce.to_be_bytes();
        for i in 0..8 {
            arr[2 + i] = nonce_bytes[i];
        }
        let amount_bytes = message.amount.to_be_bytes();
        for i in 0..8 {
            arr[10 + i] = amount_bytes[i];
        }
        BytesN::from_array(env, &arr)
    }

    pub fn validate_message_format(message: &CrossChainMessage) -> Result<(), BridgeRelayerError> {
        if message.source_chain == 0 || message.target_chain == 0 {
            return Err(BridgeRelayerError::InvalidMessage);
        }
        if message.nonce == 0 {
            return Err(BridgeRelayerError::InvalidMessage);
        }
        if message.amount == 0 {
            return Err(BridgeRelayerError::InvalidMessage);
        }
        if message.metadata.len() > 1000 {
            return Err(BridgeRelayerError::InvalidMessage);
        }
        Ok(())
    }

    pub fn validate_chain_ids(
        _env: &Env,
        message: &CrossChainMessage,
        expected_source: u32,
        expected_target: u32,
    ) -> Result<(), BridgeRelayerError> {
        if message.source_chain != expected_source || message.target_chain != expected_target {
            return Err(BridgeRelayerError::InvalidMessage);
        }
        Ok(())
    }

    pub fn validate_message_timestamp(
        env: &Env,
        message: &CrossChainMessage,
        max_age: u64,
    ) -> Result<(), BridgeRelayerError> {
        if message.metadata.len() != 8 {
            return Err(BridgeRelayerError::InvalidMessage);
        }
        let mut bytes = [0u8; 8];
        message.metadata.copy_into_slice(&mut bytes);
        let msg_time = u64::from_be_bytes(bytes);
        let current_time = env.ledger().timestamp();

        if msg_time > current_time + 300 {
            return Err(BridgeRelayerError::InvalidMessage);
        }
        if current_time > msg_time + max_age {
            return Err(BridgeRelayerError::InvalidMessage);
        }
        Ok(())
    }

    pub fn reset_nonce(env: &Env, nonce: u64, _admin: &Address) -> Result<(), BridgeRelayerError> {
        env.storage().instance().set(&NONCE_KEY, &nonce);
        Ok(())
    }

    pub fn cleanup_processed_hashes(env: &Env, max_age: u64) {
        let processed_key = symbol_short!("HASHES");
        let processed_hashes: Map<BytesN<32>, u64> = env
            .storage()
            .instance()
            .get(&processed_key)
            .unwrap_or_else(|| Map::new(env));
        let current_time = env.ledger().timestamp();
        let mut updated = Map::new(env);
        for (hash, timestamp) in processed_hashes.iter() {
            if current_time <= timestamp + max_age {
                updated.set(hash, timestamp);
            }
        }
        env.storage().instance().set(&processed_key, &updated);
    }

    pub fn get_replay_stats(env: &Env) -> ReplayStats {
        let current_nonce = Self::get_current_nonce(env);
        let processed_key = symbol_short!("HASHES");
        let processed_hashes: Map<BytesN<32>, u64> = env
            .storage()
            .instance()
            .get(&processed_key)
            .unwrap_or_else(|| Map::new(env));
        let current_time = env.ledger().timestamp();
        let mut total_processed = 0;
        let mut recent_processed = 0;
        let mut old_processed = 0;
        for (_, timestamp) in processed_hashes.iter() {
            total_processed += 1;
            if current_time <= timestamp + 86400 {
                recent_processed += 1;
            } else {
                old_processed += 1;
            }
        }
        ReplayStats {
            current_nonce,
            total_processed,
            recent_processed,
            old_processed,
        }
    }

    pub fn batch_validate_messages(
        env: &Env,
        messages: &Vec<CrossChainMessage>,
        source_chain: u32,
        target_chain: u32,
    ) -> Vec<Result<(), BridgeRelayerError>> {
        let mut results = Vec::new(env);
        for message in messages.iter() {
            let res = (|| {
                Self::validate_chain_ids(env, &message, source_chain, target_chain)?;
                Self::check_message_processed(env, &message)?;
                Ok(())
            })();
            results.push_back(res);
        }
        results
    }
}
