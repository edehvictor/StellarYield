//! Clock policy for oracle price observations.
//!
//! Collateral is valued from an oracle quote `(price, observed_at)`. A quote is
//! only usable when `observed_at` sits inside a window anchored on the ledger
//! time `now`:
//!
//! ```text
//!   observed_at < now - MAX_PRICE_AGE_SECS      -> PriceStale
//!   now - MAX_PRICE_AGE_SECS <= observed_at <= now + MAX_PRICE_FUTURE_SKEW_SECS
//!                                               -> accepted
//!   observed_at > now + MAX_PRICE_FUTURE_SKEW_SECS -> PriceFromFuture
//! ```
//!
//! Both ends of the accepted window are inclusive. A future-dated quote must
//! never be accepted: its age would read as "fresh" forever, so a price that
//! was stamped ahead of time could keep valuing collateral long after it
//! stopped being true.

use crate::Error;

/// Oldest an observation may be, in seconds. A quote exactly this old is still
/// accepted; one second older is [`Error::PriceStale`].
pub const MAX_PRICE_AGE_SECS: u64 = 3600;

/// How far ahead of ledger time an observation may be stamped, in seconds.
///
/// Zero means no tolerance: an observation must not be later than the ledger
/// timestamp. Raising this widens the window for oracle clock drift, but every
/// second of tolerance is a second a quote can be pre-dated, so it should stay
/// at zero unless the oracle is known to run ahead of the ledger.
pub const MAX_PRICE_FUTURE_SKEW_SECS: u64 = 0;

/// Check an observation timestamp against the ledger time.
///
/// Pure and overflow-free: it uses saturating arithmetic only, so no `u64`
/// input (including `u64::MAX`) can make it panic.
///
/// The future check runs first. A future-dated quote is reported as
/// [`Error::PriceFromFuture`], never as a (nonsensical) negative age.
///
/// # Errors
/// * [`Error::PriceFromFuture`] when `observed_at` is later than
///   `now + MAX_PRICE_FUTURE_SKEW_SECS`.
/// * [`Error::PriceStale`] when the observation is older than
///   [`MAX_PRICE_AGE_SECS`].
pub fn validate_observation(now: u64, observed_at: u64) -> Result<(), Error> {
    if observed_at > now.saturating_add(MAX_PRICE_FUTURE_SKEW_SECS) {
        return Err(Error::PriceFromFuture);
    }
    if now.saturating_sub(observed_at) > MAX_PRICE_AGE_SECS {
        return Err(Error::PriceStale);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_000_000;

    #[test]
    fn current_observation_is_accepted() {
        assert_eq!(validate_observation(NOW, NOW), Ok(()));
    }

    #[test]
    fn observation_one_second_in_the_future_is_rejected() {
        assert_eq!(
            validate_observation(NOW, NOW + MAX_PRICE_FUTURE_SKEW_SECS + 1),
            Err(Error::PriceFromFuture)
        );
    }

    #[test]
    fn observation_at_the_future_limit_is_accepted() {
        assert_eq!(
            validate_observation(NOW, NOW + MAX_PRICE_FUTURE_SKEW_SECS),
            Ok(())
        );
    }

    #[test]
    fn observation_exactly_at_max_age_is_accepted() {
        assert_eq!(validate_observation(NOW, NOW - MAX_PRICE_AGE_SECS), Ok(()));
    }

    #[test]
    fn observation_one_second_past_max_age_is_stale() {
        assert_eq!(
            validate_observation(NOW, NOW - MAX_PRICE_AGE_SECS - 1),
            Err(Error::PriceStale)
        );
    }

    #[test]
    fn extreme_timestamps_do_not_overflow_or_panic() {
        assert_eq!(
            validate_observation(NOW, u64::MAX),
            Err(Error::PriceFromFuture)
        );
        assert_eq!(validate_observation(u64::MAX, u64::MAX), Ok(()));
        assert_eq!(validate_observation(u64::MAX, 0), Err(Error::PriceStale));
        assert_eq!(validate_observation(0, 0), Ok(()));
    }

    #[test]
    fn ledger_time_younger_than_max_age_does_not_underflow() {
        // now < MAX_PRICE_AGE_SECS: a naive `now - MAX_PRICE_AGE_SECS` would wrap.
        assert_eq!(validate_observation(100, 0), Ok(()));
        assert_eq!(validate_observation(100, 100), Ok(()));
    }
}
