//! # Emergency Pause System with Timelocked Guardian Authority
//!
//! Implements a timelocked emergency pause mechanism with bounded guardian
//! authority. The guardian can pause the vault for a maximum duration, but
//! cannot permanently lock withdrawals or transfer funds. Governance can
//! extend pauses or rotate the guardian.
//!
//! ## Security Model
//! - Guardian can pause for at most `MAX_PAUSE_DURATION` seconds (24 hours).
//! - Guardian cannot transfer funds or permanently lock withdrawals.
//! - Pause expires automatically after `MAX_PAUSE_DURATION`.
//! - Governance can confirm long pauses (>24h) or change guardian parameters.
//! - All pause/unpause/expiry/rotation events are emitted.
//!
//! ## Affected Actions (when paused)
//! - `deposit` - Blocked
//! - `deposit_for` - Blocked
//! - `rebalance` - Blocked
//! - `harvest` - Blocked
//! - `withdraw` - Allowed (users must be able to exit)
//! - `emergency_withdraw` - Allowed
//! - `flash_loan` - Blocked
//!
//! ## Rounding
//! Emergency withdrawal penalty uses floor division (user-favorable).
//! Maximum rounding dust: 1 unit per withdrawal.

use soroban_sdk::{contractimpl, contracttype, symbol_short, token, Address, Env};

use crate::{DataKey, VaultError, YieldVault, YieldVaultArgs, YieldVaultClient};

/// Storage keys for emergency pause state.
#[contracttype]
pub enum EmergencyKey {
    /// Current guardian address (can pause/unpause within limits).
    Guardian,
    /// Timestamp when the current pause started (0 if not paused).
    PauseStart,
    /// Duration in seconds for which the pause is active (0 if not paused).
    PauseDuration,
    /// Maximum pause duration in seconds (default: 86400 = 24 hours).
    MaxPauseDuration,
    /// Governance-controlled: can override pauses.
    Governance,
}

/// Default maximum pause duration: 24 hours (86400 seconds).
const DEFAULT_MAX_PAUSE_DURATION: u64 = 86400;

#[contractimpl]
impl YieldVault {
    /// Set the guardian address. Admin-only.
    ///
    /// # Arguments
    /// * `admin` - Current admin address.
    /// * `guardian` - New guardian address.
    pub fn set_guardian(env: Env, admin: Address, guardian: Address) -> Result<(), VaultError> {
        Self::require_init(&env)?;
        Self::require_admin(&env, &admin)?;

        let old_guardian: Option<Address> = env.storage().instance().get(&EmergencyKey::Guardian);
        env.storage()
            .instance()
            .set(&EmergencyKey::Guardian, &guardian);

        env.events().publish(
            (symbol_short!("guardian"),),
            (old_guardian, guardian.clone()),
        );

        Ok(())
    }

    /// Set the governance address. Admin-only.
    ///
    /// Governance can confirm long pauses or rotate the guardian.
    pub fn set_governance(env: Env, admin: Address, governance: Address) -> Result<(), VaultError> {
        Self::require_init(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&EmergencyKey::Governance, &governance);

        env.events()
            .publish((symbol_short!("gov_set"),), (admin, governance));

        Ok(())
    }

    /// Pause the vault. Callable by guardian or admin.
    ///
    /// The pause automatically expires after `max_pause_duration`.
    /// During pause:
    /// - deposits, rebalances, harvests, flash loans are blocked
    /// - withdrawals and emergency_withdrawals remain open
    ///
    /// # Arguments
    /// * `caller` - Must be guardian or admin.
    /// * `duration` - Pause duration in seconds. Clamped to MAX_PAUSE_DURATION.
    pub fn emergency_pause(env: Env, caller: Address, duration: u64) -> Result<(), VaultError> {
        Self::require_init(&env)?;
        caller.require_auth();
        Self::require_guardian_or_admin(&env, &caller)?;

        // Clamp duration to max
        let max_duration: u64 = env
            .storage()
            .instance()
            .get(&EmergencyKey::MaxPauseDuration)
            .unwrap_or(DEFAULT_MAX_PAUSE_DURATION);

        let clamped_duration = if duration > max_duration {
            max_duration
        } else {
            duration
        };

        let now = env.ledger().timestamp();

        env.storage()
            .instance()
            .set(&EmergencyKey::PauseStart, &now);
        env.storage()
            .instance()
            .set(&EmergencyKey::PauseDuration, &clamped_duration);

        env.events()
            .publish((symbol_short!("pause"),), (caller, now, clamped_duration));

        Ok(())
    }

    /// Unpause the vault. Callable by guardian, admin, or governance.
    pub fn emergency_unpause(env: Env, caller: Address) -> Result<(), VaultError> {
        Self::require_init(&env)?;
        caller.require_auth();

        // Allow guardian, admin, or governance to unpause
        let is_authorized = Self::is_guardian(&env, &caller)
            || Self::is_admin(&env, &caller)
            || Self::is_governance(&env, &caller);

        if !is_authorized {
            return Err(VaultError::Unauthorized);
        }

        env.storage().instance().remove(&EmergencyKey::PauseStart);
        env.storage()
            .instance()
            .remove(&EmergencyKey::PauseDuration);

        env.events().publish((symbol_short!("unpause"),), (caller,));

        Ok(())
    }

    /// Override max pause duration. Governance or admin only.
    ///
    /// # Arguments
    /// * `caller` - Must be governance or admin.
    /// * `new_max_duration` - New max pause duration in seconds.
    pub fn set_max_pause_duration(
        env: Env,
        caller: Address,
        new_max_duration: u64,
    ) -> Result<(), VaultError> {
        Self::require_init(&env)?;
        caller.require_auth();

        let is_authorized = Self::is_governance(&env, &caller) || Self::is_admin(&env, &caller);

        if !is_authorized {
            return Err(VaultError::Unauthorized);
        }

        env.storage()
            .instance()
            .set(&EmergencyKey::MaxPauseDuration, &new_max_duration);

        env.events()
            .publish((symbol_short!("max_pd"),), (caller, new_max_duration));

        Ok(())
    }

    /// Rotate the guardian. Callable by admin or governance.
    pub fn rotate_guardian(
        env: Env,
        caller: Address,
        new_guardian: Address,
    ) -> Result<(), VaultError> {
        Self::require_init(&env)?;
        caller.require_auth();

        let is_authorized = Self::is_governance(&env, &caller) || Self::is_admin(&env, &caller);

        if !is_authorized {
            return Err(VaultError::Unauthorized);
        }

        let old_guardian: Option<Address> = env.storage().instance().get(&EmergencyKey::Guardian);
        env.storage()
            .instance()
            .set(&EmergencyKey::Guardian, &new_guardian);

        env.events().publish(
            (symbol_short!("grd_rot"),),
            (caller, old_guardian, new_guardian),
        );

        Ok(())
    }

    /// Check if the vault is currently paused.
    /// Considers automatic expiry: if pause duration has elapsed, the pause
    /// is considered expired and the vault is unpaused.
    pub fn is_paused(env: &Env) -> bool {
        let pause_start: Option<u64> = env.storage().instance().get(&EmergencyKey::PauseStart);
        let pause_duration: Option<u64> =
            env.storage().instance().get(&EmergencyKey::PauseDuration);

        match (pause_start, pause_duration) {
            (Some(start), Some(duration)) => {
                let now = env.ledger().timestamp();
                let elapsed = now.saturating_sub(start);
                if elapsed >= duration {
                    // Pause has expired - auto-cleanup
                    env.storage().instance().remove(&EmergencyKey::PauseStart);
                    env.storage()
                        .instance()
                        .remove(&EmergencyKey::PauseDuration);
                    env.events().publish((symbol_short!("expire"),), ());
                    false
                } else {
                    true
                }
            }
            _ => false,
        }
    }

    /// Get the current pause state for display purposes.
    pub fn get_pause_state(env: Env) -> (bool, u64, u64) {
        let is_paused = Self::is_paused(&env);
        let pause_start: u64 = env
            .storage()
            .instance()
            .get(&EmergencyKey::PauseStart)
            .unwrap_or(0);
        let pause_duration: u64 = env
            .storage()
            .instance()
            .get(&EmergencyKey::PauseDuration)
            .unwrap_or(0);

        (is_paused, pause_start, pause_duration)
    }

    /// Get the current guardian address.
    pub fn get_guardian(env: Env) -> Option<Address> {
        env.storage().instance().get(&EmergencyKey::Guardian)
    }

    /// Get the current governance address.
    pub fn get_governance(env: Env) -> Option<Address> {
        env.storage().instance().get(&EmergencyKey::Governance)
    }

    /// Get the max pause duration.
    pub fn get_max_pause_duration(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&EmergencyKey::MaxPauseDuration)
            .unwrap_or(DEFAULT_MAX_PAUSE_DURATION)
    }

    // ── Implementation helpers ───────────────────────────────────────

    fn require_guardian_or_admin(env: &Env, caller: &Address) -> Result<(), VaultError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(VaultError::NotInitialized)?;

        let guardian: Option<Address> = env.storage().instance().get(&EmergencyKey::Guardian);

        if *caller == admin {
            return Ok(());
        }

        if let Some(g) = guardian {
            if *caller == g {
                return Ok(());
            }
        }

        Err(VaultError::Unauthorized)
    }

    fn is_guardian(env: &Env, caller: &Address) -> bool {
        let guardian: Option<Address> = env.storage().instance().get(&EmergencyKey::Guardian);
        match guardian {
            Some(g) => *caller == g,
            None => false,
        }
    }

    fn is_admin(env: &Env, caller: &Address) -> bool {
        let admin: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        match admin {
            Some(a) => *caller == a,
            None => false,
        }
    }

    fn is_governance(env: &Env, caller: &Address) -> bool {
        let governance: Option<Address> = env.storage().instance().get(&EmergencyKey::Governance);
        match governance {
            Some(g) => *caller == g,
            None => false,
        }
    }

    // ── Emergency Withdrawals (existing) ─────────────────────────────

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
    /// # Rounding
    /// Penalty uses floor division: `cut = (amount * penalty_bps) / 10_000`.
    /// This rounds the penalty **down** (user-favorable). Maximum rounding
    /// dust is 1 unit per withdrawal.
    ///
    /// Skips paused/oracle/strategy interactions. Always available even when paused.
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
        let token_addr: Address = Self::get_storage_required(env, &DataKey::Token)?;
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

        // Apply optional penalty haircut (floor division = user-favorable)
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
    use soroban_sdk::testutils::{Address as _, Ledger};
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
    fn test_guardian_pause_and_unpause() {
        let (env, client, admin, _, _) = setup_env();
        let guardian = Address::generate(&env);

        // Set guardian
        client.set_guardian(&admin, &guardian);

        // Guardian can pause
        let _ = client.emergency_pause(&guardian, &3600); // 1 hour
        assert!(client.get_pause_state().0);

        // Guardian can unpause
        let _ = client.emergency_unpause(&guardian);
        assert!(!client.get_pause_state().0);
    }

    #[test]
    fn test_admin_pause_and_unpause() {
        let (env, client, admin, _, _) = setup_env();

        // Admin can pause directly
        let _ = client.emergency_pause(&admin, &3600);
        assert!(client.get_pause_state().0);

        // Admin can unpause
        let _ = client.emergency_unpause(&admin);
        assert!(!client.get_pause_state().0);
    }

    #[test]
    fn test_guardian_cannot_set_max_pause_duration() {
        let (env, client, admin, _, _) = setup_env();
        let guardian = Address::generate(&env);

        client.set_guardian(&admin, &guardian);

        // Guardian should NOT be able to set max pause duration
        let result = client.try_set_max_pause_duration(&guardian, &172800);
        assert!(result.is_err());
    }

    #[test]
    fn test_governance_can_set_max_pause_duration() {
        let (env, client, admin, _, _) = setup_env();
        let governance = Address::generate(&env);

        client.set_governance(&admin, &governance);

        // Governance can set max pause duration
        let result = client.try_set_max_pause_duration(&governance, &172800);
        assert!(result.is_ok());
        assert_eq!(client.get_max_pause_duration(), 172800);
    }

    #[test]
    fn test_pause_expires_automatically() {
        let (env, client, admin, _, _) = setup_env();

        // Pause for 1 second
        let _ = client.emergency_pause(&admin, &1);
        assert!(client.get_pause_state().0);

        // Jump forward 2 seconds
        env.ledger().set_timestamp(env.ledger().timestamp() + 2);

        // Pause should have expired
        assert!(!client.get_pause_state().0);
    }

    #[test]
    fn test_deposit_blocked_during_pause() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);

        mint_tokens(&env, &token_addr, &user, 1000);

        // Pause
        let _ = client.emergency_pause(&admin, &3600);
        assert!(client.get_pause_state().0);

        // Deposit should fail during pause
        let result = client.try_deposit(&user, &1000, &1000);
        assert!(result.is_err());
    }

    #[test]
    fn test_withdraw_allowed_during_pause() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);

        mint_tokens(&env, &token_addr, &user, 1000);

        // Deposit first
        client.deposit(&user, &1000, &1000);

        // Pause
        let _ = client.emergency_pause(&admin, &3600);

        // Withdrawal should still work during pause
        let result = client.try_withdraw(&user, &500);
        assert!(result.is_ok());
    }

    #[test]
    fn test_rebalance_blocked_during_pause() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);
        let target = Address::generate(&env);

        mint_tokens(&env, &token_addr, &user, 1000);
        client.deposit(&user, &1000, &1000);

        // Pause
        let _ = client.emergency_pause(&admin, &3600);

        // Rebalance should fail during pause
        let result = client.try_rebalance(&admin, &target, &100);
        assert!(result.is_err());
    }

    #[test]
    fn test_guardian_rotation() {
        let (env, client, admin, _, _) = setup_env();
        let guardian1 = Address::generate(&env);
        let guardian2 = Address::generate(&env);

        // Set guardian
        client.set_guardian(&admin, &guardian1);
        assert_eq!(client.get_guardian(), Some(guardian1.clone()));

        // Admin rotates guardian
        client.rotate_guardian(&admin, &guardian2);
        assert_eq!(client.get_guardian(), Some(guardian2));
    }

    #[test]
    fn test_guardian_cannot_transfer_funds() {
        // Verify guardian cannot call rescue_funds
        let (env, client, admin, _, _) = setup_env();
        let guardian = Address::generate(&env);
        let target = Address::generate(&env);

        client.set_guardian(&admin, &guardian);

        // Guardian should not be able to rescue funds
        let result = client.try_rescue_funds(&guardian, &target, &100);
        assert!(result.is_err());
    }

    #[test]
    fn test_pause_duration_clamped() {
        let (env, client, admin, _, _) = setup_env();

        // Try to pause for 10 days (864000 seconds) - should clamp to default max (86400)
        let _ = client.emergency_pause(&admin, &864000);
        let (is_paused, _, duration) = client.get_pause_state();
        assert!(is_paused);
        // Should be clamped to DEFAULT_MAX_PAUSE_DURATION
        assert!(duration <= 86400);
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

    #[test]
    fn test_pause_expiry_reopens_user_exits() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);

        mint_tokens(&env, &token_addr, &user, 1000);
        client.deposit(&user, &1000, &1000);

        // Pause for a short duration
        let _ = client.emergency_pause(&admin, &5);
        assert!(client.get_pause_state().0);

        // Withdrawals are always allowed even during pause
        let result = client.try_withdraw(&user, &500);
        assert!(result.is_ok(), "Withdrawals must be allowed during pause");

        // Jump past pause expiry
        env.ledger().set_timestamp(env.ledger().timestamp() + 10);
        assert!(!client.get_pause_state().0, "Pause should auto-expire");

        // After expiry, deposits work again
        mint_tokens(&env, &token_addr, &user, 500);
        let result = client.try_deposit(&user, &500, &500);
        assert!(result.is_ok(), "Deposits should work after pause expiry");
    }

    #[test]
    fn test_guardian_cannot_permanently_lock_withdrawals() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);

        mint_tokens(&env, &token_addr, &user, 1000);
        client.deposit(&user, &1000, &1000);

        // Guardian pauses but cannot block withdraw
        let guardian = Address::generate(&env);
        client.set_guardian(&admin, &guardian);
        client.emergency_pause(&guardian, &3600);

        // User can still withdraw
        let result = client.try_withdraw(&user, &500);
        assert!(result.is_ok(), "Guardian cannot block withdrawals");
    }
}
