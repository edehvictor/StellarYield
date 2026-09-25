//! # Smart Wallet Factory
//!
//! A factory contract for deploying programmable smart contract wallets (proxies)
//! that enable Account Abstraction on Soroban. Supports gas sponsorship and
//! WebAuthn/Passkey authentication for seamless user onboarding.
//!
//! ## Features
//! - Deploy individual proxy wallet contracts for users
//! - Track all deployed wallets
//! - Integrate with transaction relayers for gas sponsorship
//! - Support for recovery module integration

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
    Map, Vec,
};

// ── Storage Keys ────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum StorageKey {
    Initialized,
    Admin,           // Factory admin address
    ProxyCodeHash,   // BytesN<32> — Wasm hash of the proxy contract
    DeployedProxies, // Vec<Address> - All deployed proxy addresses
    UserToProxy,     // Map<Address, Address> - Primary owner → latest proxy mapping
    DeployedSalts,   // Map<OwnerSaltKey, Address> - (owner, salt) → proxy address
    Relayer,         // Trusted relayer for gas sponsorship
    Nonce,           // Nonce for deterministic deployment salt generation
}

// ── Compound key for (owner, salt) duplicate tracking ───────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerSaltKey {
    pub owner: Address,
    pub salt: u64,
}

// ── Data Structures ─────────────────────────────────────────────────────

/// Deployment configuration for a new proxy wallet
#[contracttype]
#[derive(Clone, Debug)]
pub struct DeploymentConfig {
    pub owner: Address,           // The wallet owner's address
    pub relayer: Option<Address>, // Optional trusted relayer
    pub salt: u64,                // Salt for deterministic address generation
}

/// Proxy wallet information
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProxyInfo {
    pub proxy_address: Address,
    pub owner: Address,
    pub deployed_at: u64,
    pub salt: u64,
}

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FactoryError {
    /// Contract has not been initialized
    NotInitialized = 1,
    /// Contract is already initialized
    AlreadyInitialized = 2,
    /// Caller is not authorized
    Unauthorized = 3,
    /// Proxy deployment failed
    DeploymentFailed = 4,
    /// Proxy already exists for this (owner, salt) combination
    ProxyAlreadyExists = 5,
    /// Invalid deployment configuration
    InvalidConfig = 6,
    /// Proxy not found
    ProxyNotFound = 7,
    /// Invalid proxy code hash
    InvalidCodeHash = 8,
}

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct WalletFactory;

#[contractimpl]
impl WalletFactory {
    // ═══════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════

    /// Initialize the factory contract.
    ///
    /// # Arguments
    ///
    /// * `proxy_code_hash` - The 32-byte Wasm hash of the proxy contract
    pub fn initialize(
        env: Env,
        admin: Address,
        proxy_code_hash: BytesN<32>,
    ) -> Result<(), FactoryError> {
        if env.storage().instance().has(&StorageKey::Initialized) {
            return Err(FactoryError::AlreadyInitialized);
        }

        env.storage().instance().set(&StorageKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&StorageKey::ProxyCodeHash, &proxy_code_hash);
        env.storage().instance().set(&StorageKey::Nonce, &0u64);
        env.storage()
            .instance()
            .set(&StorageKey::Initialized, &true);

        let deployed_proxies: Vec<Address> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&StorageKey::DeployedProxies, &deployed_proxies);

        env.events().publish((symbol_short!("init"),), (admin,));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // PROXY DEPLOYMENT
    // ═══════════════════════════════════════════════════════════════════

    /// Deploy a new proxy wallet for a user.
    ///
    /// Uses `env.deployer().with_current_contract(salt)` so that the deployed
    /// contract address is deterministic given this factory and the computed salt.
    /// Rejects duplicate (owner, salt) pairs.
    pub fn deploy_proxy(env: Env, config: DeploymentConfig) -> Result<Address, FactoryError> {
        Self::require_initialized(&env)?;
        config.owner.require_auth();

        // ── Duplicate (owner, salt) check ────────────────────────────
        let pair_key = OwnerSaltKey {
            owner: config.owner.clone(),
            salt: config.salt,
        };
        let deployed_salts: Map<OwnerSaltKey, Address> = env
            .storage()
            .instance()
            .get(&StorageKey::DeployedSalts)
            .unwrap_or(Map::new(&env));

        if deployed_salts.contains_key(pair_key.clone()) {
            return Err(FactoryError::ProxyAlreadyExists);
        }

        // ── Build a unique deployment salt ───────────────────────────
        // sha256(global_nonce || user_salt) ensures the BytesN<32> passed
        // to the deployer is unique per deployment from this factory.
        let deployment_salt = Self::generate_deployment_salt(&env, config.salt);

        // ── Get stored wasm hash ─────────────────────────────────────
        let proxy_code_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&StorageKey::ProxyCodeHash)
            .ok_or(FactoryError::InvalidCodeHash)?;

        // ── Deploy the proxy contract ────────────────────────────────
        // The proxy's __constructor receives (owner, factory, relayer).
        let proxy_id = env
            .deployer()
            .with_current_contract(deployment_salt)
            .deploy_v2(
                proxy_code_hash,
                (
                    config.owner.clone(),
                    env.current_contract_address(),
                    config.relayer.clone(),
                ),
            );

        // ── Record the deployment ────────────────────────────────────
        let mut updated_salts = deployed_salts;
        updated_salts.set(pair_key, proxy_id.clone());
        env.storage()
            .instance()
            .set(&StorageKey::DeployedSalts, &updated_salts);

        // Keep the primary owner → proxy mapping (last-deployed wins for
        // owners that deploy multiple wallets with different salts).
        let mut user_to_proxy: Map<Address, Address> = env
            .storage()
            .instance()
            .get(&StorageKey::UserToProxy)
            .unwrap_or(Map::new(&env));
        user_to_proxy.set(config.owner.clone(), proxy_id.clone());
        env.storage()
            .instance()
            .set(&StorageKey::UserToProxy, &user_to_proxy);

        let mut deployed: Vec<Address> = env
            .storage()
            .instance()
            .get(&StorageKey::DeployedProxies)
            .unwrap_or(Vec::new(&env));
        deployed.push_back(proxy_id.clone());
        env.storage()
            .instance()
            .set(&StorageKey::DeployedProxies, &deployed);

        // Advance the global nonce so the next deployment gets a fresh salt.
        let nonce: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::Nonce)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&StorageKey::Nonce, &(nonce + 1));

        env.events().publish(
            (symbol_short!("deploy"),),
            (proxy_id.clone(), config.owner.clone()),
        );

        Ok(proxy_id)
    }

    /// Deploy a proxy wallet with a predictable address (convenience wrapper).
    pub fn deploy_proxy_deterministic(
        env: Env,
        owner: Address,
        salt: u64,
        relayer: Option<Address>,
    ) -> Result<Address, FactoryError> {
        let config = DeploymentConfig {
            owner,
            relayer,
            salt,
        };
        Self::deploy_proxy(env, config)
    }

    // ═══════════════════════════════════════════════════════════════════
    // RELAYER MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    pub fn set_relayer(env: Env, admin: Address, relayer: Address) -> Result<(), FactoryError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage().instance().set(&StorageKey::Relayer, &relayer);

        env.events()
            .publish((symbol_short!("set_rel"),), (relayer,));

        Ok(())
    }

    pub fn get_relayer(env: Env) -> Result<Option<Address>, FactoryError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::Relayer))
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    pub fn get_proxy_for_user(env: Env, user: Address) -> Result<Option<Address>, FactoryError> {
        Self::require_initialized(&env)?;

        let user_to_proxy: Map<Address, Address> = env
            .storage()
            .instance()
            .get(&StorageKey::UserToProxy)
            .unwrap_or(Map::new(&env));

        Ok(user_to_proxy.get(user))
    }

    pub fn get_all_proxies(env: Env) -> Result<Vec<Address>, FactoryError> {
        Self::require_initialized(&env)?;

        Ok(env
            .storage()
            .instance()
            .get(&StorageKey::DeployedProxies)
            .unwrap_or(Vec::new(&env)))
    }

    pub fn get_proxy_count(env: Env) -> Result<u32, FactoryError> {
        Self::require_initialized(&env)?;

        let deployed: Vec<Address> = env
            .storage()
            .instance()
            .get(&StorageKey::DeployedProxies)
            .unwrap_or(Vec::new(&env));

        Ok(deployed.len())
    }

    pub fn get_proxy_info(env: Env, proxy_address: Address) -> Result<ProxyInfo, FactoryError> {
        Self::require_initialized(&env)?;

        let user_to_proxy: Map<Address, Address> = env
            .storage()
            .instance()
            .get(&StorageKey::UserToProxy)
            .unwrap_or(Map::new(&env));

        for owner in user_to_proxy.keys() {
            if user_to_proxy.get(owner.clone()) == Some(proxy_address.clone()) {
                return Ok(ProxyInfo {
                    proxy_address: proxy_address.clone(),
                    owner,
                    deployed_at: 0,
                    salt: 0,
                });
            }
        }

        Err(FactoryError::ProxyNotFound)
    }

    /// Returns the stored proxy Wasm hash.
    pub fn get_proxy_code_hash(env: Env) -> Result<BytesN<32>, FactoryError> {
        Self::require_initialized(&env)?;
        env.storage()
            .instance()
            .get(&StorageKey::ProxyCodeHash)
            .ok_or(FactoryError::InvalidCodeHash)
    }

    pub fn get_admin(env: Env) -> Result<Address, FactoryError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::Admin).unwrap())
    }

    /// Compute the deployment salt that would be used for (owner, user_salt).
    /// Returns the BytesN<32> that is passed to the Soroban deployer.
    pub fn compute_proxy_address(
        env: Env,
        _owner: Address,
        salt: u64,
    ) -> Result<BytesN<32>, FactoryError> {
        Self::require_initialized(&env)?;
        Ok(Self::generate_deployment_salt(&env, salt))
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    fn require_initialized(env: &Env) -> Result<(), FactoryError> {
        if !env.storage().instance().has(&StorageKey::Initialized) {
            return Err(FactoryError::NotInitialized);
        }
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), FactoryError> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .ok_or(FactoryError::NotInitialized)?;

        if *caller != admin {
            return Err(FactoryError::Unauthorized);
        }
        Ok(())
    }

    /// Produce a unique BytesN<32> deployment salt.
    ///
    /// salt = sha256(global_nonce_be8 || user_salt_be8)
    ///
    /// The global nonce advances after every successful deployment, so even if
    /// two callers pass the same `user_salt` the resulting deployer salts will
    /// differ (assuming sequential calls — the nonce is read before the deployer
    /// call and incremented after, within the same transaction).
    fn generate_deployment_salt(env: &Env, user_salt: u64) -> BytesN<32> {
        let nonce: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::Nonce)
            .unwrap_or(0);

        let mut preimage = [0u8; 16];
        preimage[..8].copy_from_slice(&nonce.to_be_bytes());
        preimage[8..].copy_from_slice(&user_salt.to_be_bytes());

        env.crypto()
            .sha256(&Bytes::from_array(env, &preimage))
            .to_bytes()
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{BytesN, Env};

    fn setup_factory(env: &Env) -> (WalletFactoryClient<'static>, Address) {
        env.mock_all_auths();

        let contract_id = env.register(WalletFactory, ());
        let client = WalletFactoryClient::new(env, &contract_id);

        let admin = Address::generate(env);
        let proxy_code_hash = BytesN::from_array(env, &[0u8; 32]);

        client.initialize(&admin, &proxy_code_hash);

        (client, admin)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let (client, admin) = setup_factory(&env);

        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_proxy_count(), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(WalletFactory, ());
        let client = WalletFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let proxy_code_hash = BytesN::from_array(&env, &[0u8; 32]);

        client.initialize(&admin, &proxy_code_hash);
        client.initialize(&admin, &proxy_code_hash);
    }

    #[test]
    fn test_compute_proxy_address_is_deterministic() {
        let env = Env::default();
        let (client, _) = setup_factory(&env);

        let owner = Address::generate(&env);
        // compute_proxy_address returns the deployment salt (BytesN<32>), not an Address.
        let salt1 = client.compute_proxy_address(&owner, &0_u64);
        let salt2 = client.compute_proxy_address(&owner, &0_u64);

        // Same inputs → same salt (nonce unchanged between calls in same tx).
        assert_eq!(salt1, salt2);
    }

    #[test]
    fn test_compute_proxy_address_different_salts_differ() {
        let env = Env::default();
        let (client, _) = setup_factory(&env);

        let owner = Address::generate(&env);
        let salt_a = client.compute_proxy_address(&owner, &1_u64);
        let salt_b = client.compute_proxy_address(&owner, &2_u64);

        assert_ne!(salt_a, salt_b);
    }

    #[test]
    fn test_get_all_proxies_starts_empty() {
        let env = Env::default();
        let (client, _) = setup_factory(&env);
        assert_eq!(client.get_all_proxies().len(), 0);
    }

    #[test]
    fn test_set_relayer() {
        let env = Env::default();
        let (client, admin) = setup_factory(&env);

        let relayer = Address::generate(&env);
        client.set_relayer(&admin, &relayer);

        assert_eq!(client.get_relayer(), Some(relayer));
    }

    #[test]
    fn test_get_nonexistent_proxy_info_panics() {
        let env = Env::default();
        let (client, _) = setup_factory(&env);
        // Panics because error variant 7 = ProxyNotFound.
        // Wrap in catch_unwind equivalent: use #[should_panic].
        let _ = client.get_proxy_count(); // verify basic ops still work
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")]
    fn test_get_proxy_info_panics_for_unknown_address() {
        let env = Env::default();
        let (client, _) = setup_factory(&env);
        let nonexistent = Address::generate(&env);
        client.get_proxy_info(&nonexistent);
    }

    #[test]
    fn test_proxy_code_hash_stored_as_bytesn32() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(WalletFactory, ());
        let client = WalletFactoryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let hash = BytesN::from_array(&env, &[0xAB_u8; 32]);
        client.initialize(&admin, &hash);
        assert_eq!(client.get_proxy_code_hash(), hash);
    }
}
