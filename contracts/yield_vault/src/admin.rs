use crate::{events, DataKey, VaultError, YieldVault};
use soroban_sdk::{contractimpl, symbol_short, xdr::ToXdr, Address, Bytes, BytesN, Env};

#[contractimpl]
impl YieldVault {
    /// Immediately pause all vault operations (deposit, rebalance, harvest, flash loan).
    /// Callable only by admin.
    pub fn emergency_pause(env: Env, admin: Address) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        // Use versioned event emission (#904)
        events::emit_versioned_event(
            &env,
            symbol_short!("pause"),
            events::ADMIN_ACTION_EVENT_V1.schema_version,
            (admin,),
        );
        Ok(())
    }

    /// Resume vault operations after an emergency pause.
    /// Callable only by admin.
    pub fn emergency_unpause(env: Env, admin: Address) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().remove(&DataKey::Paused);
        // Use versioned event emission (#904)
        events::emit_versioned_event(
            &env,
            symbol_short!("unpause"),
            events::ADMIN_ACTION_EVENT_V1.schema_version,
            (admin,),
        );
        Ok(())
    }

    /// Rescue tokens sent to the contract by mistake.
    ///
    /// # Arguments
    /// * `admin`  - The admin address authorizing the rescue.
    /// * `target` - The address to receive the rescued funds.
    /// * `amount` - The amount of tokens to rescue.
    ///
    /// # Security
    /// Only the admin can call this. Clamped to actual available balance.
    pub fn rescue_funds(
        env: Env,
        admin: Address,
        target: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;
        if amount <= 0 {
            return Err(VaultError::ZeroAmount);
        }

        let token_addr: Address = Self::get_storage_required(&env, &DataKey::Token)?;
        let total_assets: i128 = Self::get_storage_required(&env, &DataKey::TotalAssets)?;

        // Check balance directly from the token client
        let client = soroban_sdk::token::Client::new(&env, &token_addr);
        let current_balance = client.balance(&env.current_contract_address());

        // Ensure we don't try to send more than we have
        let rescue_amount = if amount > current_balance {
            current_balance
        } else {
            amount
        };

        client.transfer(&env.current_contract_address(), &target, &rescue_amount);

        // Update tracked assets if we pulled from the vault's core
        if rescue_amount > 0 {
            let new_total = if total_assets > rescue_amount {
                total_assets - rescue_amount
            } else {
                0
            };
            env.storage()
                .instance()
                .set(&DataKey::TotalAssets, &new_total);
        }

        events::emit_versioned_event(
            &env,
            symbol_short!("rescue"),
            events::ADMIN_ACTION_EVENT_V1.schema_version,
            (admin, target, rescue_amount),
        );
        Ok(())
    }

    /// Initiate or finalize a change of the admin address with a 24-hour timelock.
    ///
    /// To change admin:
    /// 1. Call `set_admin` with the `new_admin` address. This starts the 24h timelock.
    /// 2. After 24h, call `set_admin` again with the same `new_admin` address to finalize.
    pub fn set_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;

        let now = env.ledger().timestamp();

        // If there's already a pending admin, check timelock
        let pending_admin: Option<(Address, u64)> =
            env.storage().instance().get(&DataKey::PendingAdmin);

        if let Some(pending) = pending_admin {
            if pending.0 == new_admin && now >= pending.1 {
                env.storage().instance().set(&DataKey::Admin, &new_admin);
                env.storage().instance().remove(&DataKey::PendingAdmin);
                events::emit_versioned_event(
                    &env,
                    symbol_short!("set_adm"),
                    events::ADMIN_ACTION_EVENT_V1.schema_version,
                    (admin, new_admin),
                );
                return Ok(());
            }
        }

        // Set pending admin with 24-hour timelock (86400 seconds)
        let unlock_time = now + 86400;
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &(new_admin.clone(), unlock_time));
        events::emit_versioned_event(
            &env,
            symbol_short!("adm_tm"),
            events::ADMIN_ACTION_EVENT_V1.schema_version,
            (admin, new_admin, unlock_time),
        );

        Err(VaultError::TimelockActive)
    }

    /// Propose a new WASM code upgrade with a 24-hour timelock.
    ///
    /// # Arguments
    /// * `admin` - The admin address proposing the upgrade.
    /// * `new_wasm_hash` - SHA256 hash of the compiled Soroban WASM code.
    pub fn propose_upgrade(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;

        let now = env.ledger().timestamp();
        let unlock_time = now + 86400; // 24-hour timelock

        env.storage()
            .instance()
            .set(&DataKey::PendingUpgrade, &(new_wasm_hash.clone(), unlock_time));

        events::emit_versioned_event(
            &env,
            symbol_short!("prp_upg"),
            events::ADMIN_ACTION_EVENT_V1.schema_version,
            (admin, new_wasm_hash, unlock_time),
        );

        Err(VaultError::TimelockActive)
    }

    /// Commit a previously proposed WASM code upgrade after the 24-hour timelock.
    ///
    /// # Arguments
    /// * `admin` - The admin address executing the upgrade.
    /// * `new_wasm_hash` - The expected WASM hash previously proposed.
    pub fn commit_upgrade(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;

        let pending: Option<(BytesN<32>, u64)> = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade);

        let (pending_hash, unlock_time) = pending.ok_or(VaultError::Unauthorized)?;

        if pending_hash != new_wasm_hash {
            return Err(VaultError::Unauthorized);
        }

        let now = env.ledger().timestamp();
        if now < unlock_time {
            return Err(VaultError::TimelockActive);
        }

        // Apply contract code upgrade using Soroban deployer API
        env.deployer().update_current_contract_wasm(new_wasm_hash.clone());

        // Remove pending upgrade record
        env.storage().instance().remove(&DataKey::PendingUpgrade);

        events::emit_versioned_event(
            &env,
            symbol_short!("upgraded"),
            events::ADMIN_ACTION_EVENT_V1.schema_version,
            (admin, new_wasm_hash),
        );

        Ok(())
    }

    /// View function to check if the vault is currently paused.
    /// Delegates to emergency.rs implementation which handles automatic expiry
    /// and guardian-based pause state.
    pub fn is_paused(env: &Env) -> bool {
        let legacy_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if legacy_paused {
            return true;
        }
        let pause_start: Option<u64> = env
            .storage()
            .instance()
            .get(&crate::emergency::EmergencyKey::PauseStart);
        let pause_duration: Option<u64> = env
            .storage()
            .instance()
            .get(&crate::emergency::EmergencyKey::PauseDuration);
        match (pause_start, pause_duration) {
            (Some(start), Some(duration)) => {
                let now = env.ledger().timestamp();
                let elapsed = now.saturating_sub(start);
                if elapsed >= duration {
                    env.storage()
                        .instance()
                        .remove(&crate::emergency::EmergencyKey::PauseStart);
                    env.storage()
                        .instance()
                        .remove(&crate::emergency::EmergencyKey::PauseDuration);
                    false
                } else {
                    true
                }
            }
            _ => false,
        }
    }

    // ── Replay Protection for Admin Operations (#902) ───────────────────
    /// Verify and consume an admin operation intent with domain separation.
    pub fn verify_admin_operation(
        env: &Env,
        operation_type: soroban_sdk::Symbol,
        nonce: u64,
        expiry_timestamp: u64,
    ) -> Result<(), VaultError> {
        let now = env.ledger().timestamp();

        if now > expiry_timestamp {
            return Err(VaultError::OperationExpired);
        }

        let network = env.ledger().network_id();
        let contract = env.current_contract_address();

        let preimage = (network, contract, operation_type, nonce, expiry_timestamp).to_xdr(env);
        let op_hash: Bytes = env.crypto().sha256(&preimage).into();

        if env.storage().instance().has(&DataKey::ExecutedAdminOp(op_hash.clone())) {
            return Err(VaultError::OperationReplayed);
        }

        env.storage()
            .instance()
            .set(&DataKey::ExecutedAdminOp(op_hash), &true);

        Ok(())
    }

    // ── Cross-Contract Allowlist with Network Binding (#905) ──────────────
    /// Register an allowed contract for a given role on this network.
    pub fn set_allowed_contract(
        env: Env,
        admin: Address,
        role: soroban_sdk::Symbol,
        contract: Address,
    ) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&DataKey::AllowedContractRole(role.clone()), &contract);

        env.events().publish(
            (symbol_short!("allow"),),
            (admin, role, contract),
        );
        Ok(())
    }

    /// Verify that a calling contract is allowed for the given role.
    pub fn require_allowed_contract(
        env: &Env,
        role: soroban_sdk::Symbol,
        caller: &Address,
    ) -> Result<(), VaultError> {
        let allowed: Option<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedContractRole(role));

        match allowed {
            Some(allowed_contract) if &allowed_contract == caller => Ok(()),
            _ => Err(VaultError::UnauthorizedContract),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{YieldVault, YieldVaultClient};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{BytesN, Env};

    fn setup_env() -> (Env, YieldVaultClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(YieldVault, ());
        let client = YieldVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let token_addr = token_contract.address();

        client.initialize(&admin, &token_addr);

        (env, client, admin, token_addr)
    }

    #[test]
    fn test_emergency_pause_and_unpause_circuit_breaker() {
        let (env, client, admin, _) = setup_env();
        let user = Address::generate(&env);

        // Initially not paused
        assert!(!YieldVault::is_paused(&env));

        // Admin triggers emergency pause
        client.emergency_pause(&admin);
        assert!(YieldVault::is_paused(&env));

        // Deposits should be blocked while paused
        let deposit_res = client.try_deposit(&user, &1000, &1000);
        assert!(deposit_res.is_err());

        // Admin unpauses
        client.emergency_unpause(&admin);
        assert!(!YieldVault::is_paused(&env));
    }

    #[test]
    fn test_rescue_funds() {
        let (env, client, admin, token_addr) = setup_env();
        let target = Address::generate(&env);

        // Mint tokens directly to the contract (simulating accidental transfer)
        let token_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&client.address, &5000);

        // Rescue funds
        let rescue_res = client.try_rescue_funds(&admin, &target, &2000);
        assert!(rescue_res.is_ok());
    }

    #[test]
    fn test_set_admin_24h_timelock() {
        let (env, client, admin, _) = setup_env();
        let new_admin = Address::generate(&env);

        // Step 1: Initiate set_admin (returns TimelockActive error)
        let res1 = client.try_set_admin(&admin, &new_admin);
        assert!(res1.is_err());

        // Jump forward 12 hours (43200s) - should still fail
        env.ledger().set_timestamp(env.ledger().timestamp() + 43200);
        let res2 = client.try_set_admin(&admin, &new_admin);
        assert!(res2.is_err());

        // Jump forward another 12 hours (86400s total) - should succeed
        env.ledger().set_timestamp(env.ledger().timestamp() + 43200);
        let res3 = client.try_set_admin(&admin, &new_admin);
        assert!(res3.is_ok());
    }

    #[test]
    fn test_propose_and_commit_upgrade_timelock() {
        let (env, client, admin, _) = setup_env();
        let fake_wasm_hash = BytesN::from_array(&env, &[7u8; 32]);

        // Propose upgrade
        let prop_res = client.try_propose_upgrade(&admin, &fake_wasm_hash);
        assert!(prop_res.is_err());

        // Commit upgrade before 24h should fail
        let commit_early = client.try_commit_upgrade(&admin, &fake_wasm_hash);
        assert!(commit_early.is_err());

        // Jump forward 24h (86401 seconds)
        env.ledger().set_timestamp(env.ledger().timestamp() + 86401);
        let commit_res = client.try_commit_upgrade(&admin, &fake_wasm_hash);
        assert!(commit_res.is_ok());
    }
}
