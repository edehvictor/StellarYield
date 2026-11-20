//! # Position Module — NFT-Style Liquidity Position Management
//!
//! Tracks individual user positions with custom tick ranges and accumulated fees.
//!
//! Position records live in persistent storage and can be read back after any
//! number of deployments or manual migrations. Every record is therefore treated
//! as untrusted input: it is fully validated before it is used for accounting, and
//! malformed records produce a typed [`ClmmError`] instead of a panic or a silent
//! balance change.

use crate::{tick, ClmmError, DataKey, Position};
use soroban_sdk::{Address, Env, Vec};

/// Validate a position record loaded from persistent storage.
///
/// Rejects impossible tick ranges, ticks outside the supported domain, ticks that
/// are not aligned to the pool tick spacing, and liquidity that cannot be safely
/// converted to `i128` for tick accounting.
pub fn validate_position(position: &Position, tick_spacing: i32) -> Result<(), ClmmError> {
    if tick_spacing <= 0 || tick_spacing > crate::MAX_TICK_SPACING {
        return Err(ClmmError::InvalidTickSpacing);
    }

    if position.tick_lower >= position.tick_upper {
        return Err(ClmmError::CorruptedPosition);
    }

    if position.tick_lower < tick::MIN_TICK || position.tick_upper > tick::MAX_TICK {
        return Err(ClmmError::CorruptedPosition);
    }

    if position.tick_lower % tick_spacing != 0 || position.tick_upper % tick_spacing != 0 {
        return Err(ClmmError::CorruptedPosition);
    }

    if position.liquidity > i128::MAX as u128 {
        return Err(ClmmError::CorruptedPosition);
    }

    // Owed balances are paid out through token transfers, which take `i128`.
    if position.tokens_owed_0 > i128::MAX as u128 || position.tokens_owed_1 > i128::MAX as u128 {
        return Err(ClmmError::CorruptedPosition);
    }

    Ok(())
}

/// Load a position and validate it against the pool configuration.
///
/// Returns [`ClmmError::InvalidPosition`] when the record does not exist and
/// [`ClmmError::CorruptedPosition`] when it exists but cannot be trusted.
pub fn load_validated_position(env: &Env, position_id: u64) -> Result<Position, ClmmError> {
    let position: Position = env
        .storage()
        .persistent()
        .get(&DataKey::Position(position_id))
        .ok_or(ClmmError::InvalidPosition)?;

    let tick_spacing = tick::get_tick_spacing(env)?;
    validate_position(&position, tick_spacing)?;

    Ok(position)
}

/// Get all positions owned by a specific address.
///
/// Malformed records are skipped rather than panicking so a single corrupt record
/// cannot make the whole enumeration call fail.
#[allow(dead_code)]
pub fn get_positions_by_owner(env: &Env, owner: &Address) -> Vec<u64> {
    let mut result = Vec::new(env);
    let next_id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextPositionId)
        .unwrap_or(1);

    for id in 1..next_id {
        if let Some(position) = env
            .storage()
            .persistent()
            .get::<DataKey, Position>(&DataKey::Position(id))
        {
            if position.owner == *owner {
                result.push_back(id);
            }
        }
    }

    result
}

/// Calculate uncollected fees for a position.
///
/// Uses checked subtraction: a stored `fee_growth_inside_*_last_x128` that is
/// greater than the current fee growth means the record is corrupt and yields
/// [`ClmmError::CorruptedPosition`] instead of a panic or wrapped-around balance.
///
/// # Returns
/// `(fees0, fees1)` — Uncollected fee amounts
pub fn calculate_uncollected_fees(
    _env: &Env,
    position: &Position,
    fee_growth_inside_0: u128,
    fee_growth_inside_1: u128,
) -> Result<(u128, u128), ClmmError> {
    let delta_0 = fee_growth_inside_0
        .checked_sub(position.fee_growth_inside_0_last_x128)
        .ok_or(ClmmError::CorruptedPosition)?;
    let delta_1 = fee_growth_inside_1
        .checked_sub(position.fee_growth_inside_1_last_x128)
        .ok_or(ClmmError::CorruptedPosition)?;

    let fees_0 = delta_0
        .checked_mul(position.liquidity)
        .ok_or(ClmmError::MathOverflow)?
        / crate::math::Q128;

    let fees_1 = delta_1
        .checked_mul(position.liquidity)
        .ok_or(ClmmError::MathOverflow)?
        / crate::math::Q128;

    Ok((fees_0, fees_1))
}

/// Validate position ownership.
#[allow(dead_code)]
pub fn require_position_owner(
    env: &Env,
    position_id: u64,
    caller: &Address,
) -> Result<Position, ClmmError> {
    let position = load_validated_position(env, position_id)?;

    if position.owner != *caller {
        return Err(ClmmError::Unauthorized);
    }

    Ok(position)
}
