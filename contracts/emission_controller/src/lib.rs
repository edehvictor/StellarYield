#![no_std]

use soroban_sdk::{
	Address, Env, Symbol, contract, contracterror, contractimpl, contractmeta, panic_with_error,
	symbol_short,
};

// Metadata
contractmeta!(key = "name", val = "Emission Controller - PID");
contractmeta!(key = "version", val = "0.1.0");
contractmeta!(key = "description", val = "PID-based algorithmic gauge to self-regulate token emissions.");

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Error {
	NotAdmin = 1,
	AlreadyInitialized = 2,
	NotInitialized = 3,
	InvalidParam = 4,
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
fn read_bool(env: &Env, k: &Symbol) -> bool { env.storage().instance().get::<_, bool>(k).unwrap_or(false) }
fn write_bool(env: &Env, k: &Symbol, v: bool) { env.storage().instance().set(k, &v); }
fn read_i128(env: &Env, k: &Symbol) -> i128 { env.storage().instance().get::<_, i128>(k).unwrap_or(0) }
fn write_i128(env: &Env, k: &Symbol, v: i128) { env.storage().instance().set(k, &v); }
fn read_u32(env: &Env, k: &Symbol) -> u32 { env.storage().instance().get::<_, u32>(k).unwrap_or(0) }
fn write_u32(env: &Env, k: &Symbol, v: u32) { env.storage().instance().set(k, &v); }
fn read_admin(env: &Env) -> Address { env.storage().instance().get::<_, Address>(&KEY_ADMIN).expect("admin") }
fn write_admin(env: &Env, a: &Address) { env.storage().instance().set(&KEY_ADMIN, a); }
fn ensure_init(env: &Env) { if !read_bool(env, &KEY_INIT) { panic_with_error!(env, Error::NotInitialized); } }
fn ensure_admin(env: &Env, who: &Address) { if &read_admin(env) != who { panic_with_error!(env, Error::NotAdmin) } }

fn clamp(value: i128, lo: i128, hi: i128) -> i128 {
	if value < lo { lo } else if value > hi { hi } else { value }
}

// Scaling conventions:
// - Utilization input and target in basis points: 0..=10_000
// - Internal error represented in fixed-point 1e7 (stroop-like) to preserve precision
// - Gains Kp, Ki, Kd given in basis points relative to error (bps * error_scaled / 10_000)
// - Emission result is an i128 representing "units per day" (free unit), bounded by [min_emission, max_emission]
const SCALE: i128 = 10_000_000; // 1e7

#[contract]
pub struct EmissionController;

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
		if read_bool(&env, &KEY_INIT) { panic_with_error!(&env, Error::AlreadyInitialized) }
		if target_utilization_bps > 10_000 { panic_with_error!(&env, Error::InvalidParam) }
		if min_emission > max_emission { panic_with_error!(&env, Error::InvalidParam) }
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
	pub fn configure(env: Env, admin: Address, target_bps: u32, kp_bps: u32, ki_bps: u32, kd_bps: u32) {
		ensure_init(&env);
		ensure_admin(&env, &admin);
		admin.require_auth();
		if target_bps > 10_000 { panic_with_error!(&env, Error::InvalidParam) }
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
		if min_emission > max_emission { panic_with_error!(&env, Error::InvalidParam) }
		write_i128(&env, &KEY_MIN_EMIT, min_emission);
		write_i128(&env, &KEY_MAX_EMIT, max_emission);
	}

	/// Compute next daily emission using PID given current `utilization_bps` (0..=10_000).
	///
	/// Returns the clamped emission value. Maintains internal integral and last-error states.
	pub fn compute_emission(env: Env, utilization_bps: u32) -> i128 {
		ensure_init(&env);
		if utilization_bps > 10_000 { panic_with_error!(&env, Error::InvalidParam) }

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
}

#[cfg(test)]
mod test {
	use super::*;
	use soroban_sdk::testutils::Address as _;

	#[test]
	fn init_and_params() {
		let env = Env::default();
		env.mock_all_auths();
		let admin = Address::generate(&env);
		let cid = env.register_contract(None, EmissionController);
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
		let cid = env.register_contract(None, EmissionController);
		let c = EmissionControllerClient::new(&env, &cid);

		// Target 70% utilization, moderate gains, emission bounds [0, 1_000_000]
		c.init(&admin, &7_000, &400, &30, &80, &0, &1_000_000);

		// Start far below target utilization and see emissions rise then stabilize
		let mut util_series = [2_000u32, 3_000, 4_000, 5_000, 6_000, 6_500, 6_800, 6_900, 7_000, 7_100, 7_000];
		let mut last = 0i128;
		for u in util_series.iter() {
			last = c.compute_emission(u);
			let (_i, _e, le) = c.state();
			assert_eq!(le, last);
			// should remain within bounds
			assert!(last >= 0 && last <= 1_000_000);
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
		let cid = env.register_contract(None, EmissionController);
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
}
