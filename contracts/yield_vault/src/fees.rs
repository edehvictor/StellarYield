use crate::{VaultError, YieldVault};
use soroban_sdk::{contracttype, symbol_short, Address, Env, Vec};

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

impl YieldVault {
    /// Record a new APY observation and recalculate the dynamic fee.
    /// Callable by admin. The fee adjusts based on a moving average of the
    /// vault's historical APY: higher yields allow a slightly higher fee,
    /// lower yields reduce the fee to remain competitive.
    ///
    /// Fee formula:
    ///   moving_avg_apy = average of last N APY snapshots
    ///   raw_fee = moving_avg_apy / 10 (10% of yield as fee)
    ///   clamped_fee = clamp(raw_fee, min_fee, max_fee)
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

    /// Internal: compute the simple moving average of APY from history.
    fn compute_moving_avg_apy(history: &Vec<ApySnapshot>) -> i128 {
        if history.is_empty() {
            return 0;
        }

        let mut sum: i128 = 0;
        for snapshot in history.iter() {
            sum += snapshot.apy_bps;
        }

        sum / (history.len() as i128)
    }
}
