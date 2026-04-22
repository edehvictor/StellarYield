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
pub fn calculate_fee(amount: u128, fee_bps: u32) -> u128 {
    amount * (fee_bps as u128) / 10_000
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
    fn test_price_tick_conversion() {
        let tick = price_to_tick(100, 60);
        assert_eq!(tick, 1);

        let price = tick_to_price(1, 60);
        assert_eq!(price, 60);
    }

    #[test]
    fn test_fee_calculation() {
        let fee = calculate_fee(1000, 30); // 0.3% fee
        assert_eq!(fee, 3);
    }
}
