use crate::{VaultError, YieldVault, YieldVaultArgs, YieldVaultClient};
use soroban_sdk::{contractimpl, contracttype, symbol_short, Address, Env, Vec};

/// Storage keys for the dynamic fee system.
#[contracttype]
pub enum FeeKey {
    /// Current performance fee in basis points.
    PerformanceFeeBps,
    /// Historical APY snapshots for the moving average (Vec<ApySnapshot>).
    ApyHistory,
    /// Minimum fee floor: 100 bps (1%).
    MinFeeBps,
    /// Maximum fee ceiling: 1000 bps (10%).
    MaxFeeBps,
    /// Total fees collected.
    TotalFeesCollected,
    /// Address that receives protocol performance fees.
    FeeRecipient,
}

/// A single APY data point used for computing the moving average.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ApySnapshot {
    /// APY in basis points (e.g. 1200 = 12%).
    pub apy_bps: i128,
    /// Ledger timestamp when recorded.
    pub timestamp: u64,
}

/// Basis points denominator.
const BPS_DENOMINATOR: i128 = 10_000;

/// Default minimum fee: 1% (100 bps).
const DEFAULT_MIN_FEE_BPS: i128 = 100;

/// Default maximum fee: 10% (1000 bps).
const DEFAULT_MAX_FEE_BPS: i128 = 1_000;

/// Number of APY snapshots to consider for moving average.
const MOVING_AVERAGE_WINDOW: u32 = 10;

#[contractimpl]
impl YieldVault {
    /// Record a new APY observation and recalculate the dynamic fee.
    /// Callable by admin.
    ///
    /// # Arguments
    /// * `admin`           - The admin address authorizing the update.
    /// * `current_apy_bps` - The latest APY observation in basis points.
    ///
    /// # Returns
    /// The new performance fee in basis points.
    ///
    /// # Invariants
    /// 100 <= performance_fee_bps <= 1000
    ///
    /// # Rounding
    /// Moving average uses integer division (floor), which is acceptable
    /// because APY snapshots are in basis points (integer) and the average
    /// is used only for fee bracket selection, not for value transfer.
    pub fn record_apy_and_adjust_fee(
        env: Env,
        admin: Address,
        current_apy_bps: i128,
    ) -> Result<i128, VaultError> {
        Self::require_admin(&env, &admin)?;

        let now = env.ledger().timestamp();
        let snapshot = ApySnapshot {
            apy_bps: current_apy_bps,
            timestamp: now,
        };

        // Append to history, keeping only the last MOVING_AVERAGE_WINDOW entries
        let mut history: Vec<ApySnapshot> = env
            .storage()
            .instance()
            .get(&FeeKey::ApyHistory)
            .unwrap_or(Vec::new(&env));

        history.push_back(snapshot);

        while history.len() > MOVING_AVERAGE_WINDOW {
            history.pop_front();
        }

        env.storage().instance().set(&FeeKey::ApyHistory, &history);

        // Calculate moving average APY
        let moving_avg = Self::compute_moving_avg_apy(&history);

        // Derive fee: 10% of the moving average APY
        // Rounding: floor division (protocol-favorable for fee setting)
        let raw_fee = moving_avg / 10;

        // Clamp to bounds
        let min_fee = env
            .storage()
            .instance()
            .get(&FeeKey::MinFeeBps)
            .unwrap_or(DEFAULT_MIN_FEE_BPS);
        let max_fee = env
            .storage()
            .instance()
            .get(&FeeKey::MaxFeeBps)
            .unwrap_or(DEFAULT_MAX_FEE_BPS);

        let clamped_fee = if raw_fee < min_fee {
            min_fee
        } else if raw_fee > max_fee {
            max_fee
        } else {
            raw_fee
        };

        env.storage()
            .instance()
            .set(&FeeKey::PerformanceFeeBps, &clamped_fee);

        env.events().publish(
            (symbol_short!("fee_adj"),),
            (current_apy_bps, moving_avg, clamped_fee),
        );

        Ok(clamped_fee)
    }

    /// Set the min/max fee bounds. Admin-only.
    /// Min must be >= 100 bps (1%), max must be <= 1000 bps (10%).
    ///
    /// # Arguments
    /// * `admin` - Current admin address.
    /// * `min_bps` - Minimum fee in basis points.
    /// * `max_bps` - Maximum fee in basis points.
    pub fn set_fee_bounds(
        env: Env,
        admin: Address,
        min_bps: i128,
        max_bps: i128,
    ) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;

        if min_bps < DEFAULT_MIN_FEE_BPS || max_bps > DEFAULT_MAX_FEE_BPS || min_bps > max_bps {
            return Err(VaultError::ZeroAmount);
        }

        env.storage().instance().set(&FeeKey::MinFeeBps, &min_bps);
        env.storage().instance().set(&FeeKey::MaxFeeBps, &max_bps);

        env.events()
            .publish((symbol_short!("fee_bnd"),), (min_bps, max_bps));
        Ok(())
    }

    /// Apply the performance fee to a harvest yield amount.
    /// Returns a tuple of (net_amount, fee_amount).
    ///
    /// # Rounding Direction
    /// Fee calculation uses floor division: `fee = (gross_amount * fee_bps) / BPS_DENOMINATOR`.
    /// This rounds **down** the fee (user-favorable), meaning the protocol may
    /// receive slightly less than the exact proportional fee. The maximum
    /// rounding dust is 1 unit of the smallest token denomination per fee application.
    ///
    /// # Invariants
    /// - `net_amount + fee_amount == gross_amount` (exact, no dust lost)
    /// - `fee_amount <= (gross_amount * fee_bps) / BPS_DENOMINATOR`
    /// - `fee_amount >= 0`
    ///
    /// # Arguments
    /// * `gross_amount` - The total yield amount before fees.
    pub fn apply_performance_fee(env: &Env, gross_amount: i128) -> (i128, i128) {
        if gross_amount <= 0 {
            return (0, 0);
        }

        let fee_bps: i128 = env
            .storage()
            .instance()
            .get(&FeeKey::PerformanceFeeBps)
            .unwrap_or(DEFAULT_MIN_FEE_BPS);

        // Rounding: floor division for fee (user-favorable).
        // The subtraction `gross_amount - fee` is exact because both are i128.
        // Invariant: net + fee == gross_amount (guaranteed by construction).
        let fee = (gross_amount * fee_bps) / BPS_DENOMINATOR;
        let net = gross_amount - fee;

        (net, fee)
    }

    /// View: return the current performance fee in basis points.
    /// This fee is applied to harvest yields.
    pub fn get_performance_fee_bps(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&FeeKey::PerformanceFeeBps)
            .unwrap_or(DEFAULT_MIN_FEE_BPS)
    }

    /// View: return the APY history snapshots for performance fee calculation.
    pub fn get_apy_history(env: Env) -> Vec<ApySnapshot> {
        env.storage()
            .instance()
            .get(&FeeKey::ApyHistory)
            .unwrap_or(Vec::new(&env))
    }

    /// View: return the cumulative total of performance fees collected.
    pub fn get_total_fees_collected(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&FeeKey::TotalFeesCollected)
            .unwrap_or(0)
    }

    /// Update the address that receives protocol performance fees.
    ///
    /// Admin-only. Validates the recipient before writing storage so a rejected
    /// update leaves prior state unchanged (rollback-safe).
    ///
    /// # Errors
    /// * [`VaultError::Unauthorized`] — caller is not admin
    /// * [`VaultError::InvalidRecipient`] — recipient is the vault contract itself
    ///   (zero-equivalent / sink address for this contract)
    pub fn set_fee_recipient_impl(
        env: Env,
        admin: Address,
        new_recipient: Address,
    ) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;
        Self::require_init(&env)?;

        // Reject vault-self as fee recipient (zero-equivalent / malformed routing).
        if new_recipient == env.current_contract_address() {
            return Err(VaultError::InvalidRecipient);
        }

        let old_recipient: Address = env
            .storage()
            .instance()
            .get(&FeeKey::FeeRecipient)
            .unwrap_or_else(|| {
                // Default: admin until an explicit recipient is configured.
                env.storage()
                    .instance()
                    .get(&crate::DataKey::Admin)
                    .unwrap_or(admin.clone())
            });

        // All checks passed — write then emit (no intermediate mutable state).
        env.storage()
            .instance()
            .set(&FeeKey::FeeRecipient, &new_recipient);

        // Topics: fee_rcp; data: (old, new, executor)
        env.events().publish(
            (symbol_short!("fee_rcp"),),
            (old_recipient, new_recipient, admin),
        );

        Ok(())
    }

    /// View: current fee recipient. Defaults to admin when unset.
    pub fn get_fee_recipient_impl(env: Env) -> Result<Address, VaultError> {
        Self::require_init(&env)?;
        if let Some(recipient) = env.storage().instance().get(&FeeKey::FeeRecipient) {
            return Ok(recipient);
        }
        Self::get_storage_required(&env, &crate::DataKey::Admin)
    }

    /// Internal: compute the simple moving average of APY from history.
    ///
    /// # Rounding
    /// Uses floor division. Since APY snapshots are in basis points (integers),
    /// the rounding error is at most 1 bps per computation, which is negligible
    /// for fee bracket selection.
    fn compute_moving_avg_apy(history: &Vec<ApySnapshot>) -> i128 {
        if history.is_empty() {
            return 0;
        }

        let mut sum: i128 = 0;
        for snapshot in history.iter() {
            sum += snapshot.apy_bps;
        }

        // Floor division: acceptable for fee bracket selection
        sum / (history.len() as i128)
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

    fn apply_fee_in_contract(
        env: &Env,
        client: &YieldVaultClient<'static>,
        amount: i128,
    ) -> (i128, i128) {
        let contract_id = client.address.clone();
        env.as_contract(&contract_id, || {
            YieldVault::apply_performance_fee(env, amount)
        })
    }

    #[test]
    fn test_apply_performance_fee_rounding_dust() {
        let (env, client, admin, _, _) = setup_env();

        // Set a non-default fee: 123 bps (1.23%)
        client.record_apy_and_adjust_fee(&admin, &1230);
        // Override with set_fee_bounds to get exact 123 bps
        client.set_fee_bounds(&admin, &123, &123);

        // Test with amounts that produce rounding dust
        // 100 * 123 / 10000 = 1.23 -> floor = 1
        let (net, fee) = apply_fee_in_contract(&env, &client, 100);
        assert_eq!(fee, 1, "Fee should be floor(1.23) = 1");
        assert_eq!(net, 99, "Net should be 100 - 1 = 99");
        assert_eq!(net + fee, 100, "Invariant: net + fee == gross");

        // Test with larger amount: 10000 * 123 / 10000 = 123 (exact)
        let (net, fee) = apply_fee_in_contract(&env, &client, 10_000);
        assert_eq!(fee, 123, "Fee should be exact 123");
        assert_eq!(net, 9_877, "Net should be 10000 - 123 = 9877");
        assert_eq!(net + fee, 10_000, "Invariant: net + fee == gross");

        // Test with very small amount: 1 * 123 / 10000 = 0 (floor)
        let (net, fee) = apply_fee_in_contract(&env, &client, 1);
        assert_eq!(fee, 0, "Fee should be 0 for tiny amount");
        assert_eq!(net, 1, "Net should be 1");
        assert_eq!(net + fee, 1, "Invariant: net + fee == gross");
    }

    #[test]
    fn test_apply_performance_fee_zero_or_negative() {
        let (net, fee) = YieldVault::apply_performance_fee(&Env::default(), 0);
        assert_eq!(net, 0);
        assert_eq!(fee, 0);

        let (net, fee) = YieldVault::apply_performance_fee(&Env::default(), -100);
        assert_eq!(net, 0);
        assert_eq!(fee, 0);
    }

    #[test]
    fn test_apply_performance_fee_max_bps() {
        let (env, client, admin, _, _) = setup_env();
        // Set max fee: 1000 bps (10%)
        client.set_fee_bounds(&admin, &1000, &1000);
        client.record_apy_and_adjust_fee(&admin, &20_000);

        // 1000 * 1000 / 10000 = 100 (exact 10%)
        let (net, fee) = apply_fee_in_contract(&env, &client, 1000);
        assert_eq!(fee, 100);
        assert_eq!(net, 900);
        assert_eq!(net + fee, 1000);
    }

    #[test]
    fn test_apply_performance_fee_min_bps() {
        let (env, client, admin, _, _) = setup_env();
        // Set min fee: 100 bps (1%)
        client.set_fee_bounds(&admin, &100, &100);

        // 1000 * 100 / 10000 = 10 (exact 1%)
        let (net, fee) = apply_fee_in_contract(&env, &client, 1000);
        assert_eq!(fee, 10);
        assert_eq!(net, 990);
        assert_eq!(net + fee, 1000);
    }

    #[test]
    fn test_fee_rounding_dust_bound() {
        // Verify that rounding dust never exceeds 1 unit
        // For any gross_amount and fee_bps, the rounding error is at most 1
        let fee_bps = 123;
        let bps_denom = 10_000i128;

        for gross in [1, 2, 3, 7, 13, 99, 100, 101, 999, 1000, 9999, 10000, 10001] {
            let exact_fee = (gross * fee_bps) as f64 / bps_denom as f64;
            let actual_fee = (gross * fee_bps) / bps_denom;
            let rounding_error = exact_fee - actual_fee as f64;
            assert!(
                rounding_error >= 0.0 && rounding_error < 1.0,
                "Rounding error {} out of bounds for gross={}",
                rounding_error,
                gross
            );
        }
    }
}
