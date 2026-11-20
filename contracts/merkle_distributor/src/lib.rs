#![no_std]

//! # MerkleDistributor — Efficient On-Chain Rewards Distribution
//!
//! Stores a Merkle Root and allows users to claim $YIELD rewards
//! by providing a cryptographic proof. Uses a bitmap-based claim
//! registry to prevent double claims while minimising storage costs.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
    Vec,
};

// ── Storage Keys ────────────────────────────────────────────────────────

#[contracttype]
enum DataKey {
    /// The admin address that can update the Merkle root.
    Admin,
    /// The reward token address ($YIELD).
    Token,
    /// The current Merkle root (32-byte hash).
    MerkleRoot,
    /// Bitmap for tracking claimed indices (each u128 stores 128 claim bits).
    ClaimedBitmap(u32),
    /// Whether the contract is initialized.
    Initialized,
    /// The current distribution epoch (incremented on root updates).
    Epoch,
    /// Total amount claimed in the current epoch.
    TotalClaimed,
    /// Campaign expiration timestamp in ledger seconds (#1504).
    Expiry,
}

/// Maximum allowed depth for a Merkle proof to bound verification cost (#1505).
pub const MAX_PROOF_DEPTH: u32 = 20;

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DistributorError {
    /// Contract has not been initialized yet.
    NotInitialized = 1,
    /// Contract is already initialized.
    AlreadyInitialized = 2,
    /// The caller is not the admin.
    Unauthorized = 3,
    /// The provided amount is zero or negative.
    ZeroAmount = 4,
    /// This index has already been claimed.
    AlreadyClaimed = 5,
    /// The Merkle proof is invalid.
    InvalidProof = 6,
    /// The Merkle root has not been set.
    NoMerkleRoot = 7,
    /// Insufficient contract balance for the claim.
    InsufficientBalance = 8,
    /// The proof length exceeds MAX_PROOF_DEPTH (#1505).
    ProofTooLarge = 9,
    /// The campaign has expired (#1504).
    CampaignExpired = 10,
    /// The campaign has not expired yet (#1504).
    CampaignNotExpired = 11,
}

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct MerkleDistributor;

#[contractimpl]
impl MerkleDistributor {
    // ── Initialisation ──────────────────────────────────────────────

    /// Initialize the distributor with an admin and the reward token address.
    ///
    /// Can only be called once. The admin is the sole address allowed to
    /// update the Merkle root.
    ///
    /// # Arguments
    /// * `admin` — The admin address that controls root updates.
    /// * `token` — The reward token address (e.g. $YIELD).
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), DistributorError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(DistributorError::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Epoch, &0u32);
        env.storage().instance().set(&DataKey::TotalClaimed, &0i128);
        env.storage().instance().set(&DataKey::Expiry, &0u64);
        env.storage().instance().set(&DataKey::Initialized, &true);

        env.events()
            .publish((symbol_short!("init"),), (admin.clone(), token.clone()));

        Ok(())
    }

    // ── Admin: Set Merkle Root ──────────────────────────────────────

    /// Set a new Merkle root for a new distribution epoch.
    ///
    /// This increments the epoch and resets claim tracking, allowing
    /// a fresh round of claims against the new root.
    ///
    /// # Arguments
    /// * `admin`       — The admin address (must authorize).
    /// * `merkle_root` — The 32-byte Merkle root hash.
    ///
    /// # Security
    /// Only the admin can call this. Each new root starts a fresh epoch.
    pub fn set_merkle_root(
        env: Env,
        admin: Address,
        merkle_root: BytesN<32>,
    ) -> Result<(), DistributorError> {
        Self::require_admin(&env, &admin)?;

        let epoch: u32 = env.storage().instance().get(&DataKey::Epoch).unwrap();
        let new_epoch = epoch + 1;

        env.storage()
            .instance()
            .set(&DataKey::MerkleRoot, &merkle_root);
        env.storage().instance().set(&DataKey::Epoch, &new_epoch);
        env.storage().instance().set(&DataKey::TotalClaimed, &0i128);
        env.storage().instance().set(&DataKey::Expiry, &0u64);

        env.events()
            .publish((symbol_short!("new_root"),), (new_epoch, merkle_root));

        Ok(())
    }

    /// Set the expiration timestamp for the current campaign (#1504).
    ///
    /// After this timestamp (ledger seconds), claims are blocked and the admin
    /// can reclaim any remaining reward tokens.
    pub fn set_expiry(env: Env, admin: Address, expiry: u64) -> Result<(), DistributorError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Expiry, &expiry);
        env.events().publish((symbol_short!("expiry"),), (expiry,));
        Ok(())
    }

    /// Set a new Merkle root with an expiration timestamp (#1504).
    pub fn set_merkle_root_with_expiry(
        env: Env,
        admin: Address,
        merkle_root: BytesN<32>,
        expiry: u64,
    ) -> Result<(), DistributorError> {
        Self::set_merkle_root(env.clone(), admin, merkle_root)?;
        env.storage().instance().set(&DataKey::Expiry, &expiry);
        env.events().publish((symbol_short!("expiry"),), (expiry,));
        Ok(())
    }

    // ── Admin: Reclaim Unclaimed Rewards (#1504) ────────────────────

    /// Reclaim unclaimed tokens after the campaign has expired.
    ///
    /// Can only be called by the admin and only after `ledger().timestamp() >= expiry`.
    pub fn reclaim(
        env: Env,
        admin: Address,
        to: Address,
        amount: i128,
    ) -> Result<i128, DistributorError> {
        Self::require_admin(&env, &admin)?;

        if amount <= 0 {
            return Err(DistributorError::ZeroAmount);
        }

        let expiry: u64 = env.storage().instance().get(&DataKey::Expiry).unwrap_or(0);
        if expiry == 0 || env.ledger().timestamp() < expiry {
            return Err(DistributorError::CampaignNotExpired);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        let contract_balance = client.balance(&env.current_contract_address());
        if contract_balance < amount {
            return Err(DistributorError::InsufficientBalance);
        }

        client.transfer(&env.current_contract_address(), &to, &amount);

        env.events()
            .publish((symbol_short!("reclaim"),), (to, amount));

        Ok(amount)
    }

    /// Reclaim all remaining unclaimed tokens after campaign expiration (#1504).
    pub fn reclaim_all(env: Env, admin: Address, to: Address) -> Result<i128, DistributorError> {
        Self::require_admin(&env, &admin)?;

        let expiry: u64 = env.storage().instance().get(&DataKey::Expiry).unwrap_or(0);
        if expiry == 0 || env.ledger().timestamp() < expiry {
            return Err(DistributorError::CampaignNotExpired);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        let contract_balance = client.balance(&env.current_contract_address());
        if contract_balance <= 0 {
            return Err(DistributorError::InsufficientBalance);
        }

        client.transfer(&env.current_contract_address(), &to, &contract_balance);

        env.events()
            .publish((symbol_short!("reclaim"),), (to, contract_balance));

        Ok(contract_balance)
    }

    // ── Claim Rewards ───────────────────────────────────────────────

    /// Claim rewards by providing a Merkle proof.
    ///
    /// The caller proves they are entitled to `amount` tokens at leaf
    /// `index` in the current Merkle tree. The leaf is bound to the current
    /// campaign ID (epoch) and the reward asset, and the contract verifies the
    /// proof against the stored root and transfers tokens if valid.
    ///
    /// # Arguments
    /// * `claimant` — The address claiming rewards (must authorize).
    /// * `index`    — The leaf index in the Merkle tree.
    /// * `amount`   — The reward amount to claim.
    /// * `proof`    — The Merkle proof (array of 32-byte hashes).
    ///
    /// # Security
    /// Uses a bitmap to prevent double claims. Each bit corresponds
    /// to a leaf index. Once claimed, the bit is set permanently for
    /// the current epoch.
    pub fn claim(
        env: Env,
        claimant: Address,
        index: u32,
        amount: i128,
        proof: Vec<BytesN<32>>,
    ) -> Result<i128, DistributorError> {
        Self::require_init(&env)?;
        claimant.require_auth();

        if amount <= 0 {
            return Err(DistributorError::ZeroAmount);
        }

        // Bounded proof depth check (#1505)
        if (proof.len() as u32) > MAX_PROOF_DEPTH {
            return Err(DistributorError::ProofTooLarge);
        }

        // Campaign expiration check (#1504)
        let expiry: u64 = env.storage().instance().get(&DataKey::Expiry).unwrap_or(0);
        if expiry > 0 && env.ledger().timestamp() >= expiry {
            return Err(DistributorError::CampaignExpired);
        }

        // Check not already claimed
        if Self::is_claimed_internal(&env, index) {
            return Err(DistributorError::AlreadyClaimed);
        }

        // Verify the Merkle proof
        let merkle_root: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::MerkleRoot)
            .ok_or(DistributorError::NoMerkleRoot)?;

        let epoch: u32 = env.storage().instance().get(&DataKey::Epoch).unwrap();
        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();

        let leaf = Self::compute_leaf(&env, epoch, &token_addr, index, &claimant, amount);
        if !Self::verify_proof(&env, &proof, &merkle_root, &leaf) {
            return Err(DistributorError::InvalidProof);
        }

        let client = token::Client::new(&env, &token_addr);

        let contract_balance = client.balance(&env.current_contract_address());
        if contract_balance < amount {
            return Err(DistributorError::InsufficientBalance);
        }

        // Checks-Effects-Interactions: Record claim state before transfer (#1503)
        Self::set_claimed(&env, index);

        // Update total claimed before external transfer
        let total_claimed: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalClaimed)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalClaimed, &(total_claimed + amount));

        // Transfer reward tokens to claimant (Interactions)
        client.transfer(&env.current_contract_address(), &claimant, &amount);

        env.events()
            .publish((symbol_short!("claim"),), (claimant, index, amount));

        Ok(amount)
    }

    // ── View Functions ──────────────────────────────────────────────

    /// Check if a specific index has been claimed in the current epoch.
    pub fn is_claimed(env: Env, index: u32) -> bool {
        Self::is_claimed_internal(&env, index)
    }

    /// Returns the current Merkle root.
    pub fn get_merkle_root(env: Env) -> Result<BytesN<32>, DistributorError> {
        Self::require_init(&env)?;
        env.storage()
            .instance()
            .get(&DataKey::MerkleRoot)
            .ok_or(DistributorError::NoMerkleRoot)
    }

    /// Returns the campaign expiration timestamp (0 if not set) (#1504).
    pub fn get_expiry(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::Expiry)
            .unwrap_or(0u64)
    }

    /// Returns the current distribution epoch.
    pub fn get_epoch(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Epoch).unwrap_or(0)
    }

    /// Returns the total amount claimed in the current epoch.
    pub fn get_total_claimed(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalClaimed)
            .unwrap_or(0)
    }

    /// Returns the admin address.
    pub fn get_admin(env: Env) -> Result<Address, DistributorError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::Admin).unwrap())
    }

    /// Returns the reward token address.
    pub fn get_token(env: Env) -> Result<Address, DistributorError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::Token).unwrap())
    }

    // ── Internal: Merkle Proof Verification ─────────────────────────

    /// Compute the leaf hash: sha256(campaign_id || asset || index || account || amount).
    ///
    /// The campaign ID is the distribution epoch and the asset is the reward
    /// token, so a leaf is only valid for the campaign and asset it was built for.
    fn compute_leaf(
        env: &Env,
        campaign_id: u32,
        asset: &Address,
        index: u32,
        account: &Address,
        amount: i128,
    ) -> BytesN<32> {
        let mut data = soroban_sdk::Bytes::new(env);
        // Encode campaign ID (epoch) as 4 bytes (big-endian)
        data.append(&soroban_sdk::Bytes::from_array(
            env,
            &campaign_id.to_be_bytes(),
        ));
        // Encode the asset address as UTF-8 string bytes
        let asset_str = asset.to_string();
        let asset_len = asset_str.len() as usize;
        let mut asset_buf = [0u8; 56];
        asset_str.copy_into_slice(&mut asset_buf[..asset_len]);
        data.append(&soroban_sdk::Bytes::from_slice(
            env,
            &asset_buf[..asset_len],
        ));
        // Encode index as 4 bytes (big-endian)
        data.append(&soroban_sdk::Bytes::from_array(env, &index.to_be_bytes()));
        // Encode the account address as UTF-8 string bytes
        let addr_str = account.to_string();
        let len = addr_str.len() as usize;
        let mut buf = [0u8; 56];
        addr_str.copy_into_slice(&mut buf[..len]);
        data.append(&soroban_sdk::Bytes::from_slice(env, &buf[..len]));
        // Encode amount as 16 bytes (big-endian)
        data.append(&soroban_sdk::Bytes::from_array(env, &amount.to_be_bytes()));
        env.crypto().sha256(&data).into()
    }

    /// Verify a Merkle proof against the root.
    ///
    /// Iterates through each proof element, hashing the current computed
    /// hash with the proof element in sorted order to produce the next hash.
    fn verify_proof(
        env: &Env,
        proof: &Vec<BytesN<32>>,
        root: &BytesN<32>,
        leaf: &BytesN<32>,
    ) -> bool {
        let mut computed = leaf.clone();

        for i in 0..proof.len() {
            let proof_element = proof.get(i).unwrap();
            computed = Self::hash_pair(env, &computed, &proof_element);
        }

        computed == *root
    }

    /// Hash two 32-byte values together in sorted order.
    /// This ensures the same result regardless of left/right position.
    fn hash_pair(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
        let mut data = soroban_sdk::Bytes::new(env);
        // Sort: smaller value first for deterministic hashing
        if a.to_array() <= b.to_array() {
            data.append(&soroban_sdk::Bytes::from_array(env, &a.to_array()));
            data.append(&soroban_sdk::Bytes::from_array(env, &b.to_array()));
        } else {
            data.append(&soroban_sdk::Bytes::from_array(env, &b.to_array()));
            data.append(&soroban_sdk::Bytes::from_array(env, &a.to_array()));
        }
        env.crypto().sha256(&data).into()
    }

    // ── Internal: Bitmap Claim Registry ─────────────────────────────

    /// Check if a specific index has been claimed using the bitmap.
    fn is_claimed_internal(env: &Env, index: u32) -> bool {
        let word_index = index / 128;
        let bit_index = index % 128;
        let word: u128 = env
            .storage()
            .persistent()
            .get(&DataKey::ClaimedBitmap(word_index))
            .unwrap_or(0);
        (word & (1u128 << bit_index)) != 0
    }

    /// Set a specific index as claimed in the bitmap.
    fn set_claimed(env: &Env, index: u32) {
        let word_index = index / 128;
        let bit_index = index % 128;
        let word: u128 = env
            .storage()
            .persistent()
            .get(&DataKey::ClaimedBitmap(word_index))
            .unwrap_or(0);
        let new_word = word | (1u128 << bit_index);
        env.storage()
            .persistent()
            .set(&DataKey::ClaimedBitmap(word_index), &new_word);
    }

    // ── Internal: Access Control ────────────────────────────────────

    fn require_init(env: &Env) -> Result<(), DistributorError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(DistributorError::NotInitialized);
        }
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), DistributorError> {
        Self::require_init(env)?;
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(DistributorError::NotInitialized)?;
        if *caller != admin {
            return Err(DistributorError::Unauthorized);
        }
        Ok(())
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::Env;

    fn setup_env() -> (
        Env,
        MerkleDistributorClient<'static>,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(MerkleDistributor, ());
        let client = MerkleDistributorClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();

        client.initialize(&admin, &token_addr);

        (env, client, admin, token_addr, token_admin)
    }

    fn mint_tokens(env: &Env, token_addr: &Address, _admin: &Address, to: &Address, amount: i128) {
        let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    // ── Initialization Tests ────────────────────────────────────────

    #[test]
    fn test_initialize() {
        let (_, client, admin, token_addr, _) = setup_env();
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_token(), token_addr);
        assert_eq!(client.get_epoch(), 0);
        assert_eq!(client.get_total_claimed(), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let (env, client, _, token_addr, _) = setup_env();
        let new_admin = Address::generate(&env);
        client.initialize(&new_admin, &token_addr);
    }

    // ── Set Merkle Root Tests ───────────────────────────────────────

    #[test]
    fn test_set_merkle_root() {
        let (env, client, admin, _, _) = setup_env();
        let root = BytesN::from_array(&env, &[1u8; 32]);
        client.set_merkle_root(&admin, &root);
        assert_eq!(client.get_merkle_root(), root);
        assert_eq!(client.get_epoch(), 1);
    }

    #[test]
    fn test_set_merkle_root_increments_epoch() {
        let (env, client, admin, _, _) = setup_env();
        let root1 = BytesN::from_array(&env, &[1u8; 32]);
        let root2 = BytesN::from_array(&env, &[2u8; 32]);
        client.set_merkle_root(&admin, &root1);
        assert_eq!(client.get_epoch(), 1);
        client.set_merkle_root(&admin, &root2);
        assert_eq!(client.get_epoch(), 2);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_set_merkle_root_unauthorized() {
        let (env, client, _, _, _) = setup_env();
        let non_admin = Address::generate(&env);
        let root = BytesN::from_array(&env, &[1u8; 32]);
        client.set_merkle_root(&non_admin, &root);
    }

    // ── Claim Tests ─────────────────────────────────────────────────

    #[test]
    fn test_claim_with_valid_proof() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let claimant = Address::generate(&env);
        let amount: i128 = 1000;
        let index: u32 = 0;

        // Compute the expected leaf hash
        let leaf = compute_test_leaf(&env, 1, &token_addr, index, &claimant, amount);

        // For a single-leaf tree, the root IS the leaf
        let root = leaf.clone();
        client.set_merkle_root(&admin, &root);

        // Fund the distributor contract
        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &token_admin, &contract_addr, 10000);

        // Claim with an empty proof (single-leaf tree)
        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        let claimed = client.claim(&claimant, &index, &amount, &empty_proof);
        assert_eq!(claimed, 1000);
        assert!(client.is_claimed(&index));
        assert_eq!(client.get_total_claimed(), 1000);
    }

    #[test]
    fn test_claim_with_two_leaf_proof() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let claimant1 = Address::generate(&env);
        let claimant2 = Address::generate(&env);
        let amount1: i128 = 500;
        let amount2: i128 = 300;

        // Compute leaves
        let leaf1 = compute_test_leaf(&env, 1, &token_addr, 0, &claimant1, amount1);
        let leaf2 = compute_test_leaf(&env, 1, &token_addr, 1, &claimant2, amount2);

        // Compute root = hash(sorted(leaf1, leaf2))
        let root = hash_pair_test(&env, &leaf1, &leaf2);
        client.set_merkle_root(&admin, &root);

        // Fund distributor
        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &token_admin, &contract_addr, 10000);

        // Claimant 1 proves with leaf2 as sibling
        let proof1: Vec<BytesN<32>> = Vec::from_array(&env, [leaf2.clone()]);
        let claimed1 = client.claim(&claimant1, &0, &amount1, &proof1);
        assert_eq!(claimed1, 500);

        // Claimant 2 proves with leaf1 as sibling
        let proof2: Vec<BytesN<32>> = Vec::from_array(&env, [leaf1.clone()]);
        let claimed2 = client.claim(&claimant2, &1, &amount2, &proof2);
        assert_eq!(claimed2, 300);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_double_claim_panics() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let claimant = Address::generate(&env);
        let amount: i128 = 1000;
        let index: u32 = 0;

        let leaf = compute_test_leaf(&env, 1, &token_addr, index, &claimant, amount);
        let root = leaf.clone();
        client.set_merkle_root(&admin, &root);

        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &token_admin, &contract_addr, 10000);

        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        client.claim(&claimant, &index, &amount, &empty_proof);
        // Second claim should panic
        client.claim(&claimant, &index, &amount, &empty_proof);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_invalid_proof_panics() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let claimant = Address::generate(&env);
        let fake_root = BytesN::from_array(&env, &[99u8; 32]);
        client.set_merkle_root(&admin, &fake_root);

        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &token_admin, &contract_addr, 10000);

        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        client.claim(&claimant, &0, &1000, &empty_proof);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_claim_zero_amount_panics() {
        let (env, client, admin, _, _) = setup_env();
        let claimant = Address::generate(&env);
        let root = BytesN::from_array(&env, &[1u8; 32]);
        client.set_merkle_root(&admin, &root);

        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        client.claim(&claimant, &0, &0, &empty_proof);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_claim_insufficient_balance_panics() {
        let (env, client, admin, token_addr, _) = setup_env();
        let claimant = Address::generate(&env);
        let amount: i128 = 1000;
        let index: u32 = 0;

        let leaf = compute_test_leaf(&env, 1, &token_addr, index, &claimant, amount);
        let root = leaf.clone();
        client.set_merkle_root(&admin, &root);

        // Don't fund the contract — should fail with InsufficientBalance
        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        client.claim(&claimant, &index, &amount, &empty_proof);
    }

    // ── Campaign / Asset Binding Tests ──────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_claim_rejects_leaf_from_other_campaign() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let claimant = Address::generate(&env);

        // A leaf built for campaign 1 is published as the root of campaign 2.
        let campaign_1_leaf = compute_test_leaf(&env, 1, &token_addr, 0, &claimant, 1000);
        client.set_merkle_root(&admin, &BytesN::from_array(&env, &[1u8; 32]));
        client.set_merkle_root(&admin, &campaign_1_leaf);
        assert_eq!(client.get_epoch(), 2);

        mint_tokens(&env, &token_addr, &token_admin, &client.address, 10000);

        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        client.claim(&claimant, &0, &1000, &empty_proof);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_claim_rejects_leaf_for_other_asset() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let claimant = Address::generate(&env);
        let other_asset = Address::generate(&env);

        let other_asset_leaf = compute_test_leaf(&env, 1, &other_asset, 0, &claimant, 1000);
        client.set_merkle_root(&admin, &other_asset_leaf);

        mint_tokens(&env, &token_addr, &token_admin, &client.address, 10000);

        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        client.claim(&claimant, &0, &1000, &empty_proof);
    }

    #[test]
    fn test_claim_accepts_leaf_for_current_campaign_after_root_update() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let claimant = Address::generate(&env);

        client.set_merkle_root(&admin, &BytesN::from_array(&env, &[1u8; 32]));
        let leaf = compute_test_leaf(&env, 2, &token_addr, 0, &claimant, 1000);
        client.set_merkle_root(&admin, &leaf);

        mint_tokens(&env, &token_addr, &token_admin, &client.address, 10000);

        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        assert_eq!(client.claim(&claimant, &0, &1000, &empty_proof), 1000);
    }

    // ── Bitmap Tests ────────────────────────────────────────────────

    #[test]
    fn test_bitmap_not_claimed_by_default() {
        let (_, client, _, _, _) = setup_env();
        assert!(!client.is_claimed(&0));
        assert!(!client.is_claimed(&127));
        assert!(!client.is_claimed(&128));
        assert!(!client.is_claimed(&1000));
    }

    // ── Issue #1503: Duplicate Claim & Repeated Submission Tests ─────

    #[test]
    fn test_repeated_submission_identical_claim_fails() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let claimant = Address::generate(&env);
        let amount: i128 = 1000;
        let index: u32 = 0;

        let leaf = compute_test_leaf(&env, 1, &token_addr, index, &claimant, amount);
        client.set_merkle_root(&admin, &leaf);

        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &token_admin, &contract_addr, 10000);

        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        // First submission succeeds
        let res1 = client.try_claim(&claimant, &index, &amount, &empty_proof);
        assert_eq!(res1, Ok(Ok(1000)));
        assert!(client.is_claimed(&index));
        assert_eq!(client.get_total_claimed(), 1000);

        // Repeated submission with identical arguments fails with AlreadyClaimed (#5)
        let res2 = client.try_claim(&claimant, &index, &amount, &empty_proof);
        assert_eq!(res2, Err(Ok(DistributorError::AlreadyClaimed)));

        // Third submission from another claimant with the same index also fails
        let another_claimant = Address::generate(&env);
        let res3 = client.try_claim(&another_claimant, &index, &amount, &empty_proof);
        assert_eq!(res3, Err(Ok(DistributorError::AlreadyClaimed)));

        // Contract balance only decreased by one claim amount (10000 - 1000 = 9000)
        let token_client = soroban_sdk::token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&contract_addr), 9000);
    }

    // ── Issue #1504: Campaign Expiry & Unclaimed Reclaim Tests ───────

    #[test]
    fn test_campaign_exact_expiry_boundary() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let claimant = Address::generate(&env);
        let amount: i128 = 1000;
        let index: u32 = 0;
        let expiry: u64 = 5000;

        let leaf = compute_test_leaf(&env, 1, &token_addr, index, &claimant, amount);
        client.set_merkle_root_with_expiry(&admin, &leaf, &expiry);
        assert_eq!(client.get_expiry(), expiry);

        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &token_admin, &contract_addr, 10000);

        // Before expiry: timestamp = expiry - 1 (4999)
        env.ledger().set_timestamp(4999);

        // Reclaim before expiry must fail with CampaignNotExpired
        let reclaim_target = Address::generate(&env);
        let reclaim_res_before = client.try_reclaim(&admin, &reclaim_target, &5000);
        assert_eq!(
            reclaim_res_before,
            Err(Ok(DistributorError::CampaignNotExpired))
        );

        // Claim before expiry succeeds
        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        let claim_res = client.try_claim(&claimant, &index, &amount, &empty_proof);
        assert_eq!(claim_res, Ok(Ok(1000)));

        // Prepare claimant 2 at index 1 for testing at expiry
        let claimant2 = Address::generate(&env);
        let amount2: i128 = 2000;
        let index2: u32 = 1;
        // In a new root, set expiry to 6000
        let leaf2 = compute_test_leaf(&env, 2, &token_addr, index2, &claimant2, amount2);
        client.set_merkle_root_with_expiry(&admin, &leaf2, &6000);

        // At exact expiry: timestamp = 6000
        env.ledger().set_timestamp(6000);

        // Claim at exact expiry must fail with CampaignExpired
        let claim_at_expiry = client.try_claim(&claimant2, &index2, &amount2, &empty_proof);
        assert_eq!(claim_at_expiry, Err(Ok(DistributorError::CampaignExpired)));

        // Reclaim at exact expiry succeeds
        let reclaim_res_at = client.try_reclaim(&admin, &reclaim_target, &3000);
        assert_eq!(reclaim_res_at, Ok(Ok(3000)));

        let token_client = soroban_sdk::token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&reclaim_target), 3000);
    }

    #[test]
    fn test_repeated_reclaim() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let expiry: u64 = 1000;
        let root = BytesN::from_array(&env, &[1u8; 32]);
        client.set_merkle_root_with_expiry(&admin, &root, &expiry);

        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &token_admin, &contract_addr, 5000);

        // Advance ledger beyond expiry
        env.ledger().set_timestamp(1500);

        let recipient = Address::generate(&env);
        // First reclaim succeeds for entire balance
        let res1 = client.try_reclaim(&admin, &recipient, &5000);
        assert_eq!(res1, Ok(Ok(5000)));

        // Second (repeated) reclaim fails due to InsufficientBalance
        let res2 = client.try_reclaim(&admin, &recipient, &1000);
        assert_eq!(res2, Err(Ok(DistributorError::InsufficientBalance)));

        // Third (repeated) reclaim_all fails due to InsufficientBalance
        let res3 = client.try_reclaim_all(&admin, &recipient);
        assert_eq!(res3, Err(Ok(DistributorError::InsufficientBalance)));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_reclaim_unauthorized_panics() {
        let (env, client, admin, _, _) = setup_env();
        let expiry: u64 = 1000;
        let root = BytesN::from_array(&env, &[1u8; 32]);
        client.set_merkle_root_with_expiry(&admin, &root, &expiry);
        env.ledger().set_timestamp(2000);

        let non_admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        client.reclaim(&non_admin, &recipient, &1000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_set_expiry_unauthorized_panics() {
        let (env, client, _, _, _) = setup_env();
        let non_admin = Address::generate(&env);
        client.set_expiry(&non_admin, &5000);
    }

    // ── Issue #1505: Proof Depth Bounds Tests ────────────────────────

    #[test]
    fn test_proof_depth_bounds_maximum_accepted_and_first_rejected() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let claimant = Address::generate(&env);
        let amount: i128 = 1000;
        let index: u32 = 0;

        let root = BytesN::from_array(&env, &[5u8; 32]);
        client.set_merkle_root(&admin, &root);

        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &token_admin, &contract_addr, 10000);

        // Maximum accepted size: MAX_PROOF_DEPTH = 20
        let mut max_proof: Vec<BytesN<32>> = Vec::new(&env);
        for _ in 0..MAX_PROOF_DEPTH {
            max_proof.push_back(BytesN::from_array(&env, &[0u8; 32]));
        }
        assert_eq!(max_proof.len(), MAX_PROOF_DEPTH);

        // Calling try_claim with 20 elements passes the proof depth bound check.
        // It fails with InvalidProof (#6) since the proof is dummy hashes,
        // but crucially DOES NOT fail with ProofTooLarge (#9).
        let max_res = client.try_claim(&claimant, &index, &amount, &max_proof);
        assert_eq!(max_res, Err(Ok(DistributorError::InvalidProof)));

        // First rejected size: MAX_PROOF_DEPTH + 1 = 21
        let mut oversized_proof = max_proof.clone();
        oversized_proof.push_back(BytesN::from_array(&env, &[0u8; 32]));
        assert_eq!(oversized_proof.len(), MAX_PROOF_DEPTH + 1);

        // Calling try_claim with 21 elements is rejected immediately before hashing with ProofTooLarge (#9).
        let rejected_res = client.try_claim(&claimant, &index, &amount, &oversized_proof);
        assert_eq!(rejected_res, Err(Ok(DistributorError::ProofTooLarge)));
    }

    // ── Helper functions for tests ──────────────────────────────────

    fn compute_test_leaf(
        env: &Env,
        campaign_id: u32,
        asset: &Address,
        index: u32,
        account: &Address,
        amount: i128,
    ) -> BytesN<32> {
        let mut data = soroban_sdk::Bytes::new(env);
        data.append(&soroban_sdk::Bytes::from_array(
            env,
            &campaign_id.to_be_bytes(),
        ));
        let asset_str = asset.to_string();
        let asset_len = asset_str.len() as usize;
        let mut asset_buf = [0u8; 56];
        asset_str.copy_into_slice(&mut asset_buf[..asset_len]);
        data.append(&soroban_sdk::Bytes::from_slice(
            env,
            &asset_buf[..asset_len],
        ));
        data.append(&soroban_sdk::Bytes::from_array(env, &index.to_be_bytes()));
        let addr_str = account.to_string();
        let len = addr_str.len() as usize;
        let mut buf = [0u8; 56];
        addr_str.copy_into_slice(&mut buf[..len]);
        data.append(&soroban_sdk::Bytes::from_slice(env, &buf[..len]));
        data.append(&soroban_sdk::Bytes::from_array(env, &amount.to_be_bytes()));
        env.crypto().sha256(&data).into()
    }

    fn hash_pair_test(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
        let mut data = soroban_sdk::Bytes::new(env);
        if a.to_array() <= b.to_array() {
            data.append(&soroban_sdk::Bytes::from_array(env, &a.to_array()));
            data.append(&soroban_sdk::Bytes::from_array(env, &b.to_array()));
        } else {
            data.append(&soroban_sdk::Bytes::from_array(env, &b.to_array()));
            data.append(&soroban_sdk::Bytes::from_array(env, &a.to_array()));
        }
        env.crypto().sha256(&data).into()
    }
}
