//! Price decay math for the Dutch Auction.
//!
//! The auction price decays linearly from `start_price` to `floor_price`
//! over `duration` seconds. After duration elapses, the price stays at floor.
//!
//! All arithmetic is checked: no input combination can overflow silently or
//! trap, and the interpolation itself never overflows for any representable
//! `start_price`, `floor_price` and `duration` (see [`mul_div_floor`]).

/// `floor(value * numerator / denominator)` for `numerator < denominator`,
/// without a 256-bit intermediate.
///
/// Splitting `value = q * denominator + r` gives
/// `value * numerator / denominator = q * numerator + r * numerator / denominator`.
/// Because `numerator < denominator`: `q * numerator <= value` (cannot
/// overflow) and `r < denominator <= u64::MAX`, `numerator < u64::MAX`, so
/// `r * numerator < 2^128` (cannot overflow `u128`). The result is exactly the
/// floor of the true quotient.
///
/// Returns `None` only for `denominator == 0` or `numerator >= denominator`.
fn mul_div_floor(value: u128, numerator: u64, denominator: u64) -> Option<u128> {
    if denominator == 0 || numerator >= denominator {
        return None;
    }
    let denominator = denominator as u128;
    let numerator = numerator as u128;
    let q = value / denominator;
    let r = value % denominator;
    q.checked_mul(numerator)?
        .checked_add(r.checked_mul(numerator)? / denominator)
}

/// Calculate the current auction price based on linear decay, or `None` if the
/// result is not representable as an `i128`.
///
/// ```text
/// price(t) = start_price - (start_price - floor_price) * elapsed / duration
/// ```
///
/// Clamped to floor_price after duration. A zero `duration` means the
/// auction has already fully decayed, so the floor applies.
///
/// The only way to get `None` is a price range that itself does not fit an
/// `i128` (for example `start_price = i128::MAX`, `floor_price = i128::MIN`),
/// which is not a valid auction. Whenever the range fits, the result is exact
/// (rounded toward the start price) for any `duration` up to `u64::MAX`.
///
/// # Arguments
/// * `start_price` — Starting price (above oracle, scaled 1e7)
/// * `floor_price` — Floor price (below oracle, scaled 1e7)
/// * `start_time` — Auction start timestamp
/// * `duration` — Auction duration in seconds
/// * `now` — Current timestamp
///
/// # Returns
/// Current price (scaled 1e7)
pub fn checked_current_price(
    start_price: i128,
    floor_price: i128,
    start_time: u64,
    duration: u64,
    now: u64,
) -> Option<i128> {
    if now < start_time {
        return Some(start_price);
    }

    if duration == 0 {
        return Some(floor_price);
    }

    if now == start_time {
        return Some(start_price);
    }

    let elapsed = now - start_time;

    if elapsed >= duration {
        return Some(floor_price);
    }

    // `elapsed < duration` from here, so `duration > 0`.
    let price_range = start_price.checked_sub(floor_price)?;
    let decay = mul_div_floor(price_range.unsigned_abs(), elapsed, duration)?;
    let decay = i128::try_from(decay).ok()?;

    if price_range >= 0 {
        start_price.checked_sub(decay)
    } else {
        // Inverted prices (floor above start) rise instead of decay.
        start_price.checked_add(decay)
    }
}

/// Same as [`checked_current_price`] for callers that treat an unrepresentable
/// range as a bug. Contract code uses the checked variant and returns an error.
#[allow(dead_code)]
pub fn get_current_price(
    start_price: i128,
    floor_price: i128,
    start_time: u64,
    duration: u64,
    now: u64,
) -> i128 {
    checked_current_price(start_price, floor_price, start_time, duration, now)
        .expect("auction price range overflows i128")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_price_at_start() {
        let price = get_current_price(12_000_000, 9_000_000, 100, 3600, 100);
        assert_eq!(price, 12_000_000);
    }

    #[test]
    fn test_price_before_start() {
        let price = get_current_price(12_000_000, 9_000_000, 100, 3600, 50);
        assert_eq!(price, 12_000_000);
    }

    #[test]
    fn test_price_at_halfway() {
        let price = get_current_price(12_000_000, 9_000_000, 100, 3600, 1900);
        // decay = 3M * 1800 / 3600 = 1.5M
        // price = 12M - 1.5M = 10.5M
        assert_eq!(price, 10_500_000);
    }

    #[test]
    fn test_price_at_end() {
        let price = get_current_price(12_000_000, 9_000_000, 100, 3600, 3700);
        assert_eq!(price, 9_000_000);
    }

    #[test]
    fn test_price_past_end() {
        let price = get_current_price(12_000_000, 9_000_000, 100, 3600, 99999);
        assert_eq!(price, 9_000_000);
    }

    #[test]
    fn test_price_at_quarter() {
        let price = get_current_price(12_000_000, 9_000_000, 0, 3600, 900);
        // decay = 3M * 900 / 3600 = 750K
        // price = 12M - 750K = 11.25M
        assert_eq!(price, 11_250_000);
    }

    // ── Overflow and monotonicity (#1476) ────────────────────────────

    /// Reference implementation with a wide intermediate, for values small
    /// enough that `range * elapsed` fits in `u128`.
    fn reference(start: i128, floor: i128, start_time: u64, duration: u64, now: u64) -> i128 {
        if now <= start_time {
            return start;
        }
        let elapsed = now - start_time;
        if elapsed >= duration {
            return floor;
        }
        let range = (start - floor) as u128;
        start - ((range * elapsed as u128) / duration as u128) as i128
    }

    #[test]
    fn matches_wide_reference_across_a_grid() {
        for &(start, floor) in &[
            (12_000_000i128, 9_000_000i128),
            (1, 0),
            (i64::MAX as i128, 1),
            (1_000_000_000_000_000_000_000, 7),
        ] {
            for &duration in &[1u64, 2, 3, 3600, 86_400, 1 << 40] {
                for step in 0..=20u64 {
                    let now = 1_000 + duration / 20 * step + step;
                    assert_eq!(
                        checked_current_price(start, floor, 1_000, duration, now),
                        Some(reference(start, floor, 1_000, duration, now)),
                        "start={start} floor={floor} duration={duration} now={now}"
                    );
                }
            }
        }
    }

    #[test]
    fn maximum_range_and_duration_do_not_overflow() {
        // Range of i128::MAX over u64::MAX seconds: the naive
        // `range * elapsed` needs ~191 bits.
        let start = i128::MAX;
        let floor = 0;
        let duration = u64::MAX;
        for &elapsed in &[1u64, 2, u64::MAX / 2, u64::MAX - 2, u64::MAX - 1] {
            let price = checked_current_price(start, floor, 0, duration, elapsed)
                .expect("a representable range never overflows");
            assert!(
                (floor..=start).contains(&price),
                "price {price} left [{floor}, {start}] at elapsed {elapsed}"
            );
        }
        assert_eq!(
            checked_current_price(start, floor, 0, duration, 0),
            Some(start)
        );
        assert_eq!(
            checked_current_price(start, floor, 0, duration, u64::MAX),
            Some(floor)
        );
    }

    #[test]
    fn maximum_values_are_exact_at_the_midpoint() {
        // range = 2^127 - 1 (odd), halfway through a 2-second auction: the
        // decay is floor(range / 2).
        let price = checked_current_price(i128::MAX, 0, 0, 2, 1).unwrap();
        // decay = floor((2^127 - 1) / 2) = 2^126 - 1
        assert_eq!(price, i128::MAX - ((i128::MAX) / 2));
    }

    #[test]
    fn extreme_timestamps_do_not_overflow() {
        // start_time near u64::MAX, now at u64::MAX: elapsed is tiny.
        assert_eq!(
            checked_current_price(100, 0, u64::MAX - 10, u64::MAX, u64::MAX),
            Some(100 - (100u128 * 10 / u64::MAX as u128) as i128)
        );
        // now before start at the extremes.
        assert_eq!(checked_current_price(100, 0, u64::MAX, 10, 0), Some(100));
        // A zero-duration auction is already fully decayed at its start time.
        assert_eq!(checked_current_price(100, 40, 5, 0, 6), Some(40));
        assert_eq!(checked_current_price(100, 40, 5, 0, 5), Some(40));
        assert_eq!(checked_current_price(100, 40, 5, 0, 4), Some(100));
    }

    #[test]
    fn negative_prices_and_full_signed_range_are_handled() {
        // Negative floor: range = 100 - (-100) = 200.
        assert_eq!(checked_current_price(100, -100, 0, 4, 1), Some(50));
        assert_eq!(checked_current_price(100, -100, 0, 4, 2), Some(0));
        // i128::MAX down to -1 is a range of 2^127, one more than an i128 holds.
        assert_eq!(checked_current_price(i128::MAX, -1, 0, 10, 5), None);
    }

    #[test]
    fn unrepresentable_range_is_none_not_a_panic() {
        assert_eq!(
            checked_current_price(i128::MAX, i128::MIN, 0, 100, 50),
            None
        );
        assert_eq!(
            checked_current_price(i128::MIN, i128::MAX, 0, 100, 50),
            None
        );
        assert_eq!(checked_current_price(i128::MAX, -1, 0, 100, 50), None);
        // Outside the decay window the range is never computed, so the answer is exact.
        assert_eq!(
            checked_current_price(i128::MAX, i128::MIN, 10, 100, 5),
            Some(i128::MAX)
        );
        assert_eq!(
            checked_current_price(i128::MAX, i128::MIN, 0, 100, 100),
            Some(i128::MIN)
        );
    }

    #[test]
    fn inverted_prices_rise_and_never_overflow() {
        // floor above start: price moves up toward the floor.
        assert_eq!(
            checked_current_price(0, i128::MAX, 0, 2, 1),
            Some(i128::MAX / 2)
        );
        let mut last = i128::MIN;
        for step in 0..=50u64 {
            let p = checked_current_price(10, 1_000_000_000_000, 0, 50, step).unwrap();
            assert!(p >= last, "inverted price must be non-decreasing");
            last = p;
        }
    }

    #[test]
    fn price_is_monotonically_non_increasing_over_time() {
        for &(start, floor, duration) in &[
            (12_000_000i128, 9_000_000i128, 3600u64),
            (i128::MAX, 0, u64::MAX),
            (i128::MAX, 1, 7),
            (1, 0, u64::MAX),
            (1_000_000_000_000_000_000_000_000, 3, 1 << 33),
        ] {
            // Sample the whole window plus both edges and just past the end.
            let mut times = [0u64; 143];
            for i in 0..=100u64 {
                times[i as usize] = duration / 100 * i;
            }
            for i in 0..=20u64 {
                times[101 + i as usize] = i;
                times[122 + i as usize] = duration.saturating_sub(i);
            }
            times[142] = duration.saturating_add(1);

            // For every pair, a later time must never give a higher price.
            for &t1 in times.iter() {
                let p1 = checked_current_price(start, floor, 0, duration, t1).unwrap();
                assert!(p1 >= floor && p1 <= start);
                for &t2 in times.iter() {
                    if t2 >= t1 {
                        let p2 = checked_current_price(start, floor, 0, duration, t2).unwrap();
                        assert!(
                            p2 <= p1,
                            "price rose from {p1} at t={t1} to {p2} at t={t2} (start={start}, floor={floor}, duration={duration})"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn price_never_leaves_the_start_floor_band() {
        // Pseudo-random sweep (deterministic LCG, no extra dependencies).
        let mut x: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for _ in 0..2_000 {
            let floor = (next() as i128) << (next() % 60);
            let range = ((next() as u128) << (next() % 60)) as i128 & i128::MAX;
            let Some(start) = floor.checked_add(range) else {
                continue;
            };
            let duration = next() % u64::MAX + 1;
            let start_time = next() / 2;
            let now = start_time.saturating_add(next() % duration.saturating_add(1));
            let price = checked_current_price(start, floor, start_time, duration, now).unwrap();
            assert!(
                price >= floor && price <= start,
                "{price} outside [{floor}, {start}]"
            );
        }
    }

    #[test]
    fn mul_div_floor_is_exact_and_rejects_bad_inputs() {
        assert_eq!(mul_div_floor(10, 1, 3), Some(3));
        assert_eq!(mul_div_floor(u128::MAX, 1, 2), Some(u128::MAX / 2));
        // Exact against a plain u128 computation wherever that cannot overflow.
        for value in [0u128, 1, 7, 1_000_003, u64::MAX as u128] {
            for denominator in [1u64, 2, 3, 7, 1_000, u32::MAX as u64, u64::MAX] {
                for numerator in [0u64, 1, denominator / 2, denominator.saturating_sub(1)] {
                    if numerator >= denominator {
                        continue;
                    }
                    assert_eq!(
                        mul_div_floor(value, numerator, denominator),
                        Some(value * numerator as u128 / denominator as u128)
                    );
                }
            }
        }
        // The result never exceeds the input (numerator < denominator).
        assert!(mul_div_floor(u128::MAX, u64::MAX - 1, u64::MAX).unwrap() < u128::MAX);
        assert_eq!(mul_div_floor(5, 1, 0), None);
        assert_eq!(mul_div_floor(5, 3, 3), None);
        assert_eq!(mul_div_floor(5, 4, 3), None);
    }
}
