use crate::{DataKey, VaultError, YieldVault, YieldVaultArgs, YieldVaultClient};
use soroban_sdk::{contractimpl, symbol_short, xdr::ToXdr, Address, Bytes, Env};

#[contractimpl]
impl YieldVault {
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

        env.events()
            .publish((symbol_short!("rescue"),), (admin, target, rescue_amount));
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
                env.events()
                    .publish((symbol_short!("set_adm"),), (admin, new_admin));
                return Ok(());
            }
        }

        // Set pending admin with 24-hour timelock (86400 seconds)
        let unlock_time = now + 86400;
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &(new_admin.clone(), unlock_time));
        env.events()
            .publish((symbol_short!("adm_tm"),), (admin, new_admin, unlock_time));

        Err(VaultError::TimelockActive)
    }
}

// ── Replay Protection for Admin Operations (#902) ───────────────────
impl YieldVault {
    /// Verify and consume an admin operation intent with domain separation.
    ///
    /// Domain includes:
    /// - Network passphrase (prevents cross-network replay)
    /// - Contract address (prevents cross-contract replay)
    /// - Operation type (pause, unpause, set_admin, etc.)
    /// - Nonce (prevents replay of same operation)
    /// - Expiry timestamp (operations expire after 1 hour)
    ///
    /// # Arguments
    /// * `operation_type` - Symbolic operation identifier (e.g., "pause", "admin")
    /// * `nonce` - Unique nonce for this operation
    /// * `expiry_timestamp` - Unix timestamp when this operation expires
    ///
    /// # Returns
    /// Ok if the operation is valid and hasn't been executed before.
    /// Err if expired or already executed.
    pub fn verify_admin_operation(
        env: &Env,
        operation_type: soroban_sdk::Symbol,
        nonce: u64,
        expiry_timestamp: u64,
    ) -> Result<(), VaultError> {
        let now = env.ledger().timestamp();

        // Check expiry
        if now > expiry_timestamp {
            return Err(VaultError::OperationExpired);
        }

        // Build domain-separated hash
        // Domain = network || contract || operation || nonce || expiry
        let network = env.ledger().network_id();
        let contract = env.current_contract_address();

        let preimage = (network, contract, operation_type, nonce, expiry_timestamp).to_xdr(env);
        let op_hash: Bytes = env.crypto().sha256(&preimage).into();

        // Check if already executed
        if env
            .storage()
            .instance()
            .has(&DataKey::ExecutedAdminOp(op_hash.clone()))
        {
            return Err(VaultError::OperationReplayed);
        }

        // Mark as executed
        env.storage()
            .instance()
            .set(&DataKey::ExecutedAdminOp(op_hash), &true);

        Ok(())
    }

    // ── Cross-Contract Allowlist with Network Binding (#905) ──────────────
    /// Register an allowed contract for a given role on this network.
    ///
    /// Only the admin can call this. Once registered, only that contract
    /// (on this network) can call functions that check this role.
    ///
    /// # Arguments
    /// * `admin` - Must be the vault admin
    /// * `role` - Symbolic role identifier (e.g., "zap", "keeper", "oracle")
    /// * `contract` - The contract address to allowlist for this role
    pub fn set_allowed_contract(
        env: Env,
        admin: Address,
        role: soroban_sdk::Symbol,
        contract: Address,
    ) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;

        // Store the allowed contract for this role
        // Network binding is implicit: contracts are tied to their deployment network
        env.storage()
            .instance()
            .set(&DataKey::AllowedContractRole(role.clone()), &contract);

        env.events()
            .publish((symbol_short!("allow"),), (admin, role, contract));
        Ok(())
    }

    /// Verify that a calling contract is allowed for the given role.
    ///
    /// # Arguments
    /// * `role` - The role to verify (e.g., "zap", "keeper")
    /// * `caller` - The address attempting to call
    ///
    /// # Returns
    /// Ok if caller is the allowed contract for this role.
    /// Err if caller is unknown or wrong for this role.
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
