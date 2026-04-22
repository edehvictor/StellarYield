use soroban_sdk::Env;

pub const ONE: i128 = 1_000_000_000; // 1e9 scale for internal math precision

// Computes the integer square root of x using Newton's method
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

// Fixed-point exponential function e^x
// Uses a Taylor series up to 10 terms
pub fn exp(x: i128) -> i128 {
    if x == 0 {
        return ONE;
    }
    let mut sum = ONE;
    let mut term = ONE;
    for i in 1..10 {
        term = (term * x) / (i as i128 * ONE);
        sum += term;
        // Break early if term becomes negligible
        if term == 0 {
            break;
        }
    }
    sum
}

// Fixed-point natural log using bisection
pub fn ln(x: i128) -> i128 {
    if x <= 0 {
        return 0; // Reverting usually, but returning 0 for safety here limits range errors
    }
    let mut low = -10 * ONE;
    let mut high = 10 * ONE;
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

// Normal Cumulative Distribution Function approximation using Logistic Apprx
// N(x) ≈ 1 / (1 + exp(-1.702 * x))
pub fn normal_cdf(x: i128) -> i128 {
    let coeff = 1_702_000_000; // 1.702 * 1e9
    let exponent = (-coeff * x) / ONE;

    // Bounds check to avoid overflow in exp
    if exponent > 10 * ONE {
        return 0;
    } else if exponent < -10 * ONE {
        return ONE;
    }

    let e_val = exp(exponent);
    (ONE * ONE) / (ONE + e_val)
}

// Calculates Black-Scholes call premium using fixed point math
// spot: current price (scaled by ONE)
// strike: strike price (scaled by ONE)
// t: time to expiry in years (scaled by ONE)
// iv: implied volatility (scaled by ONE)
pub fn black_scholes_call(_env: &Env, spot: i128, strike: i128, t: i128, iv: i128) -> i128 {
    if t <= 0 {
        return if spot > strike { spot - strike } else { 0 };
    }

    let spot_scaled = (spot * ONE) / strike;
    let ln_val = ln(spot_scaled);
    let iv_sq = (iv * iv) / ONE;
    let num = ln_val + (iv_sq / 2 * t) / ONE;

    let t_sq = t * ONE;
    let sqrt_t = isqrt(t_sq);

    let den = (iv * sqrt_t) / ONE;
    if den == 0 {
        return if spot > strike { spot - strike } else { 0 };
    }

    let d1 = (num * ONE) / den;
    let d2 = d1 - den;

    let n_d1 = normal_cdf(d1);
    let n_d2 = normal_cdf(d2);

    let term1 = (spot * n_d1) / ONE;
    let term2 = (strike * n_d2) / ONE;

    if term1 > term2 {
        term1 - term2
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    #[test]
    fn test_normal_cdf() {
        // N(0) = 0.5
        let n0 = normal_cdf(0);
        assert_eq!(n0, ONE / 2);
    }
}
