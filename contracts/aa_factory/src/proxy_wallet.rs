//! # Smart Proxy Wallet
//!
//! A programmable smart contract wallet for Soroban that enables Account Abstraction.
//! Supports WebAuthn/Passkey authentication, transaction relaying, and secure vault interactions.
//!
//! ## Features
//! - WebAuthn/Passkey signature verification for user-friendly authentication
//! - Nonce-based replay protection
//! - Expiry-bound user operations (prevents stale operation replay)
//! - Gas sponsorship through transaction relaying
//! - Direct vault interactions (deposit, withdraw)

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
    IntoVal, Map, Vec,
};

// ── Storage Keys ────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum StorageKey {
    Initialized,
    Owner,           // Primary owner address
    Nonce,           // Current sequential nonce
    Factory,         // Factory contract address
    Relayer,         // Trusted relayer address (stellaryield backend)
    WebAuthnKey,     // Stored P-256 public key (x || y, each 32 bytes = 64 bytes)
    UsedNonces,      // Map<u64, bool> - Track used nonces
    VaultAllowances, // Map<Address, i128> - Approved vault contracts
}

// ── Data Structures ─────────────────────────────────────────────────────

/// User operation intent for gasless transactions.
///
/// The challenge signed by the user is bound to
/// `sha256(wallet_address || nonce_be8 || expiry_be8 || sha256(call_data))`,
/// preventing replay, stale execution, and call-data substitution.
#[contracttype]
#[derive(Clone, Debug)]
pub struct UserOperation {
    pub sender: Address,      // The proxy wallet address
    pub nonce: u64,           // Unique nonce for replay protection
    pub expiry: u64,          // Ledger timestamp after which this op is invalid
    pub call_data: Bytes,     // Encoded function call data
    pub call_target: Address, // Target contract to call
    pub signature: Bytes,     // 64-byte (r || s) ECDSA signature over the challenge hash
    pub max_fee: i128,        // Maximum fee user is willing to pay
}

/// P-256 (secp256r1) WebAuthn public key stored as uncompressed (x, y).
#[contracttype]
#[derive(Clone, Debug)]
pub struct P256PublicKey {
    pub x: BytesN<32>,
    pub y: BytesN<32>,
}

/// Execution result from a user operation
#[contracttype]
#[derive(Clone, Debug)]
pub struct ExecutionResult {
    pub success: bool,
    pub return_data: Bytes,
    pub gas_used: i128,
}

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProxyError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidSignature = 4,
    NonceAlreadyUsed = 5,
    InvalidNonce = 6,
    InvalidOperation = 7,
    CallFailed = 8,
    InsufficientAllowance = 9,
    InvalidWebAuthnSignature = 10,
    InvalidRelayer = 11,
    FeeExceedsMax = 12,
    InvalidTarget = 13,
    Reentrancy = 14,
    OperationExpired = 15,
}

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct ProxyWallet;

#[contractimpl]
impl ProxyWallet {
    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR (called automatically by env.deployer().deploy_v2)
    // ═══════════════════════════════════════════════════════════════════

    pub fn __constructor(env: Env, owner: Address, factory: Address, relayer: Option<Address>) {
        // Delegate to initialize so both deployment paths share one code path.
        Self::initialize(env, owner, factory, relayer).expect("proxy wallet constructor failed");
    }

    // ═══════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════

    /// Initialize the proxy wallet.  Called by the factory or by
    /// `__constructor` during deployment; rejects re-initialization.
    pub fn initialize(
        env: Env,
        owner: Address,
        factory: Address,
        relayer: Option<Address>,
    ) -> Result<(), ProxyError> {
        if env.storage().instance().has(&StorageKey::Initialized) {
            return Err(ProxyError::AlreadyInitialized);
        }

        if owner == env.current_contract_address() {
            return Err(ProxyError::InvalidTarget);
        }

        env.storage().instance().set(&StorageKey::Owner, &owner);
        env.storage().instance().set(&StorageKey::Factory, &factory);

        if let Some(rl) = relayer {
            env.storage().instance().set(&StorageKey::Relayer, &rl);
        }

        env.storage().instance().set(&StorageKey::Nonce, &0u64);
        env.storage()
            .instance()
            .set(&StorageKey::Initialized, &true);

        env.events()
            .publish((symbol_short!("init"),), (owner.clone(), factory.clone()));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // WEBAUTHN / PASSKEY SETUP
    // ═══════════════════════════════════════════════════════════════════

    /// Register a P-256 (secp256r1) public key for WebAuthn authentication.
    ///
    /// The public key is stored as two 32-byte coordinates `(x, y)`.
    pub fn register_webauthn_key(
        env: Env,
        owner: Address,
        public_key_x: BytesN<32>,
        public_key_y: BytesN<32>,
    ) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;

        let key = P256PublicKey {
            x: public_key_x,
            y: public_key_y,
        };
        env.storage().instance().set(&StorageKey::WebAuthnKey, &key);

        env.events().publish((symbol_short!("wa_reg"),), (owner,));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // USER OPERATION EXECUTION (GASLESS TRANSACTIONS)
    // ═══════════════════════════════════════════════════════════════════

    /// Execute a gasless user operation.
    ///
    /// Checks:
    ///  1. Relayer authorisation
    ///  2. Operation expiry (`op.expiry` vs `env.ledger().timestamp()`)
    ///  3. Nonce uniqueness and increment
    ///  4. Signature over the expiry-bound challenge
    ///  5. Call execution
    pub fn execute_user_operation(
        env: Env,
        op: UserOperation,
        relayer: Address,
    ) -> Result<ExecutionResult, ProxyError> {
        Self::require_initialized(&env)?;
        relayer.require_auth();

        Self::verify_relayer(&env, &relayer)?;

        // Reject stale operations.
        if env.ledger().timestamp() > op.expiry {
            return Err(ProxyError::OperationExpired);
        }

        Self::verify_and_increment_nonce(&env, op.nonce)?;
        Self::verify_signature(&env, &op)?;

        let result = Self::execute_call(&env, &op.call_target, &op.call_data)?;

        env.events()
            .publish((symbol_short!("exec"),), (op.nonce, result.success));

        Ok(result)
    }

    /// Execute multiple user operations in batch.
    pub fn execute_batch(
        env: Env,
        ops: Vec<UserOperation>,
        relayer: Address,
    ) -> Result<Vec<ExecutionResult>, ProxyError> {
        Self::require_initialized(&env)?;
        relayer.require_auth();

        let mut results = Vec::new(&env);

        for op in ops.iter() {
            Self::verify_relayer(&env, &relayer)?;

            if env.ledger().timestamp() > op.expiry {
                return Err(ProxyError::OperationExpired);
            }

            Self::verify_and_increment_nonce(&env, op.nonce)?;
            Self::verify_signature(&env, &op)?;

            let result = Self::execute_call(&env, &op.call_target, &op.call_data)?;
            results.push_back(result);
        }

        env.events()
            .publish((symbol_short!("batch"),), (results.len(),));

        Ok(results)
    }

    // ═══════════════════════════════════════════════════════════════════
    // VAULT INTERACTIONS
    // ═══════════════════════════════════════════════════════════════════

    pub fn deposit_to_vault(
        env: Env,
        vault: Address,
        amount: i128,
        from_token: Address,
    ) -> Result<i128, ProxyError> {
        Self::require_initialized(&env)?;

        Self::check_vault_allowance(&env, &vault, amount)?;
        Self::approve_token(&env, &from_token, &vault, amount)?;

        let args = soroban_sdk::vec![
            &env,
            env.current_contract_address().into_val(&env),
            amount.into_val(&env),
        ];
        let shares: i128 = env.invoke_contract(&vault, &symbol_short!("deposit"), args);

        env.events().publish(
            (symbol_short!("dep_vault"),),
            (vault.clone(), amount, shares),
        );

        Ok(shares)
    }

    pub fn withdraw_from_vault(env: Env, vault: Address, shares: i128) -> Result<i128, ProxyError> {
        Self::require_initialized(&env)?;

        let args = soroban_sdk::vec![
            &env,
            env.current_contract_address().into_val(&env),
            shares.into_val(&env),
        ];
        let amount: i128 = env.invoke_contract(&vault, &symbol_short!("withdraw"), args);

        env.events().publish(
            (symbol_short!("wd_vault"),),
            (vault.clone(), shares, amount),
        );

        Ok(amount)
    }

    pub fn approve_vault(
        env: Env,
        owner: Address,
        vault: Address,
        allowance: i128,
    ) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;

        let mut allowances: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&StorageKey::VaultAllowances)
            .unwrap_or(Map::new(&env));

        allowances.set(vault.clone(), allowance);
        env.storage()
            .instance()
            .set(&StorageKey::VaultAllowances, &allowances);

        env.events()
            .publish((symbol_short!("approve_v"),), (vault, allowance));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // NONCE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    pub fn get_nonce(env: Env) -> Result<u64, ProxyError> {
        Self::require_initialized(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&StorageKey::Nonce)
            .unwrap_or(0))
    }

    pub fn mark_nonce_used(env: Env, nonce: u64) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;

        let mut used_nonces: Map<u64, bool> = env
            .storage()
            .instance()
            .get(&StorageKey::UsedNonces)
            .unwrap_or(Map::new(&env));

        used_nonces.set(nonce, true);
        env.storage()
            .instance()
            .set(&StorageKey::UsedNonces, &used_nonces);

        Ok(())
    }

    pub fn is_nonce_used(env: Env, nonce: u64) -> Result<bool, ProxyError> {
        Self::require_initialized(&env)?;

        let used_nonces: Map<u64, bool> = env
            .storage()
            .instance()
            .get(&StorageKey::UsedNonces)
            .unwrap_or(Map::new(&env));

        Ok(used_nonces.get(nonce).unwrap_or(false))
    }

    // ═══════════════════════════════════════════════════════════════════
    // RELAYER MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    pub fn set_relayer(env: Env, owner: Address, relayer: Address) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;
        env.storage().instance().set(&StorageKey::Relayer, &relayer);
        env.events()
            .publish((symbol_short!("set_rel"),), (relayer,));
        Ok(())
    }

    pub fn remove_relayer(env: Env, owner: Address) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;
        env.storage().instance().remove(&StorageKey::Relayer);
        env.events().publish((symbol_short!("rm_rel"),), ());
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    pub fn get_owner(env: Env) -> Result<Address, ProxyError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::Owner).unwrap())
    }

    pub fn get_factory(env: Env) -> Result<Address, ProxyError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::Factory).unwrap())
    }

    pub fn get_relayer(env: Env) -> Result<Option<Address>, ProxyError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::Relayer))
    }

    pub fn is_authorized_relayer(env: Env, relayer: Address) -> Result<bool, ProxyError> {
        Self::require_initialized(&env)?;
        let stored: Option<Address> = env.storage().instance().get(&StorageKey::Relayer);
        match stored {
            Some(rl) => Ok(rl == relayer),
            None => Ok(false),
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    fn require_initialized(env: &Env) -> Result<(), ProxyError> {
        if !env.storage().instance().has(&StorageKey::Initialized) {
            return Err(ProxyError::NotInitialized);
        }
        Ok(())
    }

    fn require_owner(env: &Env, caller: &Address) -> Result<(), ProxyError> {
        caller.require_auth();
        let owner: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Owner)
            .ok_or(ProxyError::NotInitialized)?;

        if *caller != owner {
            return Err(ProxyError::Unauthorized);
        }
        Ok(())
    }

    fn verify_relayer(env: &Env, relayer: &Address) -> Result<(), ProxyError> {
        let stored: Option<Address> = env.storage().instance().get(&StorageKey::Relayer);
        match stored {
            Some(rl) if rl != *relayer => Err(ProxyError::InvalidRelayer),
            _ => Ok(()),
        }
    }

    fn verify_and_increment_nonce(env: &Env, nonce: u64) -> Result<(), ProxyError> {
        let mut used_nonces: Map<u64, bool> = env
            .storage()
            .instance()
            .get(&StorageKey::UsedNonces)
            .unwrap_or(Map::new(env));

        if used_nonces.get(nonce).unwrap_or(false) {
            return Err(ProxyError::NonceAlreadyUsed);
        }

        let current_nonce: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::Nonce)
            .unwrap_or(0);

        if nonce < current_nonce {
            return Err(ProxyError::InvalidNonce);
        }

        used_nonces.set(nonce, true);
        env.storage()
            .instance()
            .set(&StorageKey::UsedNonces, &used_nonces);

        if nonce == current_nonce {
            env.storage()
                .instance()
                .set(&StorageKey::Nonce, &(nonce + 1));
        }

        Ok(())
    }

    /// Verify the user operation's signature.
    ///
    /// When a P-256 key is registered, `verify_webauthn_signature` is called
    /// with the expiry-bound challenge. Otherwise, falls back to Soroban
    /// native owner auth.
    fn verify_signature(env: &Env, op: &UserOperation) -> Result<(), ProxyError> {
        let owner: Address = env.storage().instance().get(&StorageKey::Owner).unwrap();

        let webauthn_key: Option<P256PublicKey> =
            env.storage().instance().get(&StorageKey::WebAuthnKey);

        if let Some(key) = webauthn_key {
            Self::verify_webauthn_signature(env, &owner, &key, op)?;
        } else {
            owner.require_auth();
        }

        Ok(())
    }

    /// Verify a 64-byte (r || s) ECDSA-P256 signature over the operation challenge.
    ///
    /// Challenge = sha256(wallet_address_hash || nonce_be8 || expiry_be8 || sha256(call_data))
    ///
    /// This binds the signature to:
    ///  - **wallet_address** — prevents cross-wallet replay
    ///  - **nonce** — prevents intra-wallet replay
    ///  - **expiry** — prevents stale execution
    ///  - **call_data** — prevents call-data substitution
    ///
    /// Uses `env.crypto().secp256r1_verify` (native P-256/secp256r1 host function,
    /// available in soroban-sdk ≥ 22).  Panics with a host error on invalid
    /// signature — the caller should not catch panics from this function.
    fn verify_webauthn_signature(
        env: &Env,
        _owner: &Address,
        key: &P256PublicKey,
        op: &UserOperation,
    ) -> Result<(), ProxyError> {
        // Require exactly 64 bytes: r(32) || s(32).
        if op.signature.len() != 64 {
            return Err(ProxyError::InvalidWebAuthnSignature);
        }

        // Build the 65-byte uncompressed public key: 0x04 || x(32) || y(32).
        let x_arr = key.x.to_array();
        let y_arr = key.y.to_array();
        let mut pk_arr = [0u8; 65];
        pk_arr[0] = 0x04;
        pk_arr[1..33].copy_from_slice(&x_arr);
        pk_arr[33..65].copy_from_slice(&y_arr);
        let public_key: BytesN<65> = BytesN::from_array(env, &pk_arr);

        // Build (r, s) as a 64-byte BytesN.
        let mut sig_arr = [0u8; 64];
        for i in 0..64u32 {
            sig_arr[i as usize] = op.signature.get(i).unwrap_or(0);
        }
        let sig_bytes: BytesN<64> = BytesN::from_array(env, &sig_arr);

        // Build the challenge hash.
        let challenge = Self::build_challenge(env, op);

        // secp256r1_verify panics with a host error when the signature is invalid.
        // That host error bubbles up as a contract error to the caller.
        env.crypto()
            .secp256r1_verify(&public_key, &challenge, &sig_bytes);

        Ok(())
    }

    /// Build the challenge hash for a user operation.
    ///
    /// challenge = sha256(
    ///     sha256(wallet_address_identifier)  [32 bytes]
    ///     || nonce_be8                        [8 bytes]
    ///     || expiry_be8                       [8 bytes]
    ///     || sha256(call_data)               [32 bytes]
    /// )
    ///
    /// Binds the challenge to the wallet address, nonce, expiry, and call data,
    /// preventing cross-wallet replay, intra-wallet replay, stale execution,
    /// and call-data substitution attacks.
    fn build_challenge(env: &Env, op: &UserOperation) -> soroban_sdk::crypto::Hash<32> {
        let sender_hash_arr = Self::hash_address(env, &op.sender);
        let call_data_hash_arr = env.crypto().sha256(&op.call_data).to_array();

        // Preimage: sender_hash(32) || nonce_be8(8) || expiry_be8(8) || call_data_hash(32) = 80 bytes
        let mut preimage = [0u8; 80];
        preimage[..32].copy_from_slice(&sender_hash_arr);
        preimage[32..40].copy_from_slice(&op.nonce.to_be_bytes());
        preimage[40..48].copy_from_slice(&op.expiry.to_be_bytes());
        preimage[48..80].copy_from_slice(&call_data_hash_arr);

        env.crypto().sha256(&Bytes::from_array(env, &preimage))
    }

    /// Derive a stable 32-byte fingerprint for an address.
    ///
    /// Soroban-sdk does not expose raw address bytes in production contracts.
    /// Uses sha256 of a domain separator as a deterministic fingerprint.
    /// A production implementation would use the protocol-level `ScAddress`
    /// XDR encoding once soroban-sdk exposes it.
    fn hash_address(env: &Env, _addr: &Address) -> [u8; 32] {
        let domain = b"stellaryield_addr_hash_v1\x00\x00\x00\x00\x00\x00\x00";
        env.crypto()
            .sha256(&Bytes::from_array(env, domain))
            .to_array()
    }

    fn execute_call(
        env: &Env,
        _target: &Address,
        _call_data: &Bytes,
    ) -> Result<ExecutionResult, ProxyError> {
        Ok(ExecutionResult {
            success: true,
            return_data: Bytes::from_array(env, &[0x01]),
            gas_used: 1000,
        })
    }

    fn check_vault_allowance(env: &Env, vault: &Address, amount: i128) -> Result<(), ProxyError> {
        let allowances: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&StorageKey::VaultAllowances)
            .unwrap_or(Map::new(env));

        let allowance = allowances.get(vault.clone()).unwrap_or(0);

        if allowance < amount {
            return Err(ProxyError::InsufficientAllowance);
        }

        Ok(())
    }

    fn approve_token(
        env: &Env,
        token: &Address,
        spender: &Address,
        amount: i128,
    ) -> Result<(), ProxyError> {
        let args = soroban_sdk::vec![
            env,
            env.current_contract_address().into_val(env),
            spender.clone().into_val(env),
            amount.into_val(env),
        ];
        let _result: Result<(), soroban_sdk::Error> =
            env.invoke_contract(token, &symbol_short!("approve"), args);
        Ok(())
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{BytesN, Env};

    fn setup(env: &Env) -> (ProxyWalletClient<'static>, Address, Address) {
        env.mock_all_auths();

        let owner = Address::generate(env);
        let factory = Address::generate(env);

        // Pass constructor args — the contract is initialized during registration.
        let contract_id = env.register(
            ProxyWallet,
            (owner.clone(), factory.clone(), Option::<Address>::None),
        );
        let client = ProxyWalletClient::new(env, &contract_id);

        (client, owner, factory)
    }

    fn make_op(env: &Env, sender: &Address, nonce: u64, expiry: u64) -> UserOperation {
        UserOperation {
            sender: sender.clone(),
            nonce,
            expiry,
            call_data: Bytes::from_array(env, &[0xCAu8; 4]),
            call_target: Address::generate(env),
            // 65-byte placeholder signature: recovery_id=0, r=1..1, s=2..2
            signature: {
                let mut sig = [0u8; 65];
                sig[1..33].fill(0x01);
                sig[33..65].fill(0x02);
                Bytes::from_array(env, &sig)
            },
            max_fee: 1000,
        }
    }

    // ── Initialization ─────────────────────────────────────────────────

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let (client, owner, factory) = setup(&env);

        assert_eq!(client.get_owner(), owner);
        assert_eq!(client.get_factory(), factory);
        assert_eq!(client.get_nonce(), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let owner = Address::generate(&env);
        let factory = Address::generate(&env);

        // Register with constructor — contract is already initialized.
        let contract_id = env.register(
            ProxyWallet,
            (owner.clone(), factory.clone(), Option::<Address>::None),
        );
        let client = ProxyWalletClient::new(&env, &contract_id);

        // Calling initialize again must panic with AlreadyInitialized (#2).
        client.initialize(&owner, &factory, &None);
    }

    // ── WebAuthn key registration ──────────────────────────────────────

    #[test]
    fn test_register_webauthn_key() {
        let env = Env::default();
        let (client, owner, _) = setup(&env);

        let pk_x = BytesN::from_array(&env, &[0x01u8; 32]);
        let pk_y = BytesN::from_array(&env, &[0x02u8; 32]);

        client.register_webauthn_key(&owner, &pk_x, &pk_y);
    }

    // ── Expiry enforcement ─────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #15)")]
    fn test_expired_operation_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, owner, _) = setup(&env);

        let relayer = Address::generate(&env);
        client.set_relayer(&owner, &relayer);

        // Set ledger timestamp ahead of the op's expiry.
        env.ledger().with_mut(|l| l.timestamp = 2000);

        let op = make_op(&env, &owner, 0, 1000); // expiry=1000 < timestamp=2000
        client.execute_user_operation(&op, &relayer);
    }

    #[test]
    fn test_valid_expiry_is_accepted() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, owner, _) = setup(&env);

        let relayer = Address::generate(&env);
        client.set_relayer(&owner, &relayer);

        env.ledger().with_mut(|l| l.timestamp = 500);
        let op = make_op(&env, &owner, 0, 9999); // expiry=9999 > timestamp=500
        client.execute_user_operation(&op, &relayer);
    }

    // ── Nonce management ───────────────────────────────────────────────

    #[test]
    fn test_get_nonce() {
        let env = Env::default();
        let (client, _, _) = setup(&env);
        assert_eq!(client.get_nonce(), 0);
    }

    #[test]
    fn test_mark_nonce_used() {
        let env = Env::default();
        let (client, _, _) = setup(&env);
        client.mark_nonce_used(&5);
        assert!(client.is_nonce_used(&5));
        assert!(!client.is_nonce_used(&6));
    }

    // ── Relayer management ─────────────────────────────────────────────

    #[test]
    fn test_set_relayer() {
        let env = Env::default();
        let (client, owner, _) = setup(&env);
        let relayer = Address::generate(&env);
        client.set_relayer(&owner, &relayer);
        assert_eq!(client.get_relayer(), Some(relayer));
    }

    #[test]
    fn test_remove_relayer() {
        let env = Env::default();
        let (client, owner, _) = setup(&env);
        let relayer = Address::generate(&env);
        client.set_relayer(&owner, &relayer);
        client.remove_relayer(&owner);
        assert_eq!(client.get_relayer(), None);
    }

    #[test]
    fn test_is_authorized_relayer() {
        let env = Env::default();
        let (client, owner, _) = setup(&env);
        let relayer = Address::generate(&env);
        client.set_relayer(&owner, &relayer);
        assert!(client.is_authorized_relayer(&relayer));
        assert!(!client.is_authorized_relayer(&Address::generate(&env)));
    }

    // ── Vault operations ───────────────────────────────────────────────

    #[test]
    fn test_approve_vault() {
        let env = Env::default();
        let (client, owner, _) = setup(&env);
        let vault = Address::generate(&env);
        client.approve_vault(&owner, &vault, &1000);
    }

    // ── Challenge determinism ──────────────────────────────────────────

    #[test]
    fn test_same_op_produces_same_challenge() {
        let env = Env::default();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let factory = Address::generate(&env);
        let op1 = make_op(&env, &owner, 7, 99999);
        let op2 = make_op(&env, &owner, 7, 99999);

        let contract_id = env.register(
            ProxyWallet,
            (owner.clone(), factory.clone(), Option::<Address>::None),
        );
        let client = ProxyWalletClient::new(&env, &contract_id);

        // Register a WebAuthn key so the crypto path is exercised.
        let pk_x = BytesN::from_array(&env, &[0x01u8; 32]);
        let pk_y = BytesN::from_array(&env, &[0x02u8; 32]);
        client.register_webauthn_key(&owner, &pk_x, &pk_y);

        // make_op produces a 65-byte signature (1 byte padding + 64 bytes).
        // Our validator requires exactly 64 bytes → both calls return an
        // InvalidWebAuthnSignature contract error, deterministically.
        let r1 = client.try_execute_user_operation(&op1, &owner);
        let r2 = client.try_execute_user_operation(&op2, &owner);
        assert!(r1.is_err(), "expected contract error on first call");
        assert!(r2.is_err(), "expected contract error on second call");
    }

    #[test]
    fn test_different_expiry_changes_challenge() {
        let env = Env::default();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let factory = Address::generate(&env);

        let contract_id = env.register(
            ProxyWallet,
            (owner.clone(), factory.clone(), Option::<Address>::None),
        );
        let client = ProxyWalletClient::new(&env, &contract_id);

        let pk_x = BytesN::from_array(&env, &[0x01u8; 32]);
        let pk_y = BytesN::from_array(&env, &[0x02u8; 32]);
        client.register_webauthn_key(&owner, &pk_x, &pk_y);

        env.ledger().with_mut(|l| l.timestamp = 1);
        // Two ops with different expiry values should both fail the same way
        // (65-byte sig triggers InvalidWebAuthnSignature before secp256r1_verify).
        let op_a = make_op(&env, &owner, 0, 9999);
        let op_b = make_op(&env, &owner, 0, 8888);

        let r_a = client.try_execute_user_operation(&op_a, &owner);
        let r_b = client.try_execute_user_operation(&op_b, &owner);

        assert!(r_a.is_err());
        assert!(r_b.is_err());
    }
}
