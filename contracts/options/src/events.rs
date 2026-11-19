//! Versioned lifecycle events for option positions (#1467).
//!
//! Every position transition publishes one event with a stable shape:
//!
//! - topics: `(kind, option_id, schema_version)`
//! - data: [`OptionLifecycleEvent`]
//!
//! `kind` is one of `create`, `fill`, `exercise`, `expire`, or `cancel`.
//! `fill` means a partial exercise consumed part of the remaining collateral;
//! `exercise` means the position was fully exercised.

use soroban_sdk::{contracttype, symbol_short, Address, Env, Symbol};

use crate::storage::{OptionData, OptionType};

/// Current schema version for every option lifecycle event.
pub const OPTION_EVENT_SCHEMA_VERSION: u32 = 1;

/// Payload shared by every versioned option lifecycle event.
///
/// Amounts are in the collateral asset's base units. `amount` is the amount
/// moved by this transition, `exercised_amount` is cumulative for the position,
/// and `remaining_collateral` is what still backs the position afterwards.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OptionLifecycleEvent {
    pub schema_version: u32,
    pub option_id: u32,
    pub option_type: OptionType,
    pub minter: Address,
    pub actor: Address,
    pub underlying_asset: Address,
    pub quote_asset: Address,
    pub collateral_asset: Address,
    pub strike_price: i128,
    pub opening_time: u64,
    pub expiration_time: u64,
    pub collateral_amount: i128,
    pub amount: i128,
    pub exercised_amount: i128,
    pub remaining_collateral: i128,
    pub timestamp: u64,
}

fn build_event(
    env: &Env,
    option_id: u32,
    option: &OptionData,
    actor: Address,
    amount: i128,
    exercised_amount: i128,
    remaining_collateral: i128,
) -> OptionLifecycleEvent {
    let option_type = option.option_type.clone();
    let collateral_asset = match &option_type {
        OptionType::Call => option.underlying_asset.clone(),
        OptionType::Put => option.quote_asset.clone(),
    };

    OptionLifecycleEvent {
        schema_version: OPTION_EVENT_SCHEMA_VERSION,
        option_id,
        option_type,
        minter: option.minter.clone(),
        actor,
        underlying_asset: option.underlying_asset.clone(),
        quote_asset: option.quote_asset.clone(),
        collateral_asset,
        strike_price: option.strike_price,
        opening_time: option.opening_time,
        expiration_time: option.expiration_time,
        collateral_amount: option.collateral_amount,
        amount,
        exercised_amount,
        remaining_collateral,
        timestamp: env.ledger().timestamp(),
    }
}

fn emit(env: &Env, kind: Symbol, event: OptionLifecycleEvent) {
    env.events()
        .publish((kind, event.option_id, OPTION_EVENT_SCHEMA_VERSION), event);
}

/// Emits the `create` event after a position is minted and collateral is escrowed.
pub fn emit_created(env: &Env, option_id: u32, option: &OptionData) {
    let event = build_event(
        env,
        option_id,
        option,
        option.minter.clone(),
        option.collateral_amount,
        0,
        option.collateral_amount,
    );
    emit(env, symbol_short!("create"), event);
}

/// Emits a `fill` event for a partial exercise that leaves the position open.
pub fn emit_filled(
    env: &Env,
    option_id: u32,
    option: &OptionData,
    exerciser: Address,
    amount: i128,
    exercised_amount: i128,
) {
    let remaining = option.collateral_amount.saturating_sub(exercised_amount);
    let event = build_event(
        env,
        option_id,
        option,
        exerciser,
        amount,
        exercised_amount,
        remaining,
    );
    emit(env, symbol_short!("fill"), event);
}

/// Emits an `exercise` event when the position has been fully exercised.
pub fn emit_exercised(
    env: &Env,
    option_id: u32,
    option: &OptionData,
    exerciser: Address,
    amount: i128,
    exercised_amount: i128,
) {
    let remaining = option.collateral_amount.saturating_sub(exercised_amount);
    let event = build_event(
        env,
        option_id,
        option,
        exerciser,
        amount,
        exercised_amount,
        remaining,
    );
    emit(env, symbol_short!("exercise"), event);
}

/// Emits the `expire` event after the unexercised collateral is returned.
pub fn emit_expired(
    env: &Env,
    option_id: u32,
    option: &OptionData,
    returned: i128,
    exercised_amount: i128,
) {
    let event = build_event(
        env,
        option_id,
        option,
        option.minter.clone(),
        returned,
        exercised_amount,
        0,
    );
    emit(env, symbol_short!("expire"), event);
}

/// Emits the `cancel` event after the unexercised collateral is returned.
pub fn emit_cancelled(
    env: &Env,
    option_id: u32,
    option: &OptionData,
    returned: i128,
    exercised_amount: i128,
) {
    let event = build_event(
        env,
        option_id,
        option,
        option.minter.clone(),
        returned,
        exercised_amount,
        0,
    );
    emit(env, symbol_short!("cancel"), event);
}
