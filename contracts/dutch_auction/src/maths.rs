//! Price decay math for the Dutch Auction.
//!
//! The auction price decays linearly from `start_price` to `floor_price`
//! over `duration` seconds. After duration elapses, the price stays at floor.

/// Calculate the current auction price based on linear decay.
///
/// ```text
/// price(t) = start_price - (start_price - floor_price) * elapsed / duration
/// ```
///
/// Clamped to floor_price after duration.
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
pub fn get_current_price(
    start_price: i128,
    floor_price: i128,
    start_time: u64,
    duration: u64,
    now: u64,
) -> i128 {
    if now <= start_time {
        return start_price;
    }

    let elapsed = now - start_time;

    if elapsed >= duration {
        return floor_price;
    }

    let price_range = start_price - floor_price;
    let decay = (price_range * elapsed as i128) / duration as i128;

    start_price - decay
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
}
