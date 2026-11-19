//! Validation of auction configuration (#1477).
//!
//! An auction is only meaningful if its price curve, length, inventory and
//! start time make sense *together*: a zero-length auction has no curve, a
//! floor above the start price runs backwards, a non-positive floor means the
//! lot can be taken for free, and an empty lot has nothing to sell. Each
//! parameter can look fine on its own, so they are checked as one set.

use crate::AuctionError;

/// Upper bound for `floor_discount_bps`: a 100% discount makes the floor
/// price zero, i.e. collateral for free.
pub const MAX_FLOOR_DISCOUNT_BPS: u32 = 9_999;
/// A penalty above 100% of the repaid debt would charge the buyer more than
/// the debt itself.
pub const MAX_PENALTY_BPS: u32 = 10_000;

/// Everything that defines one auction's economics.
#[derive(Clone, Copy, Debug)]
pub struct AuctionConfig {
    /// Price at the start, per unit of collateral (scaled 1e7).
    pub start_price: i128,
    /// Lowest price the auction decays to (scaled 1e7).
    pub floor_price: i128,
    /// Seconds over which the price decays from start to floor.
    pub duration: u64,
    /// Collateral on offer.
    pub inventory: i128,
    /// Debt the sale has to cover.
    pub debt_to_cover: i128,
    /// Timestamp at which the auction starts.
    pub start_time: u64,
}

/// Validates an auction configuration as a whole.
///
/// # Errors
/// [`AuctionError::InvalidConfig`] when any of these holds:
/// * `duration == 0`
/// * `inventory <= 0` or `debt_to_cover <= 0`
/// * `floor_price <= 0`
/// * `start_price < floor_price` (inverted prices; equal prices are a valid
///   fixed-price sale)
/// * `start_time + duration` does not fit a `u64` (the end time is
///   unrepresentable)
pub fn validate_auction_config(config: &AuctionConfig) -> Result<(), AuctionError> {
    if config.duration == 0 {
        return Err(AuctionError::InvalidConfig);
    }
    if config.inventory <= 0 || config.debt_to_cover <= 0 {
        return Err(AuctionError::InvalidConfig);
    }
    if config.floor_price <= 0 {
        return Err(AuctionError::InvalidConfig);
    }
    if config.start_price < config.floor_price {
        return Err(AuctionError::InvalidConfig);
    }
    if config.start_time.checked_add(config.duration).is_none() {
        return Err(AuctionError::InvalidConfig);
    }
    Ok(())
}

/// Validates the global parameters every future auction is derived from.
///
/// Rejecting these at `initialize` / `update_params` stops a bad setting from
/// silently turning every later auction into an impossible one.
pub fn validate_params(
    auction_duration: u64,
    floor_discount_bps: u32,
    penalty_bps: u32,
) -> Result<(), AuctionError> {
    if auction_duration == 0
        || floor_discount_bps > MAX_FLOOR_DISCOUNT_BPS
        || penalty_bps > MAX_PENALTY_BPS
    {
        return Err(AuctionError::InvalidConfig);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> AuctionConfig {
        AuctionConfig {
            start_price: 12_000_000,
            floor_price: 9_000_000,
            duration: 3_600,
            inventory: 1_000,
            debt_to_cover: 800,
            start_time: 1_000,
        }
    }

    #[test]
    fn a_valid_configuration_is_accepted() {
        assert_eq!(validate_auction_config(&valid()), Ok(()));
    }

    #[test]
    fn equal_start_and_floor_is_a_valid_fixed_price_sale() {
        let config = AuctionConfig {
            start_price: 9_000_000,
            ..valid()
        };
        assert_eq!(validate_auction_config(&config), Ok(()));
    }

    #[test]
    fn zero_duration_is_rejected() {
        let config = AuctionConfig {
            duration: 0,
            ..valid()
        };
        assert_eq!(
            validate_auction_config(&config),
            Err(AuctionError::InvalidConfig)
        );
    }

    #[test]
    fn inverted_prices_are_rejected() {
        let config = AuctionConfig {
            start_price: 8_999_999,
            ..valid()
        };
        assert_eq!(
            validate_auction_config(&config),
            Err(AuctionError::InvalidConfig)
        );
    }

    #[test]
    fn non_positive_floor_is_rejected() {
        for floor in [0, -1, i128::MIN] {
            let config = AuctionConfig {
                floor_price: floor,
                ..valid()
            };
            assert_eq!(
                validate_auction_config(&config),
                Err(AuctionError::InvalidConfig),
                "floor {floor}"
            );
        }
    }

    #[test]
    fn empty_or_negative_inventory_is_rejected() {
        for inventory in [0, -1, i128::MIN] {
            let config = AuctionConfig {
                inventory,
                ..valid()
            };
            assert_eq!(
                validate_auction_config(&config),
                Err(AuctionError::InvalidConfig),
                "inventory {inventory}"
            );
        }
    }

    #[test]
    fn nothing_to_cover_is_rejected() {
        for debt in [0, -5] {
            let config = AuctionConfig {
                debt_to_cover: debt,
                ..valid()
            };
            assert_eq!(
                validate_auction_config(&config),
                Err(AuctionError::InvalidConfig)
            );
        }
    }

    #[test]
    fn an_unrepresentable_end_time_is_rejected() {
        let config = AuctionConfig {
            start_time: u64::MAX,
            duration: 1,
            ..valid()
        };
        assert_eq!(
            validate_auction_config(&config),
            Err(AuctionError::InvalidConfig)
        );
        // The last representable end time is fine.
        let config = AuctionConfig {
            start_time: u64::MAX - 10,
            duration: 10,
            ..valid()
        };
        assert_eq!(validate_auction_config(&config), Ok(()));
    }

    #[test]
    fn the_whole_configuration_is_checked_not_each_field_alone() {
        // Every field is individually plausible, but together the auction
        // runs backwards.
        let config = AuctionConfig {
            start_price: 1,
            floor_price: 2,
            ..valid()
        };
        assert_eq!(
            validate_auction_config(&config),
            Err(AuctionError::InvalidConfig)
        );
    }

    #[test]
    fn params_reject_zero_duration_free_floor_and_oversized_penalty() {
        assert_eq!(validate_params(3_600, 1_000, 500), Ok(()));
        assert_eq!(validate_params(3_600, 9_999, 10_000), Ok(()));
        assert_eq!(
            validate_params(0, 1_000, 500),
            Err(AuctionError::InvalidConfig)
        );
        assert_eq!(
            validate_params(3_600, 10_000, 500),
            Err(AuctionError::InvalidConfig)
        );
        assert_eq!(
            validate_params(3_600, 1_000, 10_001),
            Err(AuctionError::InvalidConfig)
        );
    }
}
