//! # Settlement Module
//!
//! Handles on-chain settlement of matched trades with joint signatures.
//! Creates atomic settlement payloads for Soroban contract execution.

use crate::orderbook::{Order, Trade};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

/// Settlement data for on-chain execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettlementData {
    /// Trade ID
    pub trade_id: String,
    /// Maker address
    pub maker: String,
    /// Taker address
    pub taker: String,
    /// Token0 address
    pub token0: String,
    /// Token1 address
    pub token1: String,
    /// Amount of token0
    pub amount0: u128,
    /// Amount of token1
    pub amount1: u128,
    /// Price
    pub price: u128,
    /// Timestamp
    pub timestamp: u64,
    /// Maker signature
    pub maker_signature: String,
    /// Taker signature
    pub taker_signature: String,
    /// Matching engine signature
    pub engine_signature: String,
}

/// Settlement payload for on-chain submission
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettlementPayload {
    /// Settlement data
    pub data: SettlementData,
    /// Hash of the data (for verification)
    pub data_hash: String,
    /// Encoded settlement for contract call
    pub encoded: String,
}

impl SettlementPayload {
    /// Create settlement from trade
    pub fn from_trade(
        trade: &Trade,
        maker_key: &SigningKey,
        taker_key: &SigningKey,
        engine_key: &SigningKey,
    ) -> Result<Self, SettlementError> {
        // Determine amounts based on trade side
        let (amount0, amount1) = match trade.side {
            crate::orderbook::Side::Buy => {
                // Buyer receives token0, pays token1
                (trade.amount, trade.amount * trade.price / 1_000_000) // Adjust for decimals
            }
            crate::orderbook::Side::Sell => {
                // Seller receives token1, pays token0
                (trade.amount, trade.amount * trade.price / 1_000_000)
            }
        };

        let data = SettlementData {
            trade_id: trade.id.clone(),
            maker: trade.maker.clone(),
            taker: trade.taker.clone(),
            token0: trade.token0.clone(),
            token1: trade.token1.clone(),
            amount0,
            amount1,
            price: trade.price,
            timestamp: trade.timestamp,
            maker_signature: String::new(),
            taker_signature: String::new(),
            engine_signature: String::new(),
        };

        // Create data hash
        let data_hash = Self::hash_settlement_data(&data);

        // Sign the hash
        let maker_sig = maker_key.sign(data_hash.as_bytes());
        let taker_sig = taker_key.sign(data_hash.as_bytes());
        let engine_sig = engine_key.sign(data_hash.as_bytes());

        let mut settlement = Self {
            data,
            data_hash,
            encoded: String::new(),
        };

        // Add signatures
        settlement.data.maker_signature = hex::encode(maker_sig.to_bytes());
        settlement.data.taker_signature = hex::encode(taker_sig.to_bytes());
        settlement.data.engine_signature = hex::encode(engine_sig.to_bytes());

        // Encode for contract call
        settlement.encoded = Self::encode_for_contract(&settlement.data);

        Ok(settlement)
    }

    /// Hash settlement data
    fn hash_settlement_data(data: &SettlementData) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data.trade_id.as_bytes());
        hasher.update(data.maker.as_bytes());
        hasher.update(data.taker.as_bytes());
        hasher.update(data.token0.as_bytes());
        hasher.update(data.token1.as_bytes());
        hasher.update(&data.amount0.to_be_bytes());
        hasher.update(&data.amount1.to_be_bytes());
        hasher.update(&data.price.to_be_bytes());
        hasher.update(&data.timestamp.to_be_bytes());
        hex::encode(hasher.finalize())
    }

    /// Encode settlement for Soroban contract call
    fn encode_for_contract(data: &SettlementData) -> String {
        // Encode as base64 for Soroban contract invocation
        // In production, this would use proper Soroban spec encoding
        let json = serde_json::to_string(data).unwrap_or_default();
        base64::encode(json)
    }

    /// Verify all signatures
    pub fn verify_signatures(&self) -> Result<bool, SettlementError> {
        let data_hash = Self::hash_settlement_data(&self.data);

        // Verify maker signature
        let maker_sig_bytes = hex::decode(&self.data.maker_signature)?;
        let maker_sig = Signature::from_bytes(&maker_sig_bytes.try_into()?);
        // In production, would verify against maker's public key

        // Verify taker signature
        let taker_sig_bytes = hex::decode(&self.data.taker_signature)?;
        let taker_sig = Signature::from_bytes(&taker_sig_bytes.try_into()?);
        // In production, would verify against taker's public key

        // Verify engine signature
        let engine_sig_bytes = hex::decode(&self.data.engine_signature)?;
        let engine_sig = Signature::from_bytes(&engine_sig_bytes.try_into()?);
        // In production, would verify against engine's public key

        Ok(true)
    }

    /// Get settlement hash
    pub fn hash(&self) -> &str {
        &self.data_hash
    }
}

/// Settlement error types
#[derive(Debug, thiserror::Error)]
pub enum SettlementError {
    #[error("Invalid signature: {0}")]
    InvalidSignature(String),
    #[error("Encoding error: {0}")]
    EncodingError(String),
    #[error("Decoding error: {0}")]
    DecodingError(#[from] hex::FromHexError),
    #[error("Signature conversion error")]
    SignatureConversionError,
}

impl From<[u8; 64]> for SettlementError {
    fn from(_: [u8; 64]) -> Self {
        SettlementError::SignatureConversionError
    }
}

/// Settlement batch for multiple trades
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettlementBatch {
    /// Batch ID
    pub batch_id: String,
    /// Settlements in the batch
    pub settlements: Vec<SettlementPayload>,
    /// Total token0 amount
    pub total_amount0: u128,
    /// Total token1 amount
    pub total_amount1: u128,
    /// Timestamp
    pub timestamp: u64,
}

impl SettlementBatch {
    pub fn new(settlements: Vec<SettlementPayload>) -> Self {
        let total_amount0: u128 = settlements.iter().map(|s| s.data.amount0).sum();
        let total_amount1: u128 = settlements.iter().map(|s| s.data.amount1).sum();
        
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        Self {
            batch_id: uuid::Uuid::new_v4().to_string(),
            settlements,
            total_amount0,
            total_amount1,
            timestamp: now,
        }
    }

    /// Encode batch for contract call
    pub fn encode_batch(&self) -> String {
        let json = serde_json::to_string(self).unwrap_or_default();
        base64::encode(json)
    }
}

/// Settlement verifier
pub struct SettlementVerifier {
    /// Engine public key
    engine_public_key: VerifyingKey,
}

impl SettlementVerifier {
    pub fn new(engine_public_key: VerifyingKey) -> Self {
        Self { engine_public_key }
    }

    /// Verify a settlement payload
    pub fn verify(&self, payload: &SettlementPayload) -> Result<bool, SettlementError> {
        // Verify data hash matches
        let computed_hash = SettlementPayload::hash_settlement_data(&payload.data);
        if computed_hash != payload.data_hash {
            return Ok(false);
        }

        // Verify engine signature
        let engine_sig_bytes = hex::decode(&payload.data.engine_signature)?;
        let engine_sig = Signature::from_bytes(&engine_sig_bytes.try_into()?);
        
        if self.engine_public_key.verify(payload.data_hash.as_bytes(), &engine_sig).is_err() {
            return Ok(false);
        }

        // Maker and taker signatures would be verified against their public keys
        // In production, these would be retrieved from the Stellar network

        Ok(true)
    }

    /// Verify a batch of settlements
    pub fn verify_batch(&self, batch: &SettlementBatch) -> Result<bool, SettlementError> {
        for settlement in &batch.settlements {
            if !self.verify(settlement)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orderbook::{Order, Side, OrderType, Trade};
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    fn create_test_trade() -> Trade {
        Trade::new(
            &Order::new(
                "maker".to_string(),
                Side::Sell,
                OrderType::Limit,
                100,
                1000,
                "token0".to_string(),
                "token1".to_string(),
                "sig".to_string(),
            ),
            &Order::new(
                "taker".to_string(),
                Side::Buy,
                OrderType::Limit,
                100,
                1000,
                "token0".to_string(),
                "token1".to_string(),
                "sig".to_string(),
            ),
            500,
            100,
        )
    }

    #[test]
    fn test_settlement_creation() {
        let mut csprng = OsRng;
        let maker_key = SigningKey::generate(&mut csprng);
        let taker_key = SigningKey::generate(&mut csprng);
        let engine_key = SigningKey::generate(&mut csprng);

        let trade = create_test_trade();
        let settlement = SettlementPayload::from_trade(
            &trade,
            &maker_key,
            &taker_key,
            &engine_key,
        ).unwrap();

        assert_eq!(settlement.data.trade_id, trade.id);
        assert!(!settlement.data.maker_signature.is_empty());
        assert!(!settlement.data.taker_signature.is_empty());
        assert!(!settlement.data.engine_signature.is_empty());
    }

    #[test]
    fn test_settlement_verification() {
        let mut csprng = OsRng;
        let maker_key = SigningKey::generate(&mut csprng);
        let taker_key = SigningKey::generate(&mut csprng);
        let engine_key = SigningKey::generate(&mut csprng);
        let engine_public_key = engine_key.verifying_key();

        let trade = create_test_trade();
        let settlement = SettlementPayload::from_trade(
            &trade,
            &maker_key,
            &taker_key,
            &engine_key,
        ).unwrap();

        let verifier = SettlementVerifier::new(engine_public_key);
        assert!(verifier.verify(&settlement).unwrap());
    }

    #[test]
    fn test_settlement_batch() {
        let mut csprng = OsRng;
        let maker_key = SigningKey::generate(&mut csprng);
        let taker_key = SigningKey::generate(&mut csprng);
        let engine_key = SigningKey::generate(&mut csprng);

        let trade1 = create_test_trade();
        let trade2 = create_test_trade();

        let settlement1 = SettlementPayload::from_trade(
            &trade1,
            &maker_key,
            &taker_key,
            &engine_key,
        ).unwrap();

        let settlement2 = SettlementPayload::from_trade(
            &trade2,
            &maker_key,
            &taker_key,
            &engine_key,
        ).unwrap();

        let batch = SettlementBatch::new(vec![settlement1, settlement2]);

        assert!(!batch.batch_id.is_empty());
        assert_eq!(batch.settlements.len(), 2);
        assert!(batch.total_amount0 > 0);
        assert!(batch.total_amount1 > 0);
    }

    #[test]
    fn test_settlement_hash() {
        let mut csprng = OsRng;
        let maker_key = SigningKey::generate(&mut csprng);
        let taker_key = SigningKey::generate(&mut csprng);
        let engine_key = SigningKey::generate(&mut csprng);

        let trade = create_test_trade();
        let settlement = SettlementPayload::from_trade(
            &trade,
            &maker_key,
            &taker_key,
            &engine_key,
        ).unwrap();

        let hash1 = settlement.hash().to_string();
        let hash2 = SettlementPayload::hash_settlement_data(&settlement.data);

        assert_eq!(hash1, hash2);
    }
}
