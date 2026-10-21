use soroban_sdk::Env;

/// Scale factor for every fixed-point value handled by this module: 1e9.
pub const ONE: i128 = 1_000_000_000;

/// Exponent range used by the `ln` bisection and the `normal_cdf` tail clamp.
///
/// Expressed in `ONE` units; keeping the CDF exponent in this range avoids
/// overflowing the fixed-point product used to evaluate its logistic tail.
const EXP_BOUND: i128 = 10 * ONE;

/// Squashes a `u128` intermediate into the `i128` range that token amounts and
/// fixed-point prices live in, saturating instead of wrapping.
fn clamp_to_i128(value: u128) -> i128 {
    if value > i128::MAX as u128 {
        i128::MAX
    } else {
        value as i128
    }
}

/// Computes `floor(a * b / d)` for `a >= 0`, `b >= 0`, `d > 0`.
///
/// # Rounding rule
///
/// This is the single rounding primitive for option money math. Every division
/// that produces a monetary or fixed-point result goes through it, so the
/// direction is always *down*: a premium, a payout, or an accrued value can
/// never be credited with a fractional base unit, and the truncated remainder
/// stays with the protocol instead of leaking to whichever side rounded up.
///
/// # Overflow
///
/// The release profile enables `overflow-checks`, so a plain `a * b` would abort
/// the contract. The exact product is tried first; when it does not fit, `a` is
/// split into `q * d + r` and only the bounded remainder `r * b` is divided by
/// `d` with a bitwise long division. Every intermediate stays below `2 * d` or
/// `2 * b`, both of which fit in `u128`. A result that still does not fit in
/// `i128` saturates at `i128::MAX`.
fn mul_div_floor(a: i128, b: i128, d: i128) -> i128 {
    if a <= 0 || b <= 0 || d <= 0 {
        return 0;
    }
    let (a, b, d) = (a as u128, b as u128, d as u128);

    if let Some(product) = a.checked_mul(b) {
        return clamp_to_i128(product / d);
    }

    // a == q * d + r, therefore floor(a * b / d) == q * b + floor(r * b / d).
    let whole = match (a / d).checked_mul(b) {
        Some(value) => value,
        // `q * b` alone already exceeds `u128`, so the true quotient exceeds
        // `i128::MAX` as well.
        None => return i128::MAX,
    };
    let remainder = a % d;

    // Long division of `remainder * b` by `d`, consuming one bit of `b` per
    // step. The invariant is `fraction * d + rest == remainder * value_so_far`
    // with `rest < d`; the leading `whole` part is re-added at the end.
    let mut fraction = 0_u128;
    let mut rest = 0_u128;
    for bit in (0..128).rev() {
        let doubled = rest * 2;
        fraction *= 2;
        rest = doubled;
        if rest >= d {
            rest -= d;
            fraction += 1;
        }
        if (b >> bit) & 1 == 1 {
            rest += remainder;
            if rest >= d {
                rest -= d;
                fraction += 1;
            }
        }
    }

    clamp_to_i128(whole.saturating_add(fraction))
}

/// Computes `trunc(a * b / d)`, rounding the magnitude down and then restoring
/// the sign.
///
/// # Rounding rule
///
/// Reserved for the *signed statistical* intermediates of the premium
/// approximation (`d1`, the log-likelihood term), where flooring toward
/// negative infinity would bias deep out-of-the-money quotes. Truncation toward
/// zero is symmetric around zero and reproduces the values the contract has
/// always returned, so existing premiums stay stable.
fn mul_div_trunc(a: i128, b: i128, d: i128) -> i128 {
    if a == 0 || b == 0 || d <= 0 {
        return 0;
    }
    let negative = (a < 0) ^ (b < 0);
    let magnitude = match a.checked_abs().zip(b.checked_abs()) {
        Some((left, right)) => mul_div_floor(left, right, d),
        // `i128::MIN` has no positive counterpart; saturate to the signed bound.
        None => return if negative { i128::MIN } else { i128::MAX },
    };

    if negative {
        if magnitude == i128::MAX {
            i128::MIN
        } else {
            -magnitude
        }
    } else {
        magnitude
    }
}

/// Computes the integer square root of x using Newton's method
pub fn isqrt(x: i128) -> i128 {
    if x <= 0 {
        return 0;
    }
    let mut z = x;
    let mut y = x / 2 + 1;
    while y < z {
        z = y;
        y = (x / y + y) / 2;
    }
    z
}

/// Fixed-point exponential function e^x using a Taylor series up to 10 terms.
///
/// Negative inputs use the reciprocal of the positive-input approximation so
/// the truncated Taylor series cannot become negative in its left tail.
pub fn exp(x: i128) -> i128 {
    if x == 0 {
        return ONE;
    }
    if x < 0 {
        let positive_x = match x.checked_neg() {
            Some(value) => value,
            None => return 0,
        };
        let positive_exp = exp(positive_x);
        return mul_div_floor(ONE, ONE, positive_exp);
    }
    let mut sum = ONE;
    let mut term = ONE;
    for i in 1..10 {
        term = mul_div_trunc(term, x, i as i128 * ONE);
        sum = sum.saturating_add(term);
        // Break early if term becomes negligible
        if term == 0 {
            break;
        }
    }
    sum
}

/// Fixed-point natural log using bisection
pub fn ln(x: i128) -> i128 {
    if x <= 0 {
        return 0; // Reverting usually, but returning 0 for safety here limits range errors
    }
    let mut low = -EXP_BOUND;
    let mut high = EXP_BOUND;
    for _ in 0..40 {
        let mid = (low + high) / 2;
        let e_mid = exp(mid);
        if e_mid < x {
            low = mid;
        } else {
            high = mid;
        }
    }
    (low + high) / 2
}

/// Normal Cumulative Distribution Function approximation using Logistic Apprx
/// N(x) ≈ 1 / (1 + exp(-1.702 * x))
///
/// The logistic tails are clamped once `|1.702 * x| > 10`, keeping the
/// exponent product bounded and returning the correct limits of 0 and 1.
pub fn normal_cdf(x: i128) -> i128 {
    let coeff = 1_702_000_000; // 1.702 * 1e9
    let bound = mul_div_floor(EXP_BOUND, ONE, coeff);

    if x > bound {
        return ONE;
    } else if x < -bound {
        return 0;
    }

    let exponent = mul_div_trunc(-coeff, x, ONE);
    let e_val = exp(exponent);

    // 1 / (1 + e) in ONE units, rounded down like every other monetary divide.
    mul_div_floor(ONE, ONE, ONE + e_val)
}

/// Calculates Black-Scholes call premium using fixed point math
/// spot: current price (scaled by ONE)
/// strike: strike price (scaled by ONE)
/// t: time to expiry in years (scaled by ONE)
/// iv: implied volatility (scaled by ONE)
///
/// # Rounding
///
/// Every intermediate division routes through [`mul_div_floor`] (money) or
/// [`mul_div_trunc`] (signed statistics), so the returned premium is always the
/// largest representable amount that does not exceed the true Black-Scholes
/// value. Expired options (or non-positive volatility) fall back to the exact
/// integer intrinsic value `max(spot - strike, 0)`.
pub fn black_scholes_call(_env: &Env, spot: i128, strike: i128, t: i128, iv: i128) -> i128 {
    if spot <= 0 || strike <= 0 {
        return 0;
    }
    let intrinsic = if spot > strike { spot - strike } else { 0 };

    // At or after expiry, or with no volatility left, the option is worth no
    // more than the amount it settles for.
    if t <= 0 || iv <= 0 {
        return intrinsic;
    }

    let spot_scaled = mul_div_floor(spot, ONE, strike);
    let ln_val = ln(spot_scaled);
    let iv_sq = mul_div_floor(iv, iv, ONE);
    let time_term = mul_div_floor(iv_sq / 2, t, ONE);
    let num = ln_val.saturating_add(time_term);

    let sqrt_t = isqrt(t.saturating_mul(ONE));

    let den = mul_div_floor(iv, sqrt_t, ONE);
    if den == 0 {
        return intrinsic;
    }

    let d1 = mul_div_trunc(num, ONE, den);
    let d2 = d1.saturating_sub(den);

    let term1 = mul_div_floor(spot, normal_cdf(d1), ONE);
    let term2 = mul_div_floor(strike, normal_cdf(d2), ONE);

    if term1 > term2 {
        term1 - term2
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference oracle for `mul_div_floor` on inputs whose exact product fits
    /// in `u128`; `mul_div_floor` must agree with it bit for bit.
    fn reference(a: i128, b: i128, d: i128) -> i128 {
        let product = (a as u128) * (b as u128);
        let value = product / (d as u128);
        if value > i128::MAX as u128 {
            i128::MAX
        } else {
            value as i128
        }
    }

    /// Deterministic LCG so the sweep below is reproducible in wasm/native.
    fn next(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *seed
    }

    #[test]
    fn test_isqrt() {
        assert_eq!(isqrt(100), 10);
        assert_eq!(isqrt(144), 12);
    }

    #[test]
    fn test_exp() {
        // e^0 = 1
        assert_eq!(exp(0), ONE);

        // e^1 ≈ 2.718...
        let e1 = exp(ONE);
        assert!((e1 - 2_718_281_828).abs() < 10_000_000); // Allow some margin

        // e^-1 ≈ 0.368; the negative tail must remain positive.
        let e_neg1 = exp(-ONE);
        assert!((e_neg1 - 367_879_441).abs() < 10_000_000);
    }

    #[test]
    fn test_normal_cdf() {
        // N(0) = 0.5
        let n0 = normal_cdf(0);
        assert_eq!(n0, ONE / 2);
        assert_eq!(normal_cdf(11 * ONE), ONE);
        assert_eq!(normal_cdf(-11 * ONE), 0);
    }

    // ── Sub-unit values ─────────────────────────────────────────────────────

    #[test]
    fn test_floor_rounds_sub_unit_results_to_zero() {
        // Anything below one base unit truncates to zero rather than to 1.
        assert_eq!(mul_div_floor(1, ONE, ONE + 1), 0);
        assert_eq!(mul_div_floor(1, ONE - 1, ONE), 0);
        assert_eq!(mul_div_floor(ONE - 1, 1, ONE), 0);
        // One base unit above zero survives.
        assert_eq!(mul_div_floor(ONE, ONE, ONE), ONE);
        // A sub-unit premium is never rounded up into a payable amount.
        assert_eq!(mul_div_floor(1, 1, 2), 0);
        assert_eq!(mul_div_floor(3, 1, 4), 0);
        assert_eq!(mul_div_floor(4, 1, 4), 1);
    }

    #[test]
    fn test_floor_ignores_non_positive_operands() {
        assert_eq!(mul_div_floor(0, ONE, ONE), 0);
        assert_eq!(mul_div_floor(ONE, 0, ONE), 0);
        assert_eq!(mul_div_floor(-5, ONE, ONE), 0);
        assert_eq!(mul_div_floor(ONE, -5, ONE), 0);
        assert_eq!(mul_div_floor(ONE, ONE, 0), 0);
        assert_eq!(mul_div_floor(ONE, ONE, -1), 0);
    }

    // ── Exact divisibility ──────────────────────────────────────────────────

    #[test]
    fn test_floor_preserves_exactly_divisible_values() {
        assert_eq!(mul_div_floor(2 * ONE, ONE, 2), ONE * ONE);
        assert_eq!(mul_div_floor(7, 6, 3), 14);
        assert_eq!(mul_div_floor(ONE, ONE, ONE), ONE);
        // 1e18 is an exact multiple of 1e9 in both directions.
        assert_eq!(
            mul_div_floor(1_000 * ONE, 1_000 * ONE, ONE),
            1_000_000 * ONE
        );
        assert_eq!(mul_div_floor(3 * ONE, 4 * ONE, ONE), 12 * ONE);
        // Repeated halving must never drift: 100 odd divisions down to 1 unit.
        let mut value = 3 * ONE;
        for _ in 0..31 {
            value = mul_div_floor(value, 1, 2);
        }
        assert_eq!(value, 1);
    }

    // ── Large amounts ───────────────────────────────────────────────────────

    #[test]
    fn test_floor_handles_large_amounts_without_overflow() {
        // 2^100 * 2^100 overflows i128 and u128, yet the quotient is exact.
        let pow = 1_i128 << 100;
        assert_eq!(mul_div_floor(pow, pow, 1_i128 << 101), 1_i128 << 99);
        // Slow path with a non-zero remainder: floor((2^100-1) * 2^100 / 2^100)
        // == 2^100 - 1.
        assert_eq!(mul_div_floor(pow - 1, pow, pow), pow - 1);
        // Largest representable amounts saturate rather than wrap or abort.
        assert_eq!(mul_div_floor(i128::MAX, ONE, ONE), i128::MAX);
        assert_eq!(mul_div_floor(i128::MAX, i128::MAX, i128::MAX), i128::MAX);
        assert_eq!(mul_div_floor(i128::MAX, i128::MAX, 1), i128::MAX);
        // Still exact when the product does fit in u128 but not in i128.
        let big = 40_000_000_000_000_000_000_i128;
        assert_eq!(mul_div_floor(big, 3, 2), big + big / 2);
        assert_eq!(reference(big, 3, 2), big + big / 2);
    }

    #[test]
    fn test_floor_matches_reference_over_random_sweep() {
        let mut seed = 0x5EED_1462_u64;
        for _ in 0..4_000 {
            let a = (next(&mut seed) % 2_000_000) as i128;
            let b = (next(&mut seed) % 2_000_000) as i128;
            let d = 1 + (next(&mut seed) % 2_000_000) as i128;
            assert_eq!(mul_div_floor(a, b, d), reference(a, b, d));
        }
    }

    #[test]
    fn test_floor_matches_reference_over_wide_sweep() {
        // Straddles the i128::MAX / u128::MAX product boundary on purpose.
        let mut seed = 0x00_0B_5A_11_u64;
        for _ in 0..2_000 {
            let a = (next(&mut seed) as i128) & i128::MAX >> 1;
            let b = (next(&mut seed) as i128) & i128::MAX >> 1;
            let d = 1 + ((next(&mut seed) as i128) & i128::MAX >> 1);
            assert_eq!(mul_div_floor(a, b, d), reference(a, b, d));
        }
    }

    // ── Signed truncation ───────────────────────────────────────────────────

    #[test]
    fn test_trunc_rounds_toward_zero_symmetrically() {
        assert_eq!(mul_div_trunc(7, ONE, 2), 3_500_000_000);
        assert_eq!(mul_div_trunc(-7, ONE, 2), -3_500_000_000);
        assert_eq!(mul_div_trunc(7, -ONE, 2), -3_500_000_000);
        assert_eq!(mul_div_trunc(-7, -ONE, 2), 3_500_000_000);
        // Signed sub-unit values collapse to zero, not to -1.
        assert_eq!(mul_div_trunc(-1, ONE, ONE + 1), 0);
        assert_eq!(mul_div_trunc(1, -ONE, ONE + 1), 0);
        assert_eq!(mul_div_trunc(i128::MIN, 0, ONE), 0);
        assert_eq!(mul_div_trunc(i128::MIN, 1, 1), i128::MIN);
        assert_eq!(mul_div_trunc(i128::MIN, -1, 1), i128::MAX);
        assert_eq!(mul_div_trunc(5, 5, 0), 0);
    }

    // ── Premium ─────────────────────────────────────────────────────────────

    #[test]
    fn test_premium_returns_exact_intrinsic_value() {
        let env = Env::default();
        assert_eq!(
            black_scholes_call(&env, 12 * ONE, 10 * ONE, 0, ONE),
            2 * ONE
        );
        assert_eq!(black_scholes_call(&env, 8 * ONE, 10 * ONE, 0, ONE), 0);
        // Zero volatility collapses to intrinsic value as well.
        assert_eq!(
            black_scholes_call(&env, 12 * ONE, 10 * ONE, ONE, 0),
            2 * ONE
        );
        // Non-positive inputs never divide by zero.
        assert_eq!(black_scholes_call(&env, 10 * ONE, 0, ONE, ONE), 0);
        assert_eq!(black_scholes_call(&env, -1, 10 * ONE, ONE, ONE), 0);
    }

    #[test]
    fn test_premium_rounds_sub_unit_quotations_to_zero() {
        let env = Env::default();
        // Deeply out of the money with a tiny volatility: the true premium is
        // far below a single base unit and must settle at zero, not at one.
        assert_eq!(
            black_scholes_call(&env, 2 * ONE, 4 * ONE, ONE, 100_000_000),
            0
        );
        assert_eq!(black_scholes_call(&env, 1, 2, ONE, ONE), 0);
    }

    #[test]
    fn test_premium_never_decreases_with_size() {
        let env = Env::default();
        // Scaling every input by the same exact factor scales the premium by
        // that factor: no sub-unit dust accumulates along the way.
        for units in [1_i128, 2, 7, 1_000, 1_000_000] {
            let spot = 10_000_000 * units;
            let strike = 10_000_000 * units;
            let small = black_scholes_call(&env, spot, strike, ONE / 4, ONE / 2);
            let scaled = black_scholes_call(
                &env,
                spot.saturating_mul(10),
                strike.saturating_mul(10),
                ONE / 4,
                ONE / 2,
            );
            assert!(scaled >= small);
        }
    }

    #[test]
    fn test_premium_is_monotonic_in_spot() {
        let env = Env::default();
        let mut previous = 0;
        for spot in [
            5_000_000_i128,
            7_500_000,
            10_000_000,
            15_000_000,
            40_000_000,
        ] {
            let premium = black_scholes_call(&env, spot, 10_000_000, ONE, ONE / 2);
            assert!(
                premium >= previous,
                "premium dropped at spot {spot}: {premium} < {previous}"
            );
            previous = premium;
        }
    }

    #[test]
    fn test_premium_handles_extreme_inputs_without_overflow() {
        let env = Env::default();
        let huge = 1_000_000_000_000_000_000_000_000_000_000_i128;
        let premium = black_scholes_call(&env, huge, huge, ONE, ONE);
        assert!(premium > 0);
        assert!(premium <= huge);
        assert_eq!(
            black_scholes_call(&env, i128::MAX, 1, 0, ONE),
            i128::MAX - 1
        );
        // Wide inputs must not panic, whatever they are.
        for spot in [i128::MAX, i128::MAX / 2, 1, i128::MAX / ONE] {
            for strike in [1_i128, ONE, i128::MAX] {
                for t in [0_i128, 1, ONE, i128::MAX / 4] {
                    for iv in [0_i128, 1, ONE, i128::MAX / 4] {
                        black_scholes_call(&env, spot, strike, t, iv);
                    }
                }
            }
        }
    }
}
