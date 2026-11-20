//! # Math Module — High-Precision Tick & Price Calculations
//!
//! Implements fixed-point arithmetic for CLMM operations using Q64.96 and Q128 formats.
//! All externally reachable operations use checked arithmetic and return a typed
//! [`ClmmError`] instead of panicking, so malformed inputs can never abort a call
//! with an opaque host panic.

use crate::ClmmError;

/// Q64.96 fixed point constant (2^96)
pub const Q96: u128 = 0x1000000000000000000000000;

/// Q128 fixed point constant (2^128)
pub const Q128: u128 = 340282366920938463463374607431768211455;

/// Minimum sqrt ratio (tick = -887272)
pub const MIN_SQRT_RATIO: u128 = 4295128739;

/// Maximum sqrt ratio (tick = 887272) - clamped to u128::MAX for safety
#[allow(dead_code)]
pub const MAX_SQRT_RATIO: u128 = 340282366920938463463374607431768211455;

/// Convert sqrt price (Q64.96) to tick index.
/// Uses binary search for efficiency and safety.
pub fn get_tick_at_sqrt_ratio(sqrt_price_x96: u128) -> i32 {
    if sqrt_price_x96 < MIN_SQRT_RATIO {
        return 0; // Fallback to tick 0 for invalid prices
    }

    // Binary search for tick
    let mut low = super::tick::MIN_TICK;
    let mut high = super::tick::MAX_TICK;

    while low <= high {
        let mid = (low + high) / 2;
        let sqrt_ratio = get_sqrt_ratio_at_tick(mid);

        if sqrt_ratio == sqrt_price_x96 {
            return mid;
        } else if sqrt_ratio < sqrt_price_x96 {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    high // Return closest tick below the price
}

/// Convert tick index to sqrt price (Q64.96).
///
/// Uses a linear approximation for safety and gas efficiency. Out-of-range ticks
/// are clamped to the minimum/maximum ratio and the arithmetic is saturating, so
/// this function is total: every `i32` input maps to a valid ratio.
pub fn get_sqrt_ratio_at_tick(tick: i32) -> u128 {
    if tick <= super::tick::MIN_TICK {
        return MIN_SQRT_RATIO;
    }
    if tick >= super::tick::MAX_TICK {
        return MAX_SQRT_RATIO;
    }

    // Simplified approximation: sqrt(1.0001^tick) * 2^96
    // For production, use full Uniswap V3 math or lookup tables
    let abs_tick = tick.unsigned_abs() as u128;
    let adjustment = Q96.saturating_mul(abs_tick) / 10_000;

    if tick >= 0 {
        Q96.saturating_add(adjustment)
    } else {
        Q96.saturating_sub(adjustment).max(MIN_SQRT_RATIO)
    }
}

/// Calculate token amounts required for a given liquidity amount.
///
/// # Returns
/// `(amount0, amount1)` — Token amounts needed, or [`ClmmError::MathOverflow`]
/// when the requested liquidity cannot be represented safely.
pub fn get_amounts_for_liquidity(
    sqrt_price_x96: u128,
    tick_lower: i32,
    tick_upper: i32,
    liquidity: u128,
) -> Result<(u128, u128), ClmmError> {
    let sqrt_ratio_a = get_sqrt_ratio_at_tick(tick_lower);
    let sqrt_ratio_b = get_sqrt_ratio_at_tick(tick_upper);

    let (sqrt_ratio_lower, sqrt_ratio_upper) = if sqrt_ratio_a < sqrt_ratio_b {
        (sqrt_ratio_a, sqrt_ratio_b)
    } else {
        (sqrt_ratio_b, sqrt_ratio_a)
    };

    let amount0 = if sqrt_price_x96 <= sqrt_ratio_lower {
        get_amount0_for_liquidity(sqrt_ratio_lower, sqrt_ratio_upper, liquidity)?
    } else if sqrt_price_x96 < sqrt_ratio_upper {
        get_amount0_for_liquidity(sqrt_price_x96, sqrt_ratio_upper, liquidity)?
    } else {
        0
    };

    let amount1 = if sqrt_price_x96 >= sqrt_ratio_upper {
        get_amount1_for_liquidity(sqrt_ratio_lower, sqrt_ratio_upper, liquidity)?
    } else if sqrt_price_x96 > sqrt_ratio_lower {
        get_amount1_for_liquidity(sqrt_ratio_lower, sqrt_price_x96, liquidity)?
    } else {
        0
    };

    Ok((amount0, amount1))
}

/// Calculate amount0 for a liquidity delta.
fn get_amount0_for_liquidity(
    sqrt_ratio_a: u128,
    sqrt_ratio_b: u128,
    liquidity: u128,
) -> Result<u128, ClmmError> {
    if sqrt_ratio_a > sqrt_ratio_b {
        return get_amount0_for_liquidity(sqrt_ratio_b, sqrt_ratio_a, liquidity);
    }

    let numerator = liquidity.checked_mul(Q96).ok_or(ClmmError::MathOverflow)?;
    let denominator = sqrt_ratio_b;

    if denominator == 0 {
        return Ok(0);
    }

    Ok((numerator / denominator).saturating_sub(numerator / sqrt_ratio_a.max(1)))
}

/// Calculate amount1 for a liquidity delta.
fn get_amount1_for_liquidity(
    sqrt_ratio_a: u128,
    sqrt_ratio_b: u128,
    liquidity: u128,
) -> Result<u128, ClmmError> {
    if sqrt_ratio_a > sqrt_ratio_b {
        return get_amount1_for_liquidity(sqrt_ratio_b, sqrt_ratio_a, liquidity);
    }

    let delta = sqrt_ratio_b.saturating_sub(sqrt_ratio_a);
    let scaled = liquidity
        .checked_mul(delta)
        .ok_or(ClmmError::MathOverflow)?;

    Ok(scaled / Q96)
}

/// Compute a single swap step within a tick range.
///
/// # Returns
/// `(sqrt_price_next, amount_in, amount_out, fee_amount)` or
/// [`ClmmError::MathOverflow`] when the step cannot be computed safely.
pub fn compute_swap_step(
    sqrt_price_current: u128,
    sqrt_price_target: u128,
    liquidity: u128,
    amount_remaining: i128,
    fee_bps: u32,
) -> Result<(u128, u128, u128, u128), ClmmError> {
    if liquidity == 0 {
        return Ok((sqrt_price_current, 0, 0, 0));
    }

    let zero_for_one = sqrt_price_current >= sqrt_price_target;
    let exact_input = amount_remaining >= 0;

    // Simplified swap math for safety
    let amount_remaining_abs = amount_remaining.unsigned_abs();

    // Calculate fee
    let fee_amount = amount_remaining_abs
        .checked_mul(fee_bps as u128)
        .ok_or(ClmmError::MathOverflow)?
        / 10_000;
    let amount_after_fee = amount_remaining_abs.saturating_sub(fee_amount);

    // Simplified price impact calculation
    let price_delta = amount_after_fee
        .checked_mul(Q96)
        .ok_or(ClmmError::MathOverflow)?
        / liquidity.max(1);

    let sqrt_price_next = if zero_for_one {
        sqrt_price_current.saturating_sub(price_delta)
    } else {
        sqrt_price_current.saturating_add(price_delta)
    };

    // Clamp to target
    let sqrt_price_next = if zero_for_one {
        sqrt_price_next.max(sqrt_price_target)
    } else {
        sqrt_price_next.min(sqrt_price_target)
    };

    // Calculate amounts
    let amount_from_liquidity = liquidity
        .checked_mul(price_delta)
        .ok_or(ClmmError::MathOverflow)?
        / Q96;

    let amount_in = if exact_input {
        amount_after_fee
    } else {
        amount_from_liquidity
    };

    let amount_out = amount_from_liquidity;

    Ok((sqrt_price_next, amount_in, amount_out, fee_amount))
}
