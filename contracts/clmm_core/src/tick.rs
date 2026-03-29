//! # Tick Module — Tick State Management & Fee Growth Tracking
//!
//! Manages tick-level liquidity and fee growth calculations for concentrated liquidity.

use crate::{ClmmError, DataKey, TickInfo};
use soroban_sdk::Env;

/// Minimum tick index (-887272 for Uniswap V3 compatibility)
pub const MIN_TICK: i32 = -887272;

/// Maximum tick index (887272 for Uniswap V3 compatibility)
pub const MAX_TICK: i32 = 887272;

/// Get tick info, returning empty tick if not initialized.
pub fn get_tick(env: &Env, tick: i32) -> TickInfo {
    env.storage()
        .persistent()
        .get(&DataKey::Tick(tick))
        .unwrap_or(TickInfo {
            liquidity_gross: 0,
            liquidity_net: 0,
            fee_growth_outside_0_x128: 0,
            fee_growth_outside_1_x128: 0,
            initialized: false,
        })
}

/// Update tick state when liquidity is added or removed.
///
/// # Arguments
/// * `tick` — Tick index to update
/// * `liquidity_delta` — Change in liquidity (positive = add, negative = remove)
/// * `upper` — Whether this is an upper tick boundary
pub fn update_tick(
    env: &Env,
    tick: i32,
    liquidity_delta: i128,
    upper: bool,
) -> Result<(), ClmmError> {
    let mut info = get_tick(env, tick);

    let liquidity_gross_before = info.liquidity_gross;

    // Update gross liquidity (always positive)
    let liquidity_gross_after = if liquidity_delta < 0 {
        info.liquidity_gross
            .saturating_sub((-liquidity_delta) as u128)
    } else {
        info.liquidity_gross.saturating_add(liquidity_delta as u128)
    };

    info.liquidity_gross = liquidity_gross_after;

    // Update net liquidity (directional)
    if upper {
        info.liquidity_net = info.liquidity_net.saturating_sub(liquidity_delta);
    } else {
        info.liquidity_net = info.liquidity_net.saturating_add(liquidity_delta);
    }

    // Initialize tick if this is the first liquidity
    if liquidity_gross_before == 0 && liquidity_gross_after > 0 {
        info.initialized = true;

        // Initialize fee growth outside values
        let current_tick: i32 = env.storage().instance().get(&DataKey::CurrentTick).unwrap();

        if tick <= current_tick {
            info.fee_growth_outside_0_x128 = env
                .storage()
                .instance()
                .get(&DataKey::FeeGrowthGlobal0X128)
                .unwrap_or(0);
            info.fee_growth_outside_1_x128 = env
                .storage()
                .instance()
                .get(&DataKey::FeeGrowthGlobal1X128)
                .unwrap_or(0);
        }
    }

    // Clear tick if liquidity is fully removed
    if liquidity_gross_after == 0 {
        env.storage().persistent().remove(&DataKey::Tick(tick));
    } else {
        env.storage().persistent().set(&DataKey::Tick(tick), &info);
    }

    Ok(())
}

/// Calculate fee growth inside a tick range.
///
/// # Returns
/// (fee_growth_inside_0, fee_growth_inside_1)
pub fn get_fee_growth_inside(
    env: &Env,
    tick_lower: i32,
    tick_upper: i32,
    tick_current: i32,
    fee_growth_global_0: u128,
    fee_growth_global_1: u128,
) -> (u128, u128) {
    let lower = get_tick(env, tick_lower);
    let upper = get_tick(env, tick_upper);

    // Calculate fee growth below lower tick
    let (fee_growth_below_0, fee_growth_below_1) = if tick_current >= tick_lower {
        (
            lower.fee_growth_outside_0_x128,
            lower.fee_growth_outside_1_x128,
        )
    } else {
        (
            fee_growth_global_0.wrapping_sub(lower.fee_growth_outside_0_x128),
            fee_growth_global_1.wrapping_sub(lower.fee_growth_outside_1_x128),
        )
    };

    // Calculate fee growth above upper tick
    let (fee_growth_above_0, fee_growth_above_1) = if tick_current < tick_upper {
        (
            upper.fee_growth_outside_0_x128,
            upper.fee_growth_outside_1_x128,
        )
    } else {
        (
            fee_growth_global_0.wrapping_sub(upper.fee_growth_outside_0_x128),
            fee_growth_global_1.wrapping_sub(upper.fee_growth_outside_1_x128),
        )
    };

    // Fee growth inside = global - below - above
    let fee_growth_inside_0 = fee_growth_global_0
        .wrapping_sub(fee_growth_below_0)
        .wrapping_sub(fee_growth_above_0);

    let fee_growth_inside_1 = fee_growth_global_1
        .wrapping_sub(fee_growth_below_1)
        .wrapping_sub(fee_growth_above_1);

    (fee_growth_inside_0, fee_growth_inside_1)
}

/// Find the next initialized tick in a given direction.
/// Simplified implementation for safety.
pub fn get_next_initialized_tick_within_one_word(env: &Env, tick: i32, lte: bool) -> Option<i32> {
    let tick_spacing: i32 = env.storage().instance().get(&DataKey::TickSpacing).unwrap();

    // Search within a reasonable range (256 ticks)
    let search_range = 256 * tick_spacing;

    if lte {
        // Search downward
        for i in 1..=search_range {
            let candidate = tick - i;
            if candidate < MIN_TICK {
                break;
            }
            let info = get_tick(env, candidate);
            if info.initialized {
                return Some(candidate);
            }
        }
    } else {
        // Search upward
        for i in 1..=search_range {
            let candidate = tick + i;
            if candidate > MAX_TICK {
                break;
            }
            let info = get_tick(env, candidate);
            if info.initialized {
                return Some(candidate);
            }
        }
    }

    None
}
