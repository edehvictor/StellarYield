//! Emergency withdrawal path that bypasses external strategies and only
//! consumes idle reserves held by the vault contract itself.
//!
//! Security:
//! - Skips oracle checks and external calls.
//! - Does not attempt to recall funds from strategies/pools.
//! - Optionally applies a penalty (haircut) set by admin in basis points.
//! - Ensures users cannot withdraw more than their proportional claim on idle reserves.
//! - Cannot be used to bypass borrow limits: since the vault has no per-user
//!   debt accounting, emergency withdrawal only uses idle funds and burns
//!   the corresponding shares; if a borrowing module is later added, integrate
//!   a "no-active-debt(user)" guard here.

use soroban_sdk::{symbol_short, token, Address, Env};

use crate::{DataKey, VaultError, YieldVault};

impl YieldVault {
    /// Admin function: set emergency penalty basis points [0..=10_000].
    pub(crate) fn set_emergency_penalty_impl(
        env: &Env,
        admin: &Address,
        penalty_bps: u32,
    ) -> Result<(), VaultError> {
        Self::require_init(env)?;
        Self::require_admin(env, admin)?;
        if penalty_bps > 10_000 {
            return Err(VaultError::InvalidPrice); // reusing error for invalid param
        }
        env.storage()
            .instance()
            .set(&DataKey::EmergencyPenaltyBps, &penalty_bps);
        env.events()
            .publish((symbol_short!("emg_pen"),), (admin.clone(), penalty_bps));
        Ok(())
    }

    /// Emergency withdraw: burns `shares` and transfers up to the proportional
    /// amount from idle reserves only, optionally applying a penalty haircut.
    ///
    /// Skips paused/oracle/strategy interactions.
    pub(crate) fn emergency_withdraw_impl(
        env: &Env,
        to: &Address,
        shares: i128,
    ) -> Result<i128, VaultError> {
        Self::require_init(env)?;
        to.require_auth();
        if shares <= 0 {
            return Err(VaultError::ZeroAmount);
        }

        // Check user shares
        let user_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Shares(to.clone()))
            .unwrap_or(0);
        if user_shares < shares {
            return Err(VaultError::InsufficientShares);
        }

        let total_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0);
        let total_assets_accounted: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);
        if total_shares == 0 {
            return Err(VaultError::ZeroSupply);
        }

        // Determine idle reserves = actual token balance of this contract
        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(env, &token_addr);
        let vault_addr = env.current_contract_address();
        let idle_balance = client.balance(&vault_addr);

        // Proportional claim based on shares vs total_shares, capped by idle balance
        let mut amount = (shares * total_assets_accounted) / total_shares;
        if amount > idle_balance {
            amount = idle_balance;
        }
        if amount <= 0 {
            return Err(VaultError::InsufficientShares);
        }

        // Apply optional penalty haircut
        let penalty_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::EmergencyPenaltyBps)
            .unwrap_or(0u32);
        let net_amount = if penalty_bps > 0 {
            let cut = (amount * penalty_bps as i128) / 10_000;
            amount - cut
        } else {
            amount
        };

        // Transfer net amount to user from idle reserves
        client.transfer(&vault_addr, to, &net_amount);

        // Burn shares and update accounting to reflect actual moved amount
        env.storage()
            .persistent()
            .set(&DataKey::Shares(to.clone()), &(user_shares - shares));
        let new_total_shares = total_shares - shares;
        let new_total_assets = total_assets_accounted - net_amount;
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &new_total_shares);
        env.storage()
            .instance()
            .set(&DataKey::TotalAssets, &new_total_assets);

        env.events().publish(
            (symbol_short!("emg_wd"),),
            (to.clone(), net_amount, shares, penalty_bps),
        );

        Ok(net_amount)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{YieldVault, YieldVaultClient};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup_env() -> (Env, YieldVaultClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(YieldVault, ());
        let client = YieldVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();

        client.initialize(&admin, &token_addr);

        (env, client, admin, token_addr, token_admin)
    }

    fn mint_tokens(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
        let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    #[test]
    fn test_emergency_withdraw_from_idle_only() {
        let (env, client, admin, token_addr, _token_admin) = setup_env();
        let user = Address::generate(&env);
        let pool = Address::generate(&env);
        mint_tokens(&env, &token_addr, &user, 10_000);
        client.deposit(&user, &10_000, &0);

        // Move 7_000 to external pool; idle left = 3_000
        client.rebalance(&admin, &pool, &7_000);

        // Attempt emergency withdraw of full shares (would be 10_000 normally),
        // should only receive idle 3_000
        let out = client.emergency_withdraw(&user, &10_000);
        assert_eq!(out, 3_000);
    }

    #[test]
    fn test_emergency_penalty_applied() {
        let (env, client, admin, token_addr, _token_admin) = setup_env();
        let user = Address::generate(&env);
        mint_tokens(&env, &token_addr, &user, 5_000);
        client.deposit(&user, &5_000, &0);

        // Set 10% penalty
        client.set_emergency_penalty(&admin, &1_000);

        let out = client.emergency_withdraw(&user, &5_000);
        // Idle = 5000, penalty 10% -> 4500
        assert_eq!(out, 4_500);
    }
}
