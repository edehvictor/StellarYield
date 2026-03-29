use crate::{VaultError, YieldVault};
use soroban_sdk::{contracttype, symbol_short, Address, Env, Vec};

/// Storage keys specific to the keeper network.
#[contracttype]
pub enum KeeperKey {
    /// List of registered keeper addresses.
    RegisteredKeepers,
    /// Fee basis points paid to keepers (e.g. 50 = 0.5%).
    KeeperFeeBps,
    /// Maximum fee basis points (cap to prevent drain).
    MaxKeeperFeeBps,
    /// Minimum harvest amount to justify keeper reward.
    MinHarvestThreshold,
}

/// Default keeper fee: 0.5% (50 bps).
const DEFAULT_KEEPER_FEE_BPS: i128 = 50;

/// Maximum allowed keeper fee: 2% (200 bps).
const MAX_KEEPER_FEE_BPS_CAP: i128 = 200;

/// Basis points denominator.
const BPS_DENOMINATOR: i128 = 10_000;

impl YieldVault {
    /// Register a new keeper node to the authorized list. Admin-only.
    ///
    /// # Arguments
    /// * `admin` - Current admin address.
    /// * `keeper` - Address of the keeper node to register.
    pub fn register_keeper(env: Env, admin: Address, keeper: Address) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;

        let mut keepers: Vec<Address> = env
            .storage()
            .instance()
            .get(&KeeperKey::RegisteredKeepers)
            .unwrap_or(Vec::new(&env));

        // Avoid duplicates
        let mut found = false;
        for existing in keepers.iter() {
            if existing == keeper {
                found = true;
                break;
            }
        }
        if !found {
            keepers.push_back(keeper.clone());
            env.storage()
                .instance()
                .set(&KeeperKey::RegisteredKeepers, &keepers);
        }

        env.events().publish((symbol_short!("kpr_add"),), (keeper,));
        Ok(())
    }

    /// Remove a keeper from the authorized registry. Admin-only.
    ///
    /// # Arguments
    /// * `admin` - Current admin address.
    /// * `keeper` - Address of the keeper to remove.
    pub fn remove_keeper(env: Env, admin: Address, keeper: Address) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;

        let keepers: Vec<Address> = env
            .storage()
            .instance()
            .get(&KeeperKey::RegisteredKeepers)
            .unwrap_or(Vec::new(&env));

        let mut new_keepers = Vec::new(&env);
        for existing in keepers.iter() {
            if existing != keeper {
                new_keepers.push_back(existing);
            }
        }

        env.storage()
            .instance()
            .set(&KeeperKey::RegisteredKeepers, &new_keepers);

        env.events().publish((symbol_short!("kpr_rem"),), (keeper,));
        Ok(())
    }

    /// Set the fee paid to keepers per harvest operation. Admin-only.
    /// This fee is in basis points and capped to prevent excessive draining.
    ///
    /// # Arguments
    /// * `admin` - Current admin address.
    /// * `fee_bps` - Fee in basis points (e.g., 50 = 0.5%).
    pub fn set_keeper_fee(env: Env, admin: Address, fee_bps: i128) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;

        let max_cap = env
            .storage()
            .instance()
            .get(&KeeperKey::MaxKeeperFeeBps)
            .unwrap_or(MAX_KEEPER_FEE_BPS_CAP);

        if fee_bps < 0 || fee_bps > max_cap {
            return Err(VaultError::ZeroAmount);
        }

        env.storage()
            .instance()
            .set(&KeeperKey::KeeperFeeBps, &fee_bps);

        env.events()
            .publish((symbol_short!("kpr_fee"),), (fee_bps,));
        Ok(())
    }

    /// Check whether a given address is a registered and authorized keeper.
    pub fn is_registered_keeper(env: &Env, addr: &Address) -> bool {
        let keepers: Vec<Address> = env
            .storage()
            .instance()
            .get(&KeeperKey::RegisteredKeepers)
            .unwrap_or(Vec::new(env));

        for existing in keepers.iter() {
            if &existing == addr {
                return true;
            }
        }
        false
    }

    /// Calculate the keeper reward for a given harvest amount.
    /// Returns the fee amount in base token units.
    pub fn calculate_keeper_fee(env: &Env, harvest_amount: i128) -> i128 {
        if harvest_amount <= 0 {
            return 0;
        }

        let fee_bps: i128 = env
            .storage()
            .instance()
            .get(&KeeperKey::KeeperFeeBps)
            .unwrap_or(DEFAULT_KEEPER_FEE_BPS);

        (harvest_amount * fee_bps) / BPS_DENOMINATOR
    }

    /// View: return the current amount of keeper fee in basis points.
    pub fn get_keeper_fee_bps(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&KeeperKey::KeeperFeeBps)
            .unwrap_or(DEFAULT_KEEPER_FEE_BPS)
    }

    /// View: return the full list of authorized keeper addresses.
    pub fn get_registered_keepers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&KeeperKey::RegisteredKeepers)
            .unwrap_or(Vec::new(&env))
    }
}
