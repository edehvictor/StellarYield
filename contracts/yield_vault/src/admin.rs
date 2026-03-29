use crate::{DataKey, VaultError, YieldVault};
use soroban_sdk::{symbol_short, Address, Env};

impl YieldVault {
    /// Immediately pause all vault operations (deposit, withdraw, rebalance).
    /// Callable only by admin.
    pub fn emergency_pause(env: Env, admin: Address) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((symbol_short!("pause"),), (admin,));
        Ok(())
    }

    /// Resume vault operations after an emergency pause.
    /// Callable only by admin.
    pub fn emergency_unpause(env: Env, admin: Address) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().remove(&DataKey::Paused);
        env.events().publish((symbol_short!("unpause"),), (admin,));
        Ok(())
    }

    /// Emergency function to rescue tokens stuck in the contract.
    /// Admin-only. Can be used to retrieve non-core tokens or adjust balance.
    ///
    /// # Arguments
    /// * `admin` - Current admin address.
    /// * `target` - Recipient of rescued funds.
    /// * `amount` - Amount to rescue.
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

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let total_assets: i128 = env.storage().instance().get(&DataKey::TotalAssets).unwrap();

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

    /// View function to check if the vault is currently paused.
    pub fn is_paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }
}
