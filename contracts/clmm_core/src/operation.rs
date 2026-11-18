//! # Operation Journal — resumable, retry-safe position accounting
//!
//! `mint`, `burn` and `collect` update tick, pool and position storage before
//! they can move tokens. Every state-changing entry point journals a
//! [`PendingOperation`](crate::PendingOperation) first: the entry snapshots the
//! pre-operation state and records how far the operation progressed. When a
//! step fails the journal is replayed in reverse, so accounting always matches
//! the tokens that actually moved and a retry starts from a predictable state.

use crate::{ClmmError, DataKey, OperationKind, PendingOperation, Position, TickInfo};
use soroban_sdk::{symbol_short, token, Address, Env};

/// Only the pre-operation snapshot has been written.
pub const STEP_PREPARED: u32 = 0;
/// Tick liquidity has been updated.
pub const STEP_TICKS_UPDATED: u32 = 1;
/// Pool liquidity and position accounting have been updated.
pub const STEP_ACCOUNTING_UPDATED: u32 = 2;
/// Every token transfer of the operation settled.
pub const STEP_TRANSFERS_SETTLED: u32 = 3;

/// Bit flag: the first token transfer of the operation settled.
pub const SETTLED_TOKEN_0: u32 = 1;
/// Bit flag: the second token transfer of the operation settled.
pub const SETTLED_TOKEN_1: u32 = 2;

/// Load the journal entry for `owner`, if an operation is in flight.
pub fn load(env: &Env, owner: &Address) -> Option<PendingOperation> {
    env.storage()
        .persistent()
        .get::<DataKey, PendingOperation>(&DataKey::PendingOperation(owner.clone()))
}

/// Reject a new operation while another one is journaled for `owner`.
///
/// The journal is written before any token transfer, so this also rejects
/// re-entrant calls a token contract could make while a settlement is running.
pub fn require_idle(env: &Env, owner: &Address) -> Result<(), ClmmError> {
    if load(env, owner).is_some() {
        return Err(ClmmError::OperationPending);
    }

    Ok(())
}

/// Persist a new journal entry.
pub fn begin(env: &Env, operation: PendingOperation) -> Result<(), ClmmError> {
    require_idle(env, &operation.owner)?;
    store(env, &operation);

    Ok(())
}

/// Record that `operation` reached `step`.
pub fn advance(env: &Env, operation: &mut PendingOperation, step: u32) {
    operation.step = step;
    store(env, operation);
}

/// Record that one of the operation's token transfers settled.
pub fn mark_settled(env: &Env, operation: &mut PendingOperation, flag: u32) {
    operation.transfers_settled |= flag;
    store(env, operation);
}

/// Drop the journal once the operation is fully committed.
pub fn commit(env: &Env, operation: &PendingOperation) {
    env.storage()
        .persistent()
        .remove(&DataKey::PendingOperation(operation.owner.clone()));
}

/// Restore the pre-operation state after a failed step.
///
/// Settled transfers are never repeated: deposits that already reached the pool
/// are refunded, while payouts that already reached the owner stay paid.
pub fn rollback(env: &Env, operation: &PendingOperation) {
    match operation.kind {
        OperationKind::Mint => rollback_mint(env, operation),
        OperationKind::Burn => rollback_burn(env, operation),
        OperationKind::Collect => rollback_collect(env, operation),
    }

    commit(env, operation);

    env.events().publish(
        (symbol_short!("rollback"),),
        (operation.kind, operation.position_id, operation.step),
    );
}

fn store(env: &Env, operation: &PendingOperation) {
    env.storage().persistent().set(
        &DataKey::PendingOperation(operation.owner.clone()),
        operation,
    );
}

/// Undo a mint: remove the provisional position, restore ticks, refund deposits.
fn rollback_mint(env: &Env, operation: &PendingOperation) {
    if operation.step >= STEP_ACCOUNTING_UPDATED {
        env.storage()
            .persistent()
            .remove(&DataKey::Position(operation.position_id));
        env.storage()
            .instance()
            .set(&DataKey::Liquidity, &operation.liquidity_before);
    }

    if operation.step >= STEP_TICKS_UPDATED {
        restore_tick(env, operation.tick_lower, &operation.tick_lower_before);
        restore_tick(env, operation.tick_upper, &operation.tick_upper_before);
    }

    refund(
        env,
        operation,
        SETTLED_TOKEN_0,
        &DataKey::Token0,
        operation.amount_0,
    );
    refund(
        env,
        operation,
        SETTLED_TOKEN_1,
        &DataKey::Token1,
        operation.amount_1,
    );
}

/// Undo a burn: restore the position snapshot, pool liquidity and ticks.
fn rollback_burn(env: &Env, operation: &PendingOperation) {
    if operation.step >= STEP_ACCOUNTING_UPDATED {
        if operation.has_position_before {
            env.storage().persistent().set(
                &DataKey::Position(operation.position_id),
                &operation.position_before,
            );
        }
        env.storage()
            .instance()
            .set(&DataKey::Liquidity, &operation.liquidity_before);
    }

    if operation.step >= STEP_TICKS_UPDATED {
        restore_tick(env, operation.tick_lower, &operation.tick_lower_before);
        restore_tick(env, operation.tick_upper, &operation.tick_upper_before);
    }
}

/// Undo a collect: keep settled payouts, restore only the unpaid side.
fn rollback_collect(env: &Env, operation: &PendingOperation) {
    if !operation.has_position_before {
        return;
    }
    let before = &operation.position_before;
    let Some(mut position) = env
        .storage()
        .persistent()
        .get::<DataKey, Position>(&DataKey::Position(operation.position_id))
    else {
        return;
    };

    if operation.transfers_settled & SETTLED_TOKEN_0 == 0 {
        position.tokens_owed_0 = before.tokens_owed_0;
        position.fee_growth_inside_0_last_x128 = before.fee_growth_inside_0_last_x128;
    }

    if operation.transfers_settled & SETTLED_TOKEN_1 == 0 {
        position.tokens_owed_1 = before.tokens_owed_1;
        position.fee_growth_inside_1_last_x128 = before.fee_growth_inside_1_last_x128;
    }

    env.storage()
        .persistent()
        .set(&DataKey::Position(operation.position_id), &position);
}

/// Put a tick slot back to the snapshot recorded before the operation.
fn restore_tick(env: &Env, tick: i32, snapshot: &TickInfo) {
    if snapshot.initialized && snapshot.liquidity_gross > 0 {
        env.storage()
            .persistent()
            .set(&DataKey::Tick(tick), snapshot);
    } else {
        env.storage().persistent().remove(&DataKey::Tick(tick));
    }
}

/// Send a settled deposit back to the position owner.
///
/// The transfer is best effort: on chain the whole transaction reverts together,
/// so a failure here can never leave the pool short.
fn refund(
    env: &Env,
    operation: &PendingOperation,
    settled_flag: u32,
    token_key: &DataKey,
    amount: u128,
) {
    if operation.transfers_settled & settled_flag == 0 || amount == 0 {
        return;
    }

    let Some(token_addr) = env.storage().instance().get::<DataKey, Address>(token_key) else {
        return;
    };

    let client = token::Client::new(env, &token_addr);
    let _ = client.try_transfer(
        &env.current_contract_address(),
        &operation.owner,
        &(amount as i128),
    );
}
