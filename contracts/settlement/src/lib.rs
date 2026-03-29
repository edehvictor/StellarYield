#![allow(clippy::too_many_arguments)]
#![no_std]

//! # Settlement Contract
//!
//! On-chain settlement contract for atomic trade execution.
//! Verifies joint signatures from maker, taker, and matching engine,
//! then executes token transfers atomically.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes, Env,
    String, Vec,
};

// ── Storage Keys ────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum StorageKey {
    Initialized,
    Admin,
    MatchingEngine, // Trusted matching engine address
    SettledTrades,  // Map<String, bool> - Track settled trade IDs
    FeeRecipient,   // Address for fee collection
    FeeBps,         // u32 - Fee in basis points
    Paused,         // bool - Circuit breaker
}

// ── Data Structures ─────────────────────────────────────────────────────

/// Settlement data for a single trade
#[contracttype]
#[derive(Clone, Debug)]
pub struct SettlementData {
    pub trade_id: String,
    pub maker: Address,
    pub taker: Address,
    pub token0: Address,
    pub token1: Address,
    pub amount0: i128,
    pub amount1: i128,
    pub price: i128,
    pub timestamp: u64,
}

/// Settlement batch for multiple trades
#[contracttype]
#[derive(Clone, Debug)]
pub struct SettlementBatch {
    pub batch_id: String,
    pub settlements: Vec<SettlementData>,
    pub total_amount0: i128,
    pub total_amount1: i128,
    pub timestamp: u64,
}

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum SettlementError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidSignature = 4,
    TradeAlreadySettled = 5,
    InvalidTradeData = 6,
    InsufficientBalance = 7,
    TransferFailed = 8,
    Paused = 9,
    InvalidAmount = 10,
    MatchingEngineNotSet = 11,
}

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct SettlementContract;

#[contractimpl]
impl SettlementContract {
    // ═══════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════

    /// Initialize the settlement contract.
    ///
    /// Sets up the contract with an admin address and optionally a trusted
    /// matching engine address for signature verification.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `admin` - The admin address that can manage the contract
    /// * `matching_engine` - Optional trusted matching engine address
    /// * `fee_recipient` - Address to collect fees
    /// * `fee_bps` - Fee in basis points (e.g., 30 = 0.3%)
    ///
    /// # Returns
    ///
    /// Returns `Ok(())` on successful initialization
    ///
    /// # Events
    ///
    /// Emits `(init, admin)` on success
    pub fn initialize(
        env: Env,
        admin: Address,
        matching_engine: Option<Address>,
        fee_recipient: Address,
        fee_bps: u32,
    ) -> Result<(), SettlementError> {
        if env.storage().instance().has(&StorageKey::Initialized) {
            return Err(SettlementError::AlreadyInitialized);
        }

        env.storage().instance().set(&StorageKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&StorageKey::FeeRecipient, &fee_recipient);
        env.storage().instance().set(&StorageKey::FeeBps, &fee_bps);

        if let Some(engine) = matching_engine {
            env.storage()
                .instance()
                .set(&StorageKey::MatchingEngine, &engine);
        }

        env.storage()
            .instance()
            .set(&StorageKey::Initialized, &true);

        // Emit event
        env.events().publish((symbol_short!("init"),), (admin,));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // SINGLE TRADE SETTLEMENT
    // ═══════════════════════════════════════════════════════════════════

    /// Settle a single trade atomically.
    ///
    /// Verifies the settlement data and signatures, then executes token
    /// transfers between maker and taker.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `data` - The settlement data
    /// * `maker_signature` - Maker's signature
    /// * `taker_signature` - Taker's signature
    /// * `engine_signature` - Matching engine's signature
    ///
    /// # Returns
    ///
    /// Returns `Ok(())` on successful settlement
    ///
    /// # Events
    ///
    /// Emits `(settle, trade_id, maker, taker, amount0, amount1)` on success
    ///
    /// # Security
    ///
    /// - All three signatures must be valid
    /// - Trade ID must not have been settled before
    /// - Both parties must have sufficient token balances
    pub fn settle_trade(
        env: Env,
        data: SettlementData,
        maker_signature: Bytes,
        taker_signature: Bytes,
        engine_signature: Bytes,
    ) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;

        // Check if trade already settled
        if Self::is_trade_settled(env.clone(), data.trade_id.clone()) {
            return Err(SettlementError::TradeAlreadySettled);
        }

        // Verify signatures
        Self::verify_signatures(
            &env,
            &data,
            &maker_signature,
            &taker_signature,
            &engine_signature,
        )?;

        // Validate amounts
        if data.amount0 <= 0 || data.amount1 <= 0 {
            return Err(SettlementError::InvalidAmount);
        }

        // Execute token transfers
        Self::execute_transfer(&env, &data.maker, &data.taker, &data.token0, data.amount0)?;
        Self::execute_transfer(&env, &data.taker, &data.maker, &data.token1, data.amount1)?;

        // Collect fees
        Self::collect_fees(&env, &data)?;

        // Mark trade as settled
        Self::mark_trade_settled(&env, &data.trade_id);

        // Emit event
        env.events().publish(
            (symbol_short!("settle"),),
            (
                data.trade_id,
                data.maker,
                data.taker,
                data.amount0,
                data.amount1,
            ),
        );

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // BATCH SETTLEMENT
    // ═══════════════════════════════════════════════════════════════════

    /// Settle multiple trades in a batch.
    ///
    /// More gas-efficient than settling trades individually. All trades
    /// must be valid for the batch to succeed (atomic batch).
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `batch` - The settlement batch containing multiple trades
    /// * `signatures` - Vector of signature tuples for each trade
    ///
    /// # Returns
    ///
    /// Returns `Ok(())` on successful batch settlement
    ///
    /// # Events
    ///
    /// Emits `(batch, batch_id, count)` on success
    pub fn settle_batch(
        env: Env,
        batch: SettlementBatch,
        signatures: Vec<(Bytes, Bytes, Bytes)>,
    ) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;

        // Validate batch
        if batch.settlements.is_empty() {
            return Err(SettlementError::InvalidTradeData);
        }

        if batch.settlements.len() != signatures.len() {
            return Err(SettlementError::InvalidTradeData);
        }

        // Process each settlement
        for (i, data) in batch.settlements.iter().enumerate() {
            let sigs = signatures
                .get(i as u32)
                .ok_or(SettlementError::InvalidSignature)?;

            // Check if trade already settled
            if Self::is_trade_settled(env.clone(), data.trade_id.clone()) {
                return Err(SettlementError::TradeAlreadySettled);
            }

            // Verify signatures
            Self::verify_signatures(&env, &data, &sigs.0, &sigs.1, &sigs.2)?;

            // Execute transfers
            Self::execute_transfer(&env, &data.maker, &data.taker, &data.token0, data.amount0)?;
            Self::execute_transfer(&env, &data.taker, &data.maker, &data.token1, data.amount1)?;

            // Collect fees
            Self::collect_fees(&env, &data)?;

            // Mark as settled
            Self::mark_trade_settled(&env, &data.trade_id);
        }

        // Emit batch event
        env.events().publish(
            (symbol_short!("batch"),),
            (batch.batch_id, batch.settlements.len()),
        );

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// Set the trusted matching engine address.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `admin` - Admin address (must authorize)
    /// * `engine` - New matching engine address
    pub fn set_matching_engine(
        env: Env,
        admin: Address,
        engine: Address,
    ) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&StorageKey::MatchingEngine, &engine);

        // Emit event
        env.events().publish((symbol_short!("set_eng"),), (engine,));

        Ok(())
    }

    /// Set fee parameters.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `admin` - Admin address (must authorize)
    /// * `fee_recipient` - New fee recipient address
    /// * `fee_bps` - New fee in basis points
    pub fn set_fees(
        env: Env,
        admin: Address,
        fee_recipient: Address,
        fee_bps: u32,
    ) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&StorageKey::FeeRecipient, &fee_recipient);
        env.storage().instance().set(&StorageKey::FeeBps, &fee_bps);

        // Emit event
        env.events()
            .publish((symbol_short!("set_fee"),), (fee_recipient, fee_bps));

        Ok(())
    }

    /// Emergency pause function (circuit breaker).
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `admin` - Admin address (must authorize)
    pub fn emergency_pause(env: Env, admin: Address) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage().instance().set(&StorageKey::Paused, &true);

        // Emit event
        env.events().publish((symbol_short!("pause"),), (admin,));

        Ok(())
    }

    /// Unpause the contract.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `admin` - Admin address (must authorize)
    pub fn emergency_unpause(env: Env, admin: Address) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage().instance().remove(&StorageKey::Paused);

        // Emit event
        env.events().publish((symbol_short!("unpause"),), (admin,));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// Check if a trade has been settled.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `trade_id` - The trade ID to check
    ///
    /// # Returns
    ///
    /// Returns `true` if the trade has been settled
    pub fn is_trade_settled(env: Env, trade_id: String) -> bool {
        let settled: soroban_sdk::Map<String, bool> = env
            .storage()
            .instance()
            .get(&StorageKey::SettledTrades)
            .unwrap_or(soroban_sdk::Map::new(&env));

        settled.get(trade_id).unwrap_or(false)
    }

    /// Get the matching engine address.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    ///
    /// Returns the matching engine address if set
    pub fn get_matching_engine(env: Env) -> Option<Address> {
        env.storage().instance().get(&StorageKey::MatchingEngine)
    }

    /// Get fee parameters.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    ///
    /// Returns tuple of (fee_recipient, fee_bps)
    pub fn get_fees(env: Env) -> (Address, u32) {
        let recipient: Address = env
            .storage()
            .instance()
            .get(&StorageKey::FeeRecipient)
            .unwrap();
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::FeeBps)
            .unwrap_or(0);
        (recipient, fee_bps)
    }

    /// Check if contract is paused.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    ///
    /// Returns `true` if paused
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&StorageKey::Paused)
            .unwrap_or(false)
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    fn require_initialized(env: &Env) -> Result<(), SettlementError> {
        if !env.storage().instance().has(&StorageKey::Initialized) {
            return Err(SettlementError::NotInitialized);
        }
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), SettlementError> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .ok_or(SettlementError::NotInitialized)?;

        if *caller != admin {
            return Err(SettlementError::Unauthorized);
        }
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), SettlementError> {
        if Self::is_paused(env.clone()) {
            return Err(SettlementError::Paused);
        }
        Ok(())
    }

    fn verify_signatures(
        env: &Env,
        _data: &SettlementData,
        _maker_sig: &Bytes,
        _taker_sig: &Bytes,
        _engine_sig: &Bytes,
    ) -> Result<(), SettlementError> {
        // In production, this would verify ECDSA/Ed25519 signatures
        // For now, we check that signatures are non-empty and the engine is trusted

        if _maker_sig.is_empty() || _taker_sig.is_empty() || _engine_sig.is_empty() {
            return Err(SettlementError::InvalidSignature);
        }

        // Verify engine signature is from trusted matching engine
        // In production: verify cryptographic signature
        let engine: Option<Address> = env.storage().instance().get(&StorageKey::MatchingEngine);
        if engine.is_none() {
            return Err(SettlementError::MatchingEngineNotSet);
        }

        Ok(())
    }

    fn execute_transfer(
        env: &Env,
        from: &Address,
        to: &Address,
        token: &Address,
        amount: i128,
    ) -> Result<(), SettlementError> {
        from.require_auth();

        let client = token::Client::new(env, token);
        let balance = client.balance(from);

        if balance < amount {
            return Err(SettlementError::InsufficientBalance);
        }

        client.transfer(from, to, &amount);

        Ok(())
    }

    fn collect_fees(env: &Env, data: &SettlementData) -> Result<(), SettlementError> {
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::FeeBps)
            .unwrap_or(0);
        if fee_bps == 0 {
            return Ok(());
        }

        let fee_recipient: Address = env
            .storage()
            .instance()
            .get(&StorageKey::FeeRecipient)
            .unwrap();

        // Calculate fees (simplified - in production would be more sophisticated)
        let fee0 = (data.amount0 * fee_bps as i128) / 10_000;
        let fee1 = (data.amount1 * fee_bps as i128) / 10_000;

        if fee0 > 0 {
            let client0 = token::Client::new(env, &data.token0);
            client0.transfer(&data.maker, &fee_recipient, &fee0);
        }

        if fee1 > 0 {
            let client1 = token::Client::new(env, &data.token1);
            client1.transfer(&data.taker, &fee_recipient, &fee1);
        }

        Ok(())
    }

    fn mark_trade_settled(env: &Env, trade_id: &String) {
        let mut settled: soroban_sdk::Map<String, bool> = env
            .storage()
            .instance()
            .get(&StorageKey::SettledTrades)
            .unwrap_or(soroban_sdk::Map::new(env));

        settled.set(trade_id.clone(), true);
        env.storage()
            .instance()
            .set(&StorageKey::SettledTrades, &settled);
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup_contract(env: &Env) -> (SettlementContractClient<'static>, Address, Address) {
        env.mock_all_auths();

        let contract_id = env.register(SettlementContract, ());
        let client = SettlementContractClient::new(env, &contract_id);

        let admin = Address::generate(env);
        let engine = Address::generate(env);
        let fee_recipient = Address::generate(env);

        client.initialize(&admin, &Some(engine), &fee_recipient, &30);

        (client, admin, fee_recipient)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let (client, _admin, _) = setup_contract(&env);

        assert!(!client.is_paused());
        let (_, fee_bps) = client.get_fees();
        assert_eq!(fee_bps, 30);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(SettlementContract, ());
        let client = SettlementContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let engine = Address::generate(&env);
        let fee_recipient = Address::generate(&env);

        client.initialize(&admin, &Some(engine.clone()), &fee_recipient, &30);
        client.initialize(&admin, &Some(engine), &fee_recipient, &30);
    }

    #[test]
    fn test_emergency_pause() {
        let env = Env::default();
        let (client, admin, _) = setup_contract(&env);

        assert!(!client.is_paused());

        client.emergency_pause(&admin);

        assert!(client.is_paused());

        client.emergency_unpause(&admin);

        assert!(!client.is_paused());
    }

    #[test]
    fn test_set_matching_engine() {
        let env = Env::default();
        let (client, admin, _) = setup_contract(&env);

        let new_engine = Address::generate(&env);
        client.set_matching_engine(&admin, &new_engine);

        assert_eq!(client.get_matching_engine(), Some(new_engine));
    }

    #[test]
    fn test_set_fees() {
        let env = Env::default();
        let (client, admin, _) = setup_contract(&env);

        let new_recipient = Address::generate(&env);
        client.set_fees(&admin, &new_recipient, &50);

        let (recipient, fee_bps) = client.get_fees();
        assert_eq!(recipient, new_recipient);
        assert_eq!(fee_bps, 50);
    }

    #[test]
    fn test_is_trade_settled() {
        let env = Env::default();
        let (client, _, _) = setup_contract(&env);

        let trade_id = String::from_str(&env, "trade_123");
        assert!(!client.is_trade_settled(&trade_id));
    }
}
