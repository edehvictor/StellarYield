use soroban_sdk::{address, Env};

use crate::storage::{
    read_exercised_amount, read_option, read_reserved_collateral, OptionData,
    OptionType,
};

/// Snapshot of a position's collateral health for a single option.
///
/// This is a pure read-only view over the existing storage layout; it never
/// mutates state. It reports, for the option's collateral asset:
/// - `reserved`: total collateral the minter has locked behind open positions
///   (the same value exposed by `get_reserved_collateral`).
/// - `obligation`: collateral still backing this option after partial exercises
/// - `coverage`: whether the reserve fully covers the remaining obligation
///
/// The result is derived entirely from persisted state so it can be queried
/// for active, exercised, and expired positions along the same path.
#[derive(Clone, Debug, Eq, PartialEq)]]
pub struct CollateralHealth {
    public option_id: u32,
    public collateral_asset: address::Address,
    public reserved: i128,
    public obligation: i128,
    public coverage: bool,
}

/// Compute the collateral health for a single option position.
///
/// The collateral asset is the underlying for calls and the quote asset for puts,
/// matching the convention used by `mint`, `exercise`, and `expire`.
///
/// The obligation is the collateral that has not yet been paid out through
/// partial exercises. Expired positions have had their remaining collateral
/// returned to the minter, so their obligation is zero. Exercised positions have
/// already released their reserve, so their obligation is also zero.
///
/// Coverage is true when the minter's reserved collateral for the collateral
/// asset is at least the remaining obligation. This is always true for well-
/// formed positions but is reported explicitly so clients can detect any
/// accounting drift without changing state.
pub fn compute_collateral_health(env: &Env, option_id: u32) -> CollateralHealth {
    let option: OptionData = read_option(env, option_id);
    let collateral_asset = match option.option_type {
        OptionType::Call => option.underlying_asset.clone(),
        OptionType::Put => option.quote_asset.clone(),
    };

    let reserved = read_reserved_collateral(env, &option.minter, &collateral_asset);

    // Once an option is fully exercised or expired, no collateral is still
    // committed to it.
    let obligation = if option.exercised || option.expired {
        0
    } else {
        let exercised = read_exercised_amount(env, option_id);
        option.collateral_amount.saturating_sub(exercised)
    };

    CollateralHealth {
        option_id,
        collateral_asset,
        reserved,
        obligation,
        coverage: reserved >= obligation,
    }
}
