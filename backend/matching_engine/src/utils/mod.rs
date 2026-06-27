//! # Utilities Module
//!
//! Common utilities for the matching engine.

use std::time::{SystemTime, UNIX_EPOCH};

/// Get current timestamp in milliseconds
pub fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Get current timestamp in seconds
pub fn current_timestamp_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Normalize price to tick
pub fn price_to_tick(price: u128, tick_spacing: i32) -> i32 {
    // Simplified tick calculation
    // In production, this would use proper logarithmic tick math
    (price as i32) / tick_spacing
}

/// Normalize tick to price
pub fn tick_to_price(tick: i32, tick_spacing: i32) -> u128 {
    // Simplified price calculation
    (tick * tick_spacing) as u128
}

/// Calculate fee amount
pub fn calculate_fee(amount: u128, fee_bps: u32) -> Option<u128> {
    if fee_bps > 10_000 {
        return None;
    }
    amount.checked_mul(fee_bps as u128).map(|prod| prod / 10_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timestamp() {
        let ts = current_timestamp_ms();
        assert!(ts > 0);
    }

    #[test]
    fn test_fee_calculation() {
        let fee = calculate_fee(1000, 30); // 0.3% fee
        assert_eq!(fee, Some(3));
    }

    #[test]
    fn test_checked_fee_calculator() {
        // Zero amount
        assert_eq!(calculate_fee(0, 30), Some(0));

        // Tiny amount
        assert_eq!(calculate_fee(1, 30), Some(0));

        // Zero fee basis points
        assert_eq!(calculate_fee(1000, 0), Some(0));

        // Upper-bound fee basis points (10,000 bps = 100%)
        assert_eq!(calculate_fee(1000, 10_000), Some(1000));

        // Exceeding upper-bound fee basis points (> 10,000 bps)
        assert_eq!(calculate_fee(1000, 10_001), None);

        // Very large amount without overflow
        let large_amount = u128::MAX / 10_000;
        assert_eq!(calculate_fee(large_amount, 10_000), Some(large_amount));

        // Overflow-adjacent values / rounding checks
        // 9999 amount with 1 bps: 9999 * 1 / 10000 = 0 (truncation check)
        assert_eq!(calculate_fee(9999, 1), Some(0));
        assert_eq!(calculate_fee(10000, 1), Some(1));
        assert_eq!(calculate_fee(10001, 1), Some(1));

        // Overflow boundary tests
        // u128::MAX with 1 bps (does not overflow product because u128::MAX * 1 fits u128)
        assert_eq!(calculate_fee(u128::MAX, 1), Some(u128::MAX / 10_000));
        // u128::MAX with 10 bps (overflows product because u128::MAX * 10 > u128::MAX)
        assert_eq!(calculate_fee(u128::MAX, 10), None);
    }

    mod tick_property_tests {
        use super::*;

        /// Tolerances for round-trip conversion on representative input ranges.
        /// Exact inversion is generally impossible because integer division truncates.
        const ABSOLUTE_TICK_TOLERANCE: i32 = 1;
        const ABSOLUTE_PRICE_TOLERANCE: u128 = tick_spacing_to_max_price_error(1);

        const fn tick_spacing_to_max_price_error(spacing: i32) -> u128 {
            if spacing > 1 { spacing as u128 } else { 1 }
        }

        #[test]
        fn round_trip_price_to_tick_then_back() {
            // Typical prices around 1_000 with common spacings
            let spacings = [1, 10, 60, 100];
            let prices = [1u128, 50, 100, 999, 1_000, 10_000, 1_000_000];

            for &spacing in &spacings {
                for &price in &prices {
                    // Price must be non-negative and fit u128; spacing must be positive.
                    let tick = price_to_tick(price, spacing);
                    let recovered =
                        tick_to_price(tick, spacing);

                    let max_price_error = tick_spacing_to_max_price_error(spacing);
                    let price_diff = (price as i128 - recovered as i128).abs() as u128;
                    assert!(
                        price_diff <= max_price_error,
                        "price={price}, spacing={spacing}: recovered={recovered}, error={price_diff} > {max_price_error}",
                    );
                }
            }
        }

        #[test]
        fn round_trip_tick_to_price_then_back() {
            // Typical tick ranges with common spacings
            let spacings = [1, 10, 60, 100];
            let ticks = [-10_000i32, -100, -1, 0, 1, 100, 1_000, 10_000];

            for &spacing in &spacings {
                for &tick in &ticks {
                    let price = tick_to_price(tick, spacing);
                    let recovered = price_to_tick(price, spacing);
                    let tick_diff = (tick - recovered).abs();

                    assert!(
                        tick_diff <= ABSOLUTE_TICK_TOLERANCE,
                        "tick={tick}, spacing={spacing}: recovered={recovered}, error={tick_diff} > {ABSOLUTE_TICK_TOLERANCE}",
                    );
                }
            }
        }

        #[test]
        fn monotonicity() {
            // Larger prices should produce larger tick values.
            let prices = [100u128, 200, 300, 400];
            let spacing = 60;

            let mut prev_tick = None;
            for &price in &prices {
                let tick = price_to_tick(price, spacing);
                if let Some(prev) = prev_tick {
                    assert!(tick >= prev, "tick is not monotonic: prev={prev}, cur={tick}");
                }
                prev_tick = Some(tick);
            }
        }

        #[test]
        fn large_values_within_int32() {
            // The current helpers cast through `i32`, so the meaningful large-value boundary is `i32::MAX`.
            let price = i32::MAX as u128;
            let spacing = 1;
            let tick = price_to_tick(price, spacing);
            let recovered = tick_to_price(tick, spacing);
            let price_diff = (price as i128 - recovered as i128).abs() as u128;
            let max_price_error = tick_spacing_to_max_price_error(spacing);
            assert!(
                price_diff <= max_price_error,
                "large price round-trip exceeded tolerance"
            );
        }
    }

    #[test]
    fn test_price_tick_conversion() {
        let tick = price_to_tick(100, 60);
        assert_eq!(tick, 1);

        let price = tick_to_price(1, 60);
        assert_eq!(price, 60);
    }
}
