#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contractmeta, contracttype, panic_with_error,
    symbol_short, token, Address, Env, Symbol, Vec,
};

// Metadata
contractmeta!(key = "name", val = "Emission Controller - PID & Epochs");
contractmeta!(key = "version", val = "0.2.0");
contractmeta!(
    key = "description",
    val = "PID algorithmic gauge with scheduled epoch minting, recipient snapshots, and cumulative caps."
);

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error {
    NotAdmin = 1,
    AlreadyInitialized = 2,
    NotInitialized = 3,
    InvalidParam = 4,
    OutsideActiveEpoch = 5,
    EpochMintCapExceeded = 6,
    LifetimeCapExceeded = 7,
    EpochNotFound = 8,
    InvalidSchedule = 9,
    ZeroAmount = 10,
    InvalidWeight = 11,
    NoRecipientsConfigured = 12,
}

/// A scheduled emission epoch with boundary timestamps and mint limits (#1496).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Epoch {
    pub epoch_id: u64,
    pub start_time: u64,
    pub end_time: u64,
    pub max_emission: i128,
    pub minted_emission: i128,
}

/// Recipient configuration and weight allocation in basis points (100 bps = 1%) (#1498).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecipientWeight {
    pub recipient: Address,
    pub weight_bps: u32,
}

/// Historical audit snapshot of recipient weights used at a specific mint (#1498).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllocationSnapshot {
    pub epoch_id: u64,
    pub mint_index: u32,
    pub timestamp: u64,
    pub amount: i128,
    pub recipients: Vec<RecipientWeight>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    Epoch(u64),
    EpochMintCount(u64),
    Snapshot(u64, u32), // (epoch_id, mint_index)
    RecipientWeights,
    LifetimeCap,
    LifetimeMinted,
    Token,
}

// Storage keys
const KEY_INIT: Symbol = symbol_short!("INIT");
const KEY_ADMIN: Symbol = symbol_short!("ADMIN");
const KEY_KP_BPS: Symbol = symbol_short!("KPB");
const KEY_KI_BPS: Symbol = symbol_short!("KIB");
const KEY_KD_BPS: Symbol = symbol_short!("KDB");
const KEY_TARGET_BPS: Symbol = symbol_short!("TGTB"); // target utilization in bps (0..=10_000)
const KEY_INT_ACCUM: Symbol = symbol_short!("IACC"); // integral accumulator (scaled by 1e7)
const KEY_LAST_ERROR: Symbol = symbol_short!("LERR"); // last error (scaled by 1e7)
const KEY_LAST_EMISSION: Symbol = symbol_short!("LEMI"); // last emission result
const KEY_MIN_EMIT: Symbol = symbol_short!("MIN"); // lower bound emission
const KEY_MAX_EMIT: Symbol = symbol_short!("MAX"); // upper bound emission

// Helpers
fn read_bool(env: &Env, k: &Symbol) -> bool {
    env.storage().instance().get::<_, bool>(k).unwrap_or(false)
}
fn write_bool(env: &Env, k: &Symbol, v: bool) {
    env.storage().instance().set(k, &v);
}
fn read_i128(env: &Env, k: &Symbol) -> i128 {
    env.storage().instance().get::<_, i128>(k).unwrap_or(0)
}
fn write_i128(env: &Env, k: &Symbol, v: i128) {
    env.storage().instance().set(k, &v);
}
fn read_u32(env: &Env, k: &Symbol) -> u32 {
    env.storage().instance().get::<_, u32>(k).unwrap_or(0)
}
fn write_u32(env: &Env, k: &Symbol, v: u32) {
    env.storage().instance().set(k, &v);
}
fn read_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get::<_, Address>(&KEY_ADMIN)
        .expect("admin")
}
fn write_admin(env: &Env, a: &Address) {
    env.storage().instance().set(&KEY_ADMIN, a);
}
fn ensure_init(env: &Env) {
    if !read_bool(env, &KEY_INIT) {
        panic_with_error!(env, Error::NotInitialized);
    }
}
fn ensure_admin(env: &Env, who: &Address) {
    if &read_admin(env) != who {
        panic_with_error!(env, Error::NotAdmin)
    }
}

fn read_lifetime_cap(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::LifetimeCap)
        .unwrap_or(0)
}
fn write_lifetime_cap(env: &Env, cap: i128) {
    env.storage().instance().set(&DataKey::LifetimeCap, &cap);
}
fn read_lifetime_minted(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::LifetimeMinted)
        .unwrap_or(0)
}
fn write_lifetime_minted(env: &Env, minted: i128) {
    env.storage()
        .instance()
        .set(&DataKey::LifetimeMinted, &minted);
}

fn clamp(value: i128, lo: i128, hi: i128) -> i128 {
    if value < lo {
        lo
    } else if value > hi {
        hi
    } else {
        value
    }
}

// Scaling conventions:
// - Utilization input and target in basis points: 0..=10_000
// - Internal error represented in fixed-point 1e7 (stroop-like) to preserve precision
// - Gains Kp, Ki, Kd given in basis points relative to error (bps * error_scaled / 10_000)
// - Emission result is an i128 representing "units per day" (free unit), bounded by [min_emission, max_emission]
const SCALE: i128 = 10_000_000; // 1e7

#[contract]
pub struct EmissionController;

#[allow(clippy::too_many_arguments)]
#[contractimpl]
impl EmissionController {
    /// Initialize the PID controller parameters.
    ///
    /// - `admin`: access control address.
    /// - `target_utilization_bps`: desired utilization in [0, 10_000].
    /// - `kp_bps`, `ki_bps`, `kd_bps`: PID gains in basis points.
    /// - `min_emission`, `max_emission`: emission bounds (must satisfy min <= max).
    pub fn init(
        env: Env,
        admin: Address,
        target_utilization_bps: u32,
        kp_bps: u32,
        ki_bps: u32,
        kd_bps: u32,
        min_emission: i128,
        max_emission: i128,
    ) {
        if read_bool(&env, &KEY_INIT) {
            panic_with_error!(&env, Error::AlreadyInitialized)
        }
        if target_utilization_bps > 10_000 {
            panic_with_error!(&env, Error::InvalidParam)
        }
        if min_emission > max_emission {
            panic_with_error!(&env, Error::InvalidParam)
        }
        admin.require_auth();

        write_admin(&env, &admin);
        write_u32(&env, &KEY_TARGET_BPS, target_utilization_bps);
        write_u32(&env, &KEY_KP_BPS, kp_bps);
        write_u32(&env, &KEY_KI_BPS, ki_bps);
        write_u32(&env, &KEY_KD_BPS, kd_bps);
        write_i128(&env, &KEY_MIN_EMIT, min_emission);
        write_i128(&env, &KEY_MAX_EMIT, max_emission);
        write_i128(&env, &KEY_INT_ACCUM, 0);
        write_i128(&env, &KEY_LAST_ERROR, 0);
        write_i128(&env, &KEY_LAST_EMISSION, min_emission);
        write_bool(&env, &KEY_INIT, true);
    }

    /// Update PID gains and/or target utilization. Admin only.
    pub fn configure(
        env: Env,
        admin: Address,
        target_bps: u32,
        kp_bps: u32,
        ki_bps: u32,
        kd_bps: u32,
    ) {
        ensure_init(&env);
        ensure_admin(&env, &admin);
        admin.require_auth();
        if target_bps > 10_000 {
            panic_with_error!(&env, Error::InvalidParam)
        }
        write_u32(&env, &KEY_TARGET_BPS, target_bps);
        write_u32(&env, &KEY_KP_BPS, kp_bps);
        write_u32(&env, &KEY_KI_BPS, ki_bps);
        write_u32(&env, &KEY_KD_BPS, kd_bps);
    }

    /// Update emission bounds. Admin only.
    pub fn set_bounds(env: Env, admin: Address, min_emission: i128, max_emission: i128) {
        ensure_init(&env);
        ensure_admin(&env, &admin);
        admin.require_auth();
        if min_emission > max_emission {
            panic_with_error!(&env, Error::InvalidParam)
        }
        write_i128(&env, &KEY_MIN_EMIT, min_emission);
        write_i128(&env, &KEY_MAX_EMIT, max_emission);
    }

    /// Compute next daily emission using PID given current `utilization_bps` (0..=10_000).
    ///
    /// Returns the clamped emission value. Maintains internal integral and last-error states.
    pub fn compute_emission(env: Env, utilization_bps: u32) -> i128 {
        ensure_init(&env);
        if utilization_bps > 10_000 {
            panic_with_error!(&env, Error::InvalidParam)
        }

        let target_bps = read_u32(&env, &KEY_TARGET_BPS) as i128;
        let util_bps = utilization_bps as i128;

        // error = target - measured (scale to 1e7)
        let error_scaled = (target_bps - util_bps) * SCALE / 10_000;

        // integral = integral + error_scaled
        let mut i_accum = read_i128(&env, &KEY_INT_ACCUM);
        i_accum += error_scaled;

        // derivative = error_scaled - last_error
        let last_error = read_i128(&env, &KEY_LAST_ERROR);
        let deriv = error_scaled - last_error;

        // Gains
        let kp_bps = read_u32(&env, &KEY_KP_BPS) as i128;
        let ki_bps = read_u32(&env, &KEY_KI_BPS) as i128;
        let kd_bps = read_u32(&env, &KEY_KD_BPS) as i128;

        // PID output (scaled emission delta). Combine then downscale.
        // delta = kp*e + ki*I + kd*D   where each gain is in bps.
        let p_term = kp_bps * error_scaled;
        let i_term = ki_bps * i_accum;
        let d_term = kd_bps * deriv;
        // Choose a controller divisor to convert from (bps * SCALE) units to emission units.
        const PID_SCALE_DIV: i128 = 1_000; // tuning knob so integer arithmetic yields non-zero deltas
        let delta_units = (p_term + i_term + d_term) / (10_000 * PID_SCALE_DIV);

        // Apply to last emission
        let last_emission = read_i128(&env, &KEY_LAST_EMISSION);
        let mut next_emission = last_emission + delta_units;

        // Clamp to bounds
        let lo = read_i128(&env, &KEY_MIN_EMIT);
        let hi = read_i128(&env, &KEY_MAX_EMIT);
        next_emission = clamp(next_emission, lo, hi);

        // Anti-windup: if clamped, limit integrator by undoing the last i_term contribution
        // Simple approach: if clamping occurred (delta would push out of bounds), lightly damp integral
        if next_emission == lo || next_emission == hi {
            // decay integrator by 1% to avoid runaway
            i_accum = i_accum - (i_accum / 100);
        }

        // Persist state
        write_i128(&env, &KEY_INT_ACCUM, i_accum);
        write_i128(&env, &KEY_LAST_ERROR, error_scaled);
        write_i128(&env, &KEY_LAST_EMISSION, next_emission);

        next_emission
    }

    // Views
    pub fn params(env: Env) -> (u32, u32, u32, u32, i128, i128) {
        (
            read_u32(&env, &KEY_TARGET_BPS),
            read_u32(&env, &KEY_KP_BPS),
            read_u32(&env, &KEY_KI_BPS),
            read_u32(&env, &KEY_KD_BPS),
            read_i128(&env, &KEY_MIN_EMIT),
            read_i128(&env, &KEY_MAX_EMIT),
        )
    }
    pub fn state(env: Env) -> (i128, i128, i128) {
        (
            read_i128(&env, &KEY_INT_ACCUM),
            read_i128(&env, &KEY_LAST_ERROR),
            read_i128(&env, &KEY_LAST_EMISSION),
        )
    }

    // ── Epoch Scheduling & Cumulative Cap Management (#1496, #1497) ──

    /// Configure or replace the emission schedule.
    ///
    /// Prevents schedule changes from raising lifetime planned emissions above `lifetime_cap` (#1497).
    /// Preserves already minted historical supply across schedule updates.
    pub fn set_schedule(
        env: Env,
        admin: Address,
        lifetime_cap: i128,
        epochs: Vec<Epoch>,
    ) -> Result<(), Error> {
        ensure_init(&env);
        ensure_admin(&env, &admin);
        admin.require_auth();

        let current_lifetime_minted = read_lifetime_minted(&env);
        if lifetime_cap < current_lifetime_minted {
            return Err(Error::LifetimeCapExceeded);
        }

        // Validate each epoch and calculate total planned unminted supply
        let mut total_planned_unminted: i128 = 0;
        for epoch in epochs.iter() {
            if epoch.start_time >= epoch.end_time || epoch.max_emission < 0 {
                return Err(Error::InvalidSchedule);
            }

            // Check if epoch previously existed with minted supply
            let existing_minted = if let Some(existing) = env
                .storage()
                .persistent()
                .get::<_, Epoch>(&DataKey::Epoch(epoch.epoch_id))
            {
                if epoch.max_emission < existing.minted_emission {
                    return Err(Error::InvalidSchedule);
                }
                existing.minted_emission
            } else {
                0
            };

            let remaining_in_epoch = epoch
                .max_emission
                .checked_sub(existing_minted)
                .ok_or(Error::InvalidParam)?;

            total_planned_unminted = total_planned_unminted
                .checked_add(remaining_in_epoch)
                .ok_or(Error::InvalidParam)?;
        }

        // Cumulative check across schedule updates (#1497)
        let total_projected = current_lifetime_minted
            .checked_add(total_planned_unminted)
            .ok_or(Error::InvalidParam)?;

        if total_projected > lifetime_cap {
            return Err(Error::LifetimeCapExceeded);
        }

        // Persist lifetime cap and epochs
        write_lifetime_cap(&env, lifetime_cap);
        for epoch in epochs.iter() {
            let existing_minted = env
                .storage()
                .persistent()
                .get::<_, Epoch>(&DataKey::Epoch(epoch.epoch_id))
                .map(|e| e.minted_emission)
                .unwrap_or(0);

            let mut stored_epoch = epoch.clone();
            stored_epoch.minted_emission = existing_minted;
            env.storage()
                .persistent()
                .set(&DataKey::Epoch(epoch.epoch_id), &stored_epoch);
        }

        env.events().publish(
            (symbol_short!("sched_up"),),
            (lifetime_cap, total_projected),
        );
        Ok(())
    }

    /// Configure recipient weights for subsequent mints (#1498).
    /// Weights must sum to 10,000 basis points (100%).
    pub fn set_recipient_weights(
        env: Env,
        admin: Address,
        recipients: Vec<RecipientWeight>,
    ) -> Result<(), Error> {
        ensure_init(&env);
        ensure_admin(&env, &admin);
        admin.require_auth();

        if recipients.is_empty() {
            return Err(Error::InvalidParam);
        }

        let mut total_bps: u32 = 0;
        for r in recipients.iter() {
            if r.weight_bps == 0 {
                return Err(Error::InvalidWeight);
            }
            total_bps = total_bps
                .checked_add(r.weight_bps)
                .ok_or(Error::InvalidWeight)?;
        }

        if total_bps != 10_000 {
            return Err(Error::InvalidWeight);
        }

        env.storage()
            .instance()
            .set(&DataKey::RecipientWeights, &recipients);
        Ok(())
    }

    /// Set optional reward token address for automated minting.
    pub fn set_token(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        ensure_init(&env);
        ensure_admin(&env, &admin);
        admin.require_auth();

        env.storage().instance().set(&DataKey::Token, &token);
        Ok(())
    }

    /// Mint emission within an active scheduled epoch (#1496, #1497, #1498).
    ///
    /// 1. Rejects minting outside an active epoch ([start_time, end_time)).
    /// 2. Accounts for already minted supply in the epoch (reverts if exceeded).
    /// 3. Enforces cumulative lifetime emission cap.
    /// 4. Stores recipient allocation snapshot for auditability.
    pub fn mint_epoch_emission(
        env: Env,
        admin: Address,
        epoch_id: u64,
        amount: i128,
    ) -> Result<AllocationSnapshot, Error> {
        ensure_init(&env);
        ensure_admin(&env, &admin);
        admin.require_auth();

        if amount <= 0 {
            return Err(Error::ZeroAmount);
        }

        let mut epoch: Epoch = env
            .storage()
            .persistent()
            .get(&DataKey::Epoch(epoch_id))
            .ok_or(Error::EpochNotFound)?;

        let now = env.ledger().timestamp();
        if now < epoch.start_time || now >= epoch.end_time {
            return Err(Error::OutsideActiveEpoch);
        }

        // Check epoch mint cap (#1496)
        let new_epoch_minted = epoch
            .minted_emission
            .checked_add(amount)
            .ok_or(Error::InvalidParam)?;
        if new_epoch_minted > epoch.max_emission {
            return Err(Error::EpochMintCapExceeded);
        }

        // Check cumulative lifetime cap (#1497)
        let cap = read_lifetime_cap(&env);
        let current_lifetime_minted = read_lifetime_minted(&env);
        let new_lifetime_minted = current_lifetime_minted
            .checked_add(amount)
            .ok_or(Error::InvalidParam)?;
        if cap > 0 && new_lifetime_minted > cap {
            return Err(Error::LifetimeCapExceeded);
        }

        let recipients: Vec<RecipientWeight> = env
            .storage()
            .instance()
            .get(&DataKey::RecipientWeights)
            .ok_or(Error::NoRecipientsConfigured)?;

        // Update state
        epoch.minted_emission = new_epoch_minted;
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(epoch_id), &epoch);
        write_lifetime_minted(&env, new_lifetime_minted);

        // Record historical recipient allocation snapshot (#1498)
        let mint_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::EpochMintCount(epoch_id))
            .unwrap_or(0);

        let snapshot = AllocationSnapshot {
            epoch_id,
            mint_index: mint_count,
            timestamp: now,
            amount,
            recipients: recipients.clone(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Snapshot(epoch_id, mint_count), &snapshot);
        env.storage()
            .persistent()
            .set(&DataKey::EpochMintCount(epoch_id), &(mint_count + 1));

        // Optionally mint tokens if token address is set
        if let Some(token_addr) = env.storage().instance().get::<_, Address>(&DataKey::Token) {
            let token_client = token::StellarAssetClient::new(&env, &token_addr);
            for r in recipients.iter() {
                let share = amount * (r.weight_bps as i128) / 10_000;
                if share > 0 {
                    token_client.mint(&r.recipient, &share);
                }
            }
        }

        env.events().publish(
            (symbol_short!("mint_ep"), epoch_id),
            (amount, new_epoch_minted, new_lifetime_minted),
        );

        Ok(snapshot)
    }

    pub fn get_epoch(env: Env, epoch_id: u64) -> Result<Epoch, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Epoch(epoch_id))
            .ok_or(Error::EpochNotFound)
    }

    pub fn get_lifetime_cap(env: Env) -> i128 {
        read_lifetime_cap(&env)
    }

    pub fn get_lifetime_minted(env: Env) -> i128 {
        read_lifetime_minted(&env)
    }

    pub fn get_allocation_snapshot(
        env: Env,
        epoch_id: u64,
        mint_index: u32,
    ) -> Result<AllocationSnapshot, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Snapshot(epoch_id, mint_index))
            .ok_or(Error::InvalidParam)
    }

    pub fn get_mint_count(env: Env, epoch_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::EpochMintCount(epoch_id))
            .unwrap_or(0)
    }

    pub fn get_recipient_weights(env: Env) -> Result<Vec<RecipientWeight>, Error> {
        env.storage()
            .instance()
            .get(&DataKey::RecipientWeights)
            .ok_or(Error::NoRecipientsConfigured)
    }

    pub fn get_token(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Token)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    #[test]
    fn init_and_params() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let cid = env.register(EmissionController, ());
        let c = EmissionControllerClient::new(&env, &cid);

        c.init(&admin, &7_500, &500, &50, &100, &0, &1_000_000);
        let (t, kp, ki, kd, lo, hi) = c.params();
        assert_eq!(t, 7_500);
        assert_eq!(kp, 500);
        assert_eq!(ki, 50);
        assert_eq!(kd, 100);
        assert_eq!(lo, 0);
        assert_eq!(hi, 1_000_000);
    }

    #[test]
    fn pid_converges_towards_target() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let cid = env.register(EmissionController, ());
        let c = EmissionControllerClient::new(&env, &cid);

        // Target 70% utilization, moderate gains, emission bounds [0, 1_000_000]
        c.init(&admin, &7_000, &400, &30, &80, &0, &1_000_000);

        // Start far below target utilization and see emissions rise then stabilize
        let util_series = [
            2_000u32, 3_000, 4_000, 5_000, 6_000, 6_500, 6_800, 6_900, 7_000, 7_100, 7_000,
        ];
        for u in util_series.iter() {
            let last = c.compute_emission(u);
            let (_i, _e, le) = c.state();
            assert_eq!(le, last);
            // should remain within bounds
            assert!((0..=1_000_000).contains(&last));
        }
        // Small deviation around target should avoid extreme swings
        let e1 = c.compute_emission(&6_900);
        let e2 = c.compute_emission(&7_050);
        let diff = (e2 - e1).abs();
        assert!(diff < 200_000); // stability heuristic for test purposes
    }

    #[test]
    fn clamps_and_anti_windup() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let cid = env.register(EmissionController, ());
        let c = EmissionControllerClient::new(&env, &cid);

        c.init(&admin, &9_500, &1_000, &500, &500, &10, &100);

        // Very low utilization vs high target -> will try to increase emission, but clamps at 100
        for _ in 0..10 {
            let out = c.compute_emission(&1_000);
            assert_eq!(out, 100);
        }
        // Now set high utilization -> should reduce quickly, not below 10
        for _ in 0..10 {
            let out = c.compute_emission(&10_000);
            assert!(out >= 10);
        }
    }

    // ── #1496 Epoch Boundaries & Accounting Tests ─────────────────────────

    #[test]
    fn test_epoch_boundary_and_mint_accounting() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let cid = env.register(EmissionController, ());
        let c = EmissionControllerClient::new(&env, &cid);

        c.init(&admin, &7_500, &500, &50, &100, &0, &1_000_000);

        // Epoch 1: [100, 200) with max emission 10,000
        let epoch1 = Epoch {
            epoch_id: 1,
            start_time: 100,
            end_time: 200,
            max_emission: 10_000,
            minted_emission: 0,
        };

        let mut epochs = Vec::new(&env);
        epochs.push_back(epoch1);
        c.set_schedule(&admin, &50_000, &epochs);

        // Configure recipient
        let r1 = Address::generate(&env);
        let mut recipients = Vec::new(&env);
        recipients.push_back(RecipientWeight {
            recipient: r1.clone(),
            weight_bps: 10_000,
        });
        c.set_recipient_weights(&admin, &recipients);

        // 1. Before epoch start (t = 99) -> rejected
        env.ledger().set_timestamp(99);
        let before_res = c.try_mint_epoch_emission(&admin, &1, &1_000);
        assert_eq!(before_res, Err(Ok(Error::OutsideActiveEpoch)));

        // 2. Exactly at start_time (t = 100) -> success
        env.ledger().set_timestamp(100);
        let snap1 = c.mint_epoch_emission(&admin, &1, &4_000);
        assert_eq!(snap1.amount, 4_000);
        assert_eq!(snap1.epoch_id, 1);
        assert_eq!(snap1.mint_index, 0);

        let ep_state1 = c.get_epoch(&1);
        assert_eq!(ep_state1.minted_emission, 4_000);
        assert_eq!(c.get_lifetime_minted(), 4_000);

        // 3. Repeated call within epoch (t = 150) -> accounts for already minted supply
        env.ledger().set_timestamp(150);
        let snap2 = c.mint_epoch_emission(&admin, &1, &4_000);
        assert_eq!(snap2.amount, 4_000);
        assert_eq!(snap2.mint_index, 1);

        let ep_state2 = c.get_epoch(&1);
        assert_eq!(ep_state2.minted_emission, 8_000);
        assert_eq!(c.get_lifetime_minted(), 8_000);

        // 4. Exceeding remaining epoch cap (8_000 + 3_000 = 11_000 > 10_000) -> rejected
        let over_res = c.try_mint_epoch_emission(&admin, &1, &3_000);
        assert_eq!(over_res, Err(Ok(Error::EpochMintCapExceeded)));

        // 5. Mint exact remaining 2,000 -> succeeds, epoch fully exhausted
        let snap3 = c.mint_epoch_emission(&admin, &1, &2_000);
        assert_eq!(snap3.amount, 2_000);
        assert_eq!(c.get_epoch(&1).minted_emission, 10_000);

        // 6. Any further mint in exhausted epoch -> rejected
        let exhausted_res = c.try_mint_epoch_emission(&admin, &1, &1);
        assert_eq!(exhausted_res, Err(Ok(Error::EpochMintCapExceeded)));

        // 7. At or after end_time (t = 200) -> rejected
        env.ledger().set_timestamp(200);
        let after_res = c.try_mint_epoch_emission(&admin, &1, &1);
        assert_eq!(after_res, Err(Ok(Error::OutsideActiveEpoch)));
    }

    // ── #1498 Recipient Allocation Snapshot Tests ─────────────────────────

    #[test]
    fn test_recipient_allocation_snapshots_across_epochs() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let cid = env.register(EmissionController, ());
        let c = EmissionControllerClient::new(&env, &cid);

        c.init(&admin, &7_500, &500, &50, &100, &0, &1_000_000);

        let epoch1 = Epoch {
            epoch_id: 1,
            start_time: 100,
            end_time: 200,
            max_emission: 10_000,
            minted_emission: 0,
        };
        let epoch2 = Epoch {
            epoch_id: 2,
            start_time: 200,
            end_time: 300,
            max_emission: 10_000,
            minted_emission: 0,
        };

        let mut epochs = Vec::new(&env);
        epochs.push_back(epoch1);
        epochs.push_back(epoch2);
        c.set_schedule(&admin, &50_000, &epochs);

        let rec_a = Address::generate(&env);
        let rec_b = Address::generate(&env);

        // Epoch 1: 60% to A, 40% to B
        let mut weights_ep1 = Vec::new(&env);
        weights_ep1.push_back(RecipientWeight {
            recipient: rec_a.clone(),
            weight_bps: 6_000,
        });
        weights_ep1.push_back(RecipientWeight {
            recipient: rec_b.clone(),
            weight_bps: 4_000,
        });
        c.set_recipient_weights(&admin, &weights_ep1);

        env.ledger().set_timestamp(120);
        let snap_ep1 = c.mint_epoch_emission(&admin, &1, &5_000);
        assert_eq!(snap_ep1.amount, 5_000);
        assert_eq!(snap_ep1.recipients.len(), 2);
        assert_eq!(snap_ep1.recipients.get(0).unwrap().weight_bps, 6_000);
        assert_eq!(snap_ep1.recipients.get(1).unwrap().weight_bps, 4_000);

        // Update weights for Epoch 2: 25% to A, 75% to B (#1498: weight changes between epochs)
        let mut weights_ep2 = Vec::new(&env);
        weights_ep2.push_back(RecipientWeight {
            recipient: rec_a.clone(),
            weight_bps: 2_500,
        });
        weights_ep2.push_back(RecipientWeight {
            recipient: rec_b.clone(),
            weight_bps: 7_500,
        });
        c.set_recipient_weights(&admin, &weights_ep2);

        env.ledger().set_timestamp(250);
        let snap_ep2 = c.mint_epoch_emission(&admin, &2, &8_000);
        assert_eq!(snap_ep2.amount, 8_000);
        assert_eq!(snap_ep2.recipients.len(), 2);
        assert_eq!(snap_ep2.recipients.get(0).unwrap().weight_bps, 2_500);
        assert_eq!(snap_ep2.recipients.get(1).unwrap().weight_bps, 7_500);

        // Historical Auditability Verification:
        // Query historical snapshot 0 for epoch 1 -> must remain intact with original 60/40 weights
        let audit_ep1 = c.get_allocation_snapshot(&1, &0);
        assert_eq!(audit_ep1.amount, 5_000);
        assert_eq!(audit_ep1.recipients.get(0).unwrap().weight_bps, 6_000);
        assert_eq!(audit_ep1.recipients.get(1).unwrap().weight_bps, 4_000);

        // Query historical snapshot 0 for epoch 2 -> reflects 25/75 weights
        let audit_ep2 = c.get_allocation_snapshot(&2, &0);
        assert_eq!(audit_ep2.amount, 8_000);
        assert_eq!(audit_ep2.recipients.get(0).unwrap().weight_bps, 2_500);
        assert_eq!(audit_ep2.recipients.get(1).unwrap().weight_bps, 7_500);
    }

    // ── #1497 Cumulative Cap & Schedule Update Tests ──────────────────────

    #[test]
    fn test_lifetime_cap_across_schedule_updates_and_exhaustion() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let cid = env.register(EmissionController, ());
        let c = EmissionControllerClient::new(&env, &cid);

        c.init(&admin, &7_500, &500, &50, &100, &0, &1_000_000);

        // Lifetime cap of 20,000
        let epoch1 = Epoch {
            epoch_id: 1,
            start_time: 100,
            end_time: 200,
            max_emission: 10_000,
            minted_emission: 0,
        };
        let epoch2 = Epoch {
            epoch_id: 2,
            start_time: 200,
            end_time: 300,
            max_emission: 10_000,
            minted_emission: 0,
        };

        // 1. Setting schedule where planned (25,000) > cap (20,000) -> rejected
        let mut over_epochs = Vec::new(&env);
        over_epochs.push_back(epoch1.clone());
        over_epochs.push_back(Epoch {
            epoch_id: 2,
            start_time: 200,
            end_time: 300,
            max_emission: 15_000,
            minted_emission: 0,
        });
        let over_sched = c.try_set_schedule(&admin, &20_000, &over_epochs);
        assert_eq!(over_sched, Err(Ok(Error::LifetimeCapExceeded)));

        // 2. Set valid schedule: 10_000 + 10_000 <= 20_000
        let mut valid_epochs = Vec::new(&env);
        valid_epochs.push_back(epoch1.clone());
        valid_epochs.push_back(epoch2.clone());
        c.set_schedule(&admin, &20_000, &valid_epochs);
        assert_eq!(c.get_lifetime_cap(), 20_000);

        let r = Address::generate(&env);
        let mut recs = Vec::new(&env);
        recs.push_back(RecipientWeight {
            recipient: r.clone(),
            weight_bps: 10_000,
        });
        c.set_recipient_weights(&admin, &recs);

        // Mint all 10,000 of Epoch 1
        env.ledger().set_timestamp(150);
        c.mint_epoch_emission(&admin, &1, &10_000);
        assert_eq!(c.get_lifetime_minted(), 10_000);

        // 3. Attempt schedule replacement that reduces cap below already minted supply -> rejected
        let replace_err = c.try_set_schedule(&admin, &8_000, &valid_epochs);
        assert_eq!(replace_err, Err(Ok(Error::LifetimeCapExceeded)));

        // 4. Replace schedule: Replace Epoch 2 with two smaller epochs (Epoch 2: 6,000, Epoch 3: 4,000)
        // Total planned = 10_000 (minted in Ep 1) + 6_000 + 4_000 = 20_000 <= 20_000 -> succeeds!
        let mut replacement_epochs = Vec::new(&env);
        replacement_epochs.push_back(epoch1.clone());
        replacement_epochs.push_back(Epoch {
            epoch_id: 2,
            start_time: 200,
            end_time: 300,
            max_emission: 6_000,
            minted_emission: 0,
        });
        replacement_epochs.push_back(Epoch {
            epoch_id: 3,
            start_time: 300,
            end_time: 400,
            max_emission: 4_000,
            minted_emission: 0,
        });
        c.set_schedule(&admin, &20_000, &replacement_epochs);

        // Mint in Epoch 2
        env.ledger().set_timestamp(250);
        c.mint_epoch_emission(&admin, &2, &6_000);
        assert_eq!(c.get_lifetime_minted(), 16_000);

        // Mint remaining in Epoch 3 (4_000) -> reaches exact lifetime cap of 20,000
        env.ledger().set_timestamp(350);
        c.mint_epoch_emission(&admin, &3, &4_000);
        assert_eq!(c.get_lifetime_minted(), 20_000);

        // 5. Cap Exhaustion: Any further minting attempt is blocked by lifetime cap
        let exhausted = c.try_mint_epoch_emission(&admin, &3, &1);
        // Epoch 3 cap also exhausted; even if epoch allowed, lifetime cap blocks
        assert!(exhausted.is_err());
    }

    // ── Token Minting Integration Test ────────────────────────────────────

    #[test]
    fn test_token_minting_integration() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let cid = env.register(EmissionController, ());
        let c = EmissionControllerClient::new(&env, &cid);

        c.init(&admin, &7_500, &500, &50, &100, &0, &1_000_000);

        // Register SAC token with EmissionController as token admin
        let token_contract = env.register_stellar_asset_contract_v2(cid.clone());
        let token_addr = token_contract.address();
        c.set_token(&admin, &token_addr);
        assert_eq!(c.get_token(), Some(token_addr.clone()));

        let epoch = Epoch {
            epoch_id: 1,
            start_time: 100,
            end_time: 200,
            max_emission: 10_000,
            minted_emission: 0,
        };
        let mut epochs = Vec::new(&env);
        epochs.push_back(epoch);
        c.set_schedule(&admin, &50_000, &epochs);

        let rec_a = Address::generate(&env);
        let rec_b = Address::generate(&env);
        let mut weights = Vec::new(&env);
        weights.push_back(RecipientWeight {
            recipient: rec_a.clone(),
            weight_bps: 6_000,
        });
        weights.push_back(RecipientWeight {
            recipient: rec_b.clone(),
            weight_bps: 4_000,
        });
        c.set_recipient_weights(&admin, &weights);

        env.ledger().set_timestamp(150);
        c.mint_epoch_emission(&admin, &1, &10_000);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&rec_a), 6_000);
        assert_eq!(token_client.balance(&rec_b), 4_000);
    }
}
