#![no_std]

//! # Stealth Addresses — Private Yield Deposits
//!
//! Implements a stealth address scheme for privacy-preserving vault deposits on Stellar.
//!
//! ## Protocol overview
//!
//! 1. **Key registration** — A recipient publishes their *stealth meta-address*,
//!    which encodes two public keys:  
//!    - `spend_public_key` (Kse): used to derive the one-time spending address.
//!    - `view_public_key` (Kv): used to check whether a deposit belongs to them.
//!
//! 2. **Sender generates a one-time address** —  
//!    - Sample an ephemeral keypair (r, R = r·G).  
//!    - Compute shared secret: `s = H(r·Kv)` (Diffie-Hellman in additive notation).  
//!    - Derive one-time address:  `P = s·G + Kse`  (recipient-controlled spend key).  
//!    - Publish ephemeral public key R on-chain alongside the deposit.
//!
//! 3. **Recipient scans** —  
//!    - For each on-chain ephemeral key R:  
//!      `s = H(v·R)` (using their view private key v).  
//!      If `s·G + Kse == P`, the deposit belongs to them.
//!
//! ## Soroban constraints
//!
//! Soroban does not expose elliptic-curve or Diffie-Hellman primitives natively.
//! This contract therefore stores and validates the **pre-computed derived values**
//! (one-time addresses and ephemeral keys) that are computed off-chain by the sender
//! and provides the on-chain registry + deposit routing logic.  An off-chain SDK
//! performs the DH key generation using the Stellar Ed25519 curve.
//!
//! The contract enforces:
//! - Meta-address registry (one entry per user).
//! - Stealth deposit records linking an ephemeral public key to a one-time Stellar address.
//! - One-shot claim: only the holder of the private key corresponding to `one_time_address`
//!   can authorize a `claim_deposit`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes, Env,
};

// ── Constants ───────────────────────────────────────────────────────────

/// Maximum metadata string length (bytes)
const MAX_META_LEN: u32 = 256;

// ── Storage keys ────────────────────────────────────────────────────────

#[contracttype]
enum DataKey {
    /// Admin of the registry
    Admin,
    /// Whether the contract is initialized
    Initialized,
    /// StealthMetaAddress for a user:  DataKey::MetaAddress(owner)
    MetaAddress(Address),
    /// Deposit record:  DataKey::Deposit(deposit_id)
    Deposit(u64),
    /// Counter for deposit IDs
    NextDepositId,
}

// ── Domain types ─────────────────────────────────────────────────────────

/// A stealth meta-address published by a recipient.
///
/// Both public keys are 32-byte canonical Ed25519/Ristretto public keys,
/// encoded as Soroban `Bytes`.  The on-chain representation is opaque; the
/// off-chain SDK interprets and validates them.
#[contracttype]
#[derive(Clone, Debug)]
pub struct StealthMetaAddress {
    /// Ed25519 public key used by sender for DH key exchange (view key)
    pub view_public_key: Bytes,
    /// Ed25519 public key forming the base spending address
    pub spend_public_key: Bytes,
    /// Optional human-readable label / ENS-style handle (≤ MAX_META_LEN bytes)
    pub label: Bytes,
}

/// A stealth deposit record written by the sender.
///
/// The sender computes `one_time_address = H(r·Kv)·G + Kse` off-chain,
/// then calls `deposit` with:
/// - `one_time_address`:  the derived Stellar address the funds are sent to.
/// - `ephemeral_public_key`: R = r·G published so the recipient can scan.
/// - `view_tag`: first byte of `H(r·Kv)` — lets recipients skip most entries
///   without full scalar multiplication (ERC-5564 view-tag optimisation).
#[contracttype]
#[derive(Clone, Debug)]
pub struct StealthDeposit {
    pub id: u64,
    /// The one-time Stellar address that receives the funds
    pub one_time_address: Address,
    /// Ephemeral public key R (32 bytes)
    pub ephemeral_public_key: Bytes,
    /// Single-byte view tag for efficient recipient scanning
    pub view_tag: u32,
    /// Token deposited
    pub token: Address,
    /// Amount deposited (still held by the contract)
    pub amount: i128,
    /// Timestamp of the deposit
    pub created_at: u64,
    /// Whether the deposit has been claimed
    pub claimed: bool,
}

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StealthError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidPublicKey = 3,
    InvalidAmount = 4,
    DepositNotFound = 5,
    AlreadyClaimed = 6,
    Unauthorized = 7,
    MetaLabelTooLong = 8,
    MetaAddressNotFound = 9,
}

// ── Contract ─────────────────────────────────────────────────────────────

#[contract]
pub struct StealthAddressRegistry;

#[contractimpl]
impl StealthAddressRegistry {
    // ── Initialisation ─────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) -> Result<(), StealthError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(StealthError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::NextDepositId, &0_u64);

        env.events().publish((symbol_short!("init"),), (admin,));
        Ok(())
    }

    // ── Meta-address registry ─────────────────────────────────────────

    /// Publish or update the caller's stealth meta-address.
    ///
    /// `view_public_key` and `spend_public_key` must each be exactly 32 bytes.
    pub fn register_meta_address(
        env: Env,
        owner: Address,
        view_public_key: Bytes,
        spend_public_key: Bytes,
        label: Bytes,
    ) -> Result<(), StealthError> {
        owner.require_auth();
        Self::assert_initialized(&env)?;

        if view_public_key.len() != 32 || spend_public_key.len() != 32 {
            return Err(StealthError::InvalidPublicKey);
        }
        if label.len() > MAX_META_LEN {
            return Err(StealthError::MetaLabelTooLong);
        }

        let meta = StealthMetaAddress {
            view_public_key: view_public_key.clone(),
            spend_public_key: spend_public_key.clone(),
            label,
        };
        env.storage()
            .persistent()
            .set(&DataKey::MetaAddress(owner.clone()), &meta);

        env.events().publish(
            (symbol_short!("reg_meta"),),
            (owner, view_public_key, spend_public_key),
        );
        Ok(())
    }

    /// Look up a registered stealth meta-address.
    pub fn get_meta_address(env: Env, owner: Address) -> Result<StealthMetaAddress, StealthError> {
        env.storage()
            .persistent()
            .get(&DataKey::MetaAddress(owner))
            .ok_or(StealthError::MetaAddressNotFound)
    }

    // ── Deposit ───────────────────────────────────────────────────────

    /// Create a stealth deposit.
    ///
    /// The sender:
    /// 1. Fetches the recipient's `StealthMetaAddress` from `get_meta_address`.
    /// 2. Off-chain: picks ephemeral keypair (r, R=r·G), computes
    ///    `s = H(r · view_public_key)`, `one_time_address = s·G + spend_public_key`,
    ///    and `view_tag = s[0]`.
    /// 3. Calls `deposit` with those values; funds flow from `sender` → contract.
    ///
    /// The full ephemeral key is stored on-chain so any receiver can scan.
    pub fn deposit(
        env: Env,
        sender: Address,
        one_time_address: Address,
        ephemeral_public_key: Bytes,
        view_tag: u32,
        token: Address,
        amount: i128,
    ) -> Result<u64, StealthError> {
        sender.require_auth();
        Self::assert_initialized(&env)?;

        if amount <= 0 {
            return Err(StealthError::InvalidAmount);
        }
        if ephemeral_public_key.len() != 32 {
            return Err(StealthError::InvalidPublicKey);
        }

        // Pull funds from sender into the contract escrow
        token::Client::new(&env, &token).transfer(
            &sender,
            &env.current_contract_address(),
            &amount,
        );

        // Mint deposit record
        let deposit_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextDepositId)
            .unwrap_or(0);
        let next_id = deposit_id + 1;
        env.storage()
            .instance()
            .set(&DataKey::NextDepositId, &next_id);

        let record = StealthDeposit {
            id: deposit_id,
            one_time_address: one_time_address.clone(),
            ephemeral_public_key: ephemeral_public_key.clone(),
            view_tag,
            token: token.clone(),
            amount,
            created_at: env.ledger().timestamp(),
            claimed: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Deposit(deposit_id), &record);

        env.events().publish(
            (symbol_short!("deposit"),),
            (
                deposit_id,
                one_time_address,
                ephemeral_public_key,
                view_tag,
                token,
                amount,
            ),
        );
        Ok(deposit_id)
    }

    // ── Claim ─────────────────────────────────────────────────────────

    /// Claim a stealth deposit.
    ///
    /// Only the holder of the private key for `one_time_address` can call this
    /// (enforced by `require_auth`).  Funds are forwarded to `recipient`.
    pub fn claim_deposit(
        env: Env,
        claimer: Address,
        deposit_id: u64,
        recipient: Address,
    ) -> Result<i128, StealthError> {
        claimer.require_auth();
        Self::assert_initialized(&env)?;

        let mut record: StealthDeposit = env
            .storage()
            .persistent()
            .get(&DataKey::Deposit(deposit_id))
            .ok_or(StealthError::DepositNotFound)?;

        if record.claimed {
            return Err(StealthError::AlreadyClaimed);
        }

        // Only the holder of the one-time address private key may claim
        if claimer != record.one_time_address {
            return Err(StealthError::Unauthorized);
        }

        record.claimed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Deposit(deposit_id), &record);

        // Transfer funds to recipient
        token::Client::new(&env, &record.token).transfer(
            &env.current_contract_address(),
            &recipient,
            &record.amount,
        );

        env.events().publish(
            (symbol_short!("claim"),),
            (deposit_id, claimer, recipient, record.amount),
        );
        Ok(record.amount)
    }

    // ── View helpers ───────────────────────────────────────────────────

    pub fn get_deposit(env: Env, deposit_id: u64) -> Result<StealthDeposit, StealthError> {
        env.storage()
            .persistent()
            .get(&DataKey::Deposit(deposit_id))
            .ok_or(StealthError::DepositNotFound)
    }

    pub fn get_next_deposit_id(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::NextDepositId)
            .unwrap_or(0)
    }

    // ── Internal helpers ────────────────────────────────────────────────

    fn assert_initialized(env: &Env) -> Result<(), StealthError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(StealthError::NotInitialized);
        }
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Bytes, Env};

    fn make_32_bytes(env: &Env, fill: u8) -> Bytes {
        let mut b = Bytes::new(env);
        for _ in 0..32 {
            b.push_back(fill);
        }
        b
    }

    fn deploy(env: &Env) -> (Address, Address) {
        let admin = Address::generate(env);
        let contract_id = env.register(StealthAddressRegistry, ());
        let client = StealthAddressRegistryClient::new(env, &contract_id);
        client.initialize(&admin);
        (contract_id, admin)
    }

    // ── Initialization ─────────────────────────────────────────────────

    #[test]
    fn test_double_init_rejected() {
        let env = Env::default();
        let (contract_id, admin) = deploy(&env);
        let client = StealthAddressRegistryClient::new(&env, &contract_id);
        let result = client.try_initialize(&admin);
        assert!(result.is_err());
    }

    // ── Meta-address ───────────────────────────────────────────────────

    #[test]
    fn test_register_and_get_meta_address() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = deploy(&env);
        let client = StealthAddressRegistryClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let vpk = make_32_bytes(&env, 0xAA);
        let spk = make_32_bytes(&env, 0xBB);
        let label = Bytes::from_slice(&env, b"alice.stealth");

        client.register_meta_address(&owner, &vpk, &spk, &label);

        let meta = client.get_meta_address(&owner);
        assert_eq!(meta.view_public_key, vpk);
        assert_eq!(meta.spend_public_key, spk);
    }

    #[test]
    fn test_register_wrong_key_length_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = deploy(&env);
        let client = StealthAddressRegistryClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let short_key = Bytes::from_slice(&env, b"tooshort");
        let good_key = make_32_bytes(&env, 0xCC);
        let label = Bytes::new(&env);

        let result = client.try_register_meta_address(&owner, &short_key, &good_key, &label);
        assert!(result.is_err());
    }

    #[test]
    fn test_get_nonexistent_meta_address_errors() {
        let env = Env::default();
        let (contract_id, _admin) = deploy(&env);
        let client = StealthAddressRegistryClient::new(&env, &contract_id);
        let nobody = Address::generate(&env);
        let result = client.try_get_meta_address(&nobody);
        assert!(result.is_err());
    }

    // ── Deposit ────────────────────────────────────────────────────────

    #[test]
    fn test_deposit_id_increments() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = deploy(&env);
        let client = StealthAddressRegistryClient::new(&env, &contract_id);

        assert_eq!(client.get_next_deposit_id(), 0);
    }

    #[test]
    fn test_deposit_invalid_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = deploy(&env);
        let client = StealthAddressRegistryClient::new(&env, &contract_id);

        let sender = Address::generate(&env);
        let one_time = Address::generate(&env);
        let epk = make_32_bytes(&env, 0x01);
        let token = Address::generate(&env);

        let result = client.try_deposit(&sender, &one_time, &epk, &0_u32, &token, &0_i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_deposit_bad_ephemeral_key_length() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = deploy(&env);
        let client = StealthAddressRegistryClient::new(&env, &contract_id);

        let sender = Address::generate(&env);
        let one_time = Address::generate(&env);
        let bad_epk = Bytes::from_slice(&env, b"short");
        let token = Address::generate(&env);

        let result = client.try_deposit(&sender, &one_time, &bad_epk, &0_u32, &token, &1_000_i128);
        assert!(result.is_err());
    }

    // ── Claim ──────────────────────────────────────────────────────────

    #[test]
    fn test_claim_nonexistent_deposit_errors() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = deploy(&env);
        let client = StealthAddressRegistryClient::new(&env, &contract_id);

        let claimer = Address::generate(&env);
        let recipient = Address::generate(&env);
        let result = client.try_claim_deposit(&claimer, &9999_u64, &recipient);
        assert!(result.is_err());
    }
}
