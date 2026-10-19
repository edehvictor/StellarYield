//! # Storage Version Migration
//!
//! ## Background
//!
//! Prior to this module every YieldVault contract was deployed without an
//! on-chain schema version.  The absence of the `StorageVersion` key is
//! treated as version 0 (pre-migration).  This module introduces version 1
//! as the first versioned schema and provides a single, admin-gated
//! `migrate()` entrypoint that upgrades the storage layout from any
//! supported previous version to the target.
//!
//! ## Version history
//!
//! | Version | Change                                           |
//! |---------|--------------------------------------------------|
//! | 0       | Implicit (no key stored). Initial deployment.    |
//! | 1       | `StorageVersion` key written; `LiquidityDepthLimit` |
//! |         | defaulted to 0 (unlimited) if previously absent. |
//!
//! ## Migration invariants
//!
//! 1. **Idempotency guard** — calling `migrate()` a second time with the
//!    same target version returns `VaultError::AlreadyMigrated` without
//!    touching storage.
//! 2. **No downgrade** — migrating to a version older than the current
//!    on-chain version returns `VaultError::StorageVersionMismatch`.
//! 3. **Access control** — only the vault admin may call `migrate()`.
//! 4. **Data preservation** — existing `TotalAssets`, `TotalShares`, per-user
//!    `Shares(Address)`, `Admin`, and `Token` values are never modified.
//! 5. **Safe default** — any key that did not exist in version 0 is written
//!    with a documented zero/default value, never with an arbitrary or
//!    attacker-supplied value.

use crate::{DataKey, VaultError, YieldVault, YieldVaultArgs, YieldVaultClient};
use soroban_sdk::{contractimpl, symbol_short, Address, Env};

/// The storage version installed by this build of the contract.
///
/// Bump this constant — and add the corresponding migration arm below — every
/// time the on-chain storage schema changes.
pub const CURRENT_STORAGE_VERSION: u32 = 1;

#[contractimpl]
impl YieldVault {
    // ── Public migration entrypoint ─────────────────────────────────

    /// Migrate the vault's on-chain storage schema from its current version to
    /// `target_version`.
    ///
    /// This function is the **sole** mechanism for advancing the on-chain
    /// storage version.  It must be called by the vault admin after upgrading
    /// the WASM binary.
    ///
    /// # Arguments
    /// * `admin`          — Must be the current vault admin (will require_auth).
    /// * `target_version` — The version to migrate **to** (must be
    ///                      `CURRENT_STORAGE_VERSION` unless explicitly testing
    ///                      a no-op path).
    ///
    /// # Returns
    /// `Ok(u32)` — the new on-chain version after migration.
    ///
    /// # Errors
    /// * `VaultError::NotInitialized`         — vault has not been initialised.
    /// * `VaultError::Unauthorized`           — caller is not the admin.
    /// * `VaultError::AlreadyMigrated`        — storage is already at
    ///   `target_version`.
    /// * `VaultError::StorageVersionMismatch` — `target_version` is below the
    ///   current on-chain version (downgrade not supported).
    ///
    /// # Idempotency
    /// Calling `migrate()` twice with the same `target_version` returns
    /// `AlreadyMigrated` on the second call and leaves storage unchanged.
    ///
    /// # Access control
    /// Only the vault admin can trigger a migration.  An attacker or
    /// unprivileged caller receives `Unauthorized`.
    pub fn migrate(env: Env, admin: Address, target_version: u32) -> Result<u32, VaultError> {
        Self::require_init(&env)?;
        Self::require_admin(&env, &admin)?;

        let current_version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::StorageVersion)
            .unwrap_or(0);

        // Guard: already at target
        if current_version == target_version {
            return Err(VaultError::AlreadyMigrated);
        }

        // Guard: no downgrade
        if target_version < current_version {
            return Err(VaultError::StorageVersionMismatch);
        }

        // Apply each incremental upgrade step in order
        let mut version = current_version;
        while version < target_version {
            match version {
                // 0 -> 1: introduce `StorageVersion` key and ensure
                // `LiquidityDepthLimit` has a well-defined default.
                0 => {
                    // Ensure `LiquidityDepthLimit` exists with its documented
                    // default of 0 (unlimited).  This preserves behaviour for
                    // any pre-migration contract that never called
                    // `set_liquidity_depth_limit`.
                    if !env.storage().instance().has(&DataKey::LiquidityDepthLimit) {
                        env.storage()
                            .instance()
                            .set(&DataKey::LiquidityDepthLimit, &0i128);
                    }
                }
                // Future migration steps are added here as new arms.
                // e.g. 1 => { /* 1 -> 2 changes */ }
                _ => {
                    // Unreachable for any version we know about, but treated
                    // as a hard failure rather than a silent no-op so that a
                    // missing arm is caught by tests.
                    return Err(VaultError::StorageVersionMismatch);
                }
            }
            version += 1;
        }

        // Stamp the new version
        env.storage()
            .instance()
            .set(&DataKey::StorageVersion, &target_version);

        env.events().publish(
            (symbol_short!("migrated"),),
            (admin, current_version, target_version),
        );

        Ok(target_version)
    }

    // ── View helper ─────────────────────────────────────────────────

    /// Return the current on-chain storage version.
    ///
    /// Returns `0` for contracts deployed before storage versioning was
    /// introduced (absent `StorageVersion` key).
    pub fn storage_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::StorageVersion)
            .unwrap_or(0)
    }
}

// ── Smoke Tests ──────────────────────────────────────────────────────────
//
// These integration-style tests validate every migration invariant described
// in the module doc.  They are structured as "deploy -> (optionally seed
// pre-migration state) -> migrate -> assert" so each test exercises a single
// property and is self-contained.
//
// Conventions match the existing yield_vault test suite:
//   * Env::default() + env.mock_all_auths()
//   * env.register(YieldVault, ()) for contract deployment
//   * client.try_*() for expected-failure assertions with typed errors

#[cfg(test)]
mod migration_smoke_tests {
    use super::*;
    use crate::{YieldVault, YieldVaultClient};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    // ── Shared setup ────────────────────────────────────────────────

    /// Deploy and initialise a fresh vault, simulating a pre-migration
    /// (version-0) deployment — no `StorageVersion` key in storage.
    fn setup() -> (Env, YieldVaultClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(YieldVault, ());
        let client = YieldVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let token_addr = token_contract.address();

        client.initialize(&admin, &token_addr);

        // Post-initialize: implicit version 0 (no StorageVersion key yet).
        assert_eq!(client.storage_version(), 0);

        (env, client, admin)
    }

    // ══════════════════════════════════════════════════════════════════
    // 1. Happy path — successful migration with no pre-existing data
    // ══════════════════════════════════════════════════════════════════

    /// A freshly initialised vault (no user data) migrates from v0 -> v1
    /// cleanly: the version key is stamped and the event is emitted.
    #[test]
    fn test_migrate_v0_to_v1_empty_vault() {
        let (env, client, admin) = setup();

        assert_eq!(client.storage_version(), 0);

        let new_version = client.migrate(&admin, &1);

        assert_eq!(new_version, 1);
        assert_eq!(client.storage_version(), 1);

        // At least one event (the "migrated" event) must be present.
        assert!(
            !env.events().all().is_empty(),
            "migration must emit at least one event"
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 2. Happy path — migration preserves pre-existing user data
    // ══════════════════════════════════════════════════════════════════

    /// When a user has deposited before the migration runs, their share
    /// balance and vault accounting are untouched after migration.
    #[test]
    fn test_migrate_v0_to_v1_with_deposited_data() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(YieldVault, ());
        let client = YieldVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let token_addr = token_contract.address();

        client.initialize(&admin, &token_addr);

        // Deposit tokens before migration (pre-migration data)
        let user = Address::generate(&env);
        soroban_sdk::token::StellarAssetClient::new(&env, &token_addr).mint(&user, &5_000);
        let shares_before = client.deposit(&user, &5_000, &5_000);
        let assets_before = client.total_assets();
        let total_shares_before = client.total_shares();

        assert_eq!(client.storage_version(), 0);

        let new_version = client.migrate(&admin, &1);
        assert_eq!(new_version, 1);

        // INVARIANT: user shares are unchanged after migration
        assert_eq!(
            client.get_shares(&user),
            shares_before,
            "user shares must survive migration"
        );
        // INVARIANT: vault-wide accounting is unchanged
        assert_eq!(
            client.total_assets(),
            assets_before,
            "total_assets must survive migration"
        );
        assert_eq!(
            client.total_shares(),
            total_shares_before,
            "total_shares must survive migration"
        );
        assert_eq!(client.storage_version(), 1);
    }

    // ══════════════════════════════════════════════════════════════════
    // 3. Edge case — already-at-version guard (idempotency)
    // ══════════════════════════════════════════════════════════════════

    /// Calling migrate() when already at the target version must return the
    /// typed `AlreadyMigrated` error and leave all storage unchanged.
    #[test]
    fn test_migrate_already_at_version_returns_typed_error() {
        let (_env, client, admin) = setup();

        // First migration succeeds
        client.migrate(&admin, &1);
        assert_eq!(client.storage_version(), 1);

        // Second call with the same target is a no-op and returns a stable error
        let result = client.try_migrate(&admin, &1);
        assert_eq!(
            result,
            Err(Ok(VaultError::AlreadyMigrated)),
            "second migrate must return AlreadyMigrated"
        );

        // Storage version must still be 1 — not changed by the failed call
        assert_eq!(client.storage_version(), 1);
    }

    // ══════════════════════════════════════════════════════════════════
    // 4. Edge case — downgrade attempt returns typed error
    // ══════════════════════════════════════════════════════════════════

    /// Attempting to migrate to a version *lower* than the current on-chain
    /// version must return the typed `StorageVersionMismatch` error and leave
    /// storage unchanged.
    #[test]
    fn test_migrate_downgrade_returns_typed_error() {
        let (_env, client, admin) = setup();

        client.migrate(&admin, &1);
        assert_eq!(client.storage_version(), 1);

        let result = client.try_migrate(&admin, &0);
        assert_eq!(
            result,
            Err(Ok(VaultError::StorageVersionMismatch)),
            "downgrade must return StorageVersionMismatch"
        );

        // Version must remain at 1
        assert_eq!(client.storage_version(), 1);
    }

    // ══════════════════════════════════════════════════════════════════
    // 5. Edge case — unauthorized caller is rejected
    // ══════════════════════════════════════════════════════════════════

    /// An unprivileged caller must receive `Unauthorized` and must not be
    /// able to advance the storage version.
    #[test]
    fn test_migrate_unauthorized_caller_rejected() {
        let (env, client, _admin) = setup();

        let attacker = Address::generate(&env);

        let result = client.try_migrate(&attacker, &1);
        assert_eq!(
            result,
            Err(Ok(VaultError::Unauthorized)),
            "non-admin migrate must return Unauthorized"
        );

        // Storage version must still be 0 — attacker had no effect
        assert_eq!(
            client.storage_version(),
            0,
            "storage version must not advance on unauthorized call"
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 6. LiquidityDepthLimit gets safe default when previously absent
    // ══════════════════════════════════════════════════════════════════

    /// After migrating a vault that never had `LiquidityDepthLimit` set,
    /// the key must exist with value 0 (unlimited).
    #[test]
    fn test_migrate_v0_to_v1_sets_liquidity_depth_default() {
        let (_env, client, admin) = setup();

        // Before migration the view returns 0 (default from unwrap_or)
        assert_eq!(client.get_liquidity_depth_limit(), 0);

        client.migrate(&admin, &1);

        // After migration the key is explicitly present with value 0 (unlimited)
        assert_eq!(
            client.get_liquidity_depth_limit(),
            0,
            "LiquidityDepthLimit must be 0 (unlimited) after v0->v1 migration"
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 7. LiquidityDepthLimit pre-existing custom value is NOT clobbered
    // ══════════════════════════════════════════════════════════════════

    /// If the admin set a non-zero limit before migration, the migration must
    /// NOT overwrite it with the default 0.
    #[test]
    fn test_migrate_v0_to_v1_preserves_existing_liquidity_depth_limit() {
        let (_env, client, admin) = setup();

        client.set_liquidity_depth_limit(&admin, &500_000);
        assert_eq!(client.get_liquidity_depth_limit(), 500_000);

        client.migrate(&admin, &1);

        assert_eq!(
            client.get_liquidity_depth_limit(),
            500_000,
            "pre-existing LiquidityDepthLimit must not be overwritten by migration"
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 8. Core vault operations remain functional after migration
    // ══════════════════════════════════════════════════════════════════

    /// After a successful migration, deposit / withdraw / rebalance must
    /// continue to work, guarding against accidental corruption of
    /// operational storage keys during migration.
    #[test]
    fn test_vault_operations_work_after_migration() {
        let (env, client, admin) = setup();

        let token_addr = client.get_token();
        let user = Address::generate(&env);
        soroban_sdk::token::StellarAssetClient::new(&env, &token_addr).mint(&user, &10_000);

        // Deposit before migration
        client.deposit(&user, &3_000, &3_000);

        // Migrate
        client.migrate(&admin, &1);
        assert_eq!(client.storage_version(), 1);

        // Deposit after migration
        let shares = client.deposit(&user, &2_000, &2_000);
        assert!(shares > 0, "deposit must succeed post-migration");

        // Withdraw after migration
        let user_shares = client.get_shares(&user);
        let withdrawn = client.withdraw(&user, &user_shares);
        assert!(withdrawn > 0, "withdraw must succeed post-migration");

        // Rebalance after migration
        let pool = Address::generate(&env);
        soroban_sdk::token::StellarAssetClient::new(&env, &token_addr).mint(&user, &5_000);
        client.deposit(&user, &5_000, &5_000);
        client.rebalance(&admin, &pool, &1_000);
        assert_eq!(client.total_assets(), 4_000);
    }

    // ══════════════════════════════════════════════════════════════════
    // 9. Uninitialized vault rejects migration
    // ══════════════════════════════════════════════════════════════════

    /// Calling migrate() on an uninitialized vault must return
    /// `NotInitialized` — not panic or corrupt storage.
    #[test]
    fn test_migrate_on_uninitialized_vault_returns_typed_error() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(YieldVault, ());
        let client = YieldVaultClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        // Vault has NOT been initialized
        let result = client.try_migrate(&admin, &1);
        assert_eq!(
            result,
            Err(Ok(VaultError::NotInitialized)),
            "migrate on uninitialized vault must return NotInitialized"
        );
    }
}
