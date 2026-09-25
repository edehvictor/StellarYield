//! # Position Module — NFT-Style Liquidity Position Management
//!
//! Tracks individual user positions with custom tick ranges and accumulated fees.

use crate::{ClmmError, DataKey, Position};
use soroban_sdk::{Address, Env, Vec};

/// Get all positions owned by a specific address.
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
/// # Returns
/// (fees0, fees1) — Uncollected fee amounts
#[allow(dead_code)]
pub fn calculate_uncollected_fees(
    _env: &Env,
    position: &Position,
    fee_growth_inside_0: u128,
    fee_growth_inside_1: u128,
) -> (u128, u128) {
    let fees_0 = ((fee_growth_inside_0.wrapping_sub(position.fee_growth_inside_0_last_x128))
        * position.liquidity)
        / crate::math::Q128;

    let fees_1 = ((fee_growth_inside_1.wrapping_sub(position.fee_growth_inside_1_last_x128))
        * position.liquidity)
        / crate::math::Q128;

    (fees_0, fees_1)
}

/// Validate position ownership.
#[allow(dead_code)]
pub fn require_position_owner(
    env: &Env,
    position_id: u64,
    caller: &Address,
) -> Result<Position, ClmmError> {
    let position: Position = env
        .storage()
        .persistent()
        .get(&DataKey::Position(position_id))
        .ok_or(ClmmError::InvalidPosition)?;

    if position.owner != *caller {
        return Err(ClmmError::Unauthorized);
    }

    Ok(position)
}
