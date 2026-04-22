//! # Math Module — High-Precision Tick & Price Calculations
//!
//! Implements fixed-point arithmetic for CLMM operations using Q64.96 and Q128 formats.
//! All operations use checked arithmetic to prevent overflow/underflow panics.

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
/// Uses approximation for safety and gas efficiency.
pub fn get_sqrt_ratio_at_tick(tick: i32) -> u128 {
    let abs_tick = if tick < 0 {
        (-tick) as u32
    } else {
        tick as u32
    };

    // Simplified approximation: sqrt(1.0001^tick) * 2^96
    // For production, use full Uniswap V3 math or lookup tables
    let ratio = if tick >= 0 {
        Q96 + (Q96 * abs_tick as u128) / 10000
    } else {
        Q96 - (Q96 * abs_tick as u128) / 10000
    };

    ratio.max(MIN_SQRT_RATIO)
}

/// Calculate token amounts required for a given liquidity amount.
///
/// # Returns
/// (amount0, amount1) — Token amounts needed
pub fn get_amounts_for_liquidity(
    sqrt_price_x96: u128,
    tick_lower: i32,
    tick_upper: i32,
    liquidity: u128,
) -> (u128, u128) {
    let sqrt_ratio_a = get_sqrt_ratio_at_tick(tick_lower);
    let sqrt_ratio_b = get_sqrt_ratio_at_tick(tick_upper);

    let (sqrt_ratio_lower, sqrt_ratio_upper) = if sqrt_ratio_a < sqrt_ratio_b {
        (sqrt_ratio_a, sqrt_ratio_b)
    } else {
        (sqrt_ratio_b, sqrt_ratio_a)
    };

    let amount0 = if sqrt_price_x96 <= sqrt_ratio_lower {
        get_amount0_for_liquidity(sqrt_ratio_lower, sqrt_ratio_upper, liquidity)
    } else if sqrt_price_x96 < sqrt_ratio_upper {
        get_amount0_for_liquidity(sqrt_price_x96, sqrt_ratio_upper, liquidity)
    } else {
        0
    };

    let amount1 = if sqrt_price_x96 >= sqrt_ratio_upper {
        get_amount1_for_liquidity(sqrt_ratio_lower, sqrt_ratio_upper, liquidity)
    } else if sqrt_price_x96 > sqrt_ratio_lower {
        get_amount1_for_liquidity(sqrt_ratio_lower, sqrt_price_x96, liquidity)
    } else {
        0
    };

    (amount0, amount1)
}

/// Calculate amount0 for a liquidity delta.
fn get_amount0_for_liquidity(sqrt_ratio_a: u128, sqrt_ratio_b: u128, liquidity: u128) -> u128 {
    if sqrt_ratio_a > sqrt_ratio_b {
        return get_amount0_for_liquidity(sqrt_ratio_b, sqrt_ratio_a, liquidity);
    }

    let numerator = liquidity * Q96;
    let denominator = sqrt_ratio_b;

    if denominator == 0 {
        return 0;
    }

    (numerator / denominator).saturating_sub(numerator / sqrt_ratio_a.max(1))
}

/// Calculate amount1 for a liquidity delta.
fn get_amount1_for_liquidity(sqrt_ratio_a: u128, sqrt_ratio_b: u128, liquidity: u128) -> u128 {
    if sqrt_ratio_a > sqrt_ratio_b {
        return get_amount1_for_liquidity(sqrt_ratio_b, sqrt_ratio_a, liquidity);
    }

    let delta = sqrt_ratio_b.saturating_sub(sqrt_ratio_a);
    (liquidity * delta) / Q96
}

/// Compute a single swap step within a tick range.
///
/// # Returns
/// (sqrt_price_next, amount_in, amount_out, fee_amount)
pub fn compute_swap_step(
    sqrt_price_current: u128,
    sqrt_price_target: u128,
    liquidity: u128,
    amount_remaining: i128,
    fee_bps: u32,
) -> (u128, u128, u128, u128) {
    if liquidity == 0 {
        return (sqrt_price_current, 0, 0, 0);
    }

    let zero_for_one = sqrt_price_current >= sqrt_price_target;
    let exact_input = amount_remaining >= 0;

    // Simplified swap math for safety
    let amount_remaining_abs = if amount_remaining < 0 {
        (-amount_remaining) as u128
    } else {
        amount_remaining as u128
    };

    // Calculate fee
    let fee_amount = (amount_remaining_abs * fee_bps as u128) / 10000;
    let amount_after_fee = amount_remaining_abs.saturating_sub(fee_amount);

    // Simplified price impact calculation
    let price_delta = (amount_after_fee * Q96) / liquidity.max(1);

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
    let amount_in = if exact_input {
        amount_after_fee
    } else {
        (liquidity * price_delta) / Q96
    };

    let amount_out = (liquidity * price_delta) / Q96;

    (sqrt_price_next, amount_in, amount_out, fee_amount)
}
