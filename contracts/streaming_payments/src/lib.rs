#![no_std]

//! # Streaming Payments (Soroban)
//!
//! A native token streaming contract for continuous payments that unlock
//! linearly over time based on the current ledger timestamp.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

#[contracttype]
pub enum InstanceKey {
    /// Next stream identifier (starts at 1).
    NextStreamId,
    /// Re-entrancy guard for the `withdraw_from_stream` call path.
    WithdrawalInProgress,
}

#[contracttype]
pub enum StreamStorageKey {
    Stream(u64),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stream {
    /// Stream payer / sender (funds originate from this address).
    pub sender: Address,
    /// Stream receiver / recipient (may withdraw unlocked funds).
    pub recipient: Address,
    /// Token being streamed (SAC / Stellar asset-like contract).
    pub token: Address,
    /// Stream start timestamp (seconds since epoch in ledger time).
    pub start_time: u64,
    /// Stream end timestamp (seconds since epoch in ledger time).
    pub end_time: u64,
    /// Total amount streamed over `[start_time, end_time]`.
    pub total_amount: i128,
    /// Total amount already withdrawn by the recipient.
    pub withdrawn_amount: i128,
    /// Whether the stream was cancelled early.
    pub cancelled: bool,
    /// Cancel timestamp (effective end-time if `cancelled == true`).
    pub cancel_time: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StreamError {
    /// `end_time` must be strictly greater than `start_time`.
    InvalidTime = 1,
    /// `total_amount` must be strictly positive.
    ZeroAmount = 2,
    /// Stream id not found.
    StreamNotFound = 3,
    /// Caller/recipient does not match stream authorization.
    Unauthorized = 4,
    /// A `withdraw_from_stream` re-entrancy attempt was detected.
    Reentrancy = 5,
    /// Math overflow in intermediate calculations.
    MathOverflow = 6,
    /// Internal accounting invariant was violated.
    InconsistentAccounting = 7,
}

#[contract]
pub struct StreamingPayments;

#[contractimpl]
impl StreamingPayments {
    /// Create a continuous token payment stream.
    ///
    /// NatSpec-style documentation:
    ///
    /// # Arguments
    /// * `sender` - Stream payer. Must authorize token escrow.
    /// * `recipient` - Stream receiver. Withdraws unlocked balances over time.
    /// * `token` - SAC / token contract address.
    /// * `start_time` - Stream start ledger timestamp (seconds).
    /// * `end_time` - Stream end ledger timestamp (seconds). Must be > `start_time`.
    /// * `total_amount` - Total tokens to escrow and stream linearly.
    ///
    /// # Returns
    /// The newly created stream id.
    ///
    /// # Errors
    /// Returns [`StreamError::InvalidTime`] if `end_time <= start_time`.
    /// Returns [`StreamError::ZeroAmount`] if `total_amount <= 0`.
    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        start_time: u64,
        end_time: u64,
        total_amount: i128,
    ) -> Result<u64, StreamError> {
        sender.require_auth();

        if total_amount <= 0 {
            return Err(StreamError::ZeroAmount);
        }
        if end_time <= start_time {
            return Err(StreamError::InvalidTime);
        }

        // Effects: escrow tokens up-front.
        token::Client::new(&env, &token).transfer(
            &sender,
            &env.current_contract_address(),
            &total_amount,
        );

        let stream_id = Self::next_stream_id(&env);
        let stream = Stream {
            sender: sender.clone(),
            recipient: recipient.clone(),
            token: token.clone(),
            start_time,
            end_time,
            total_amount,
            withdrawn_amount: 0,
            cancelled: false,
            cancel_time: 0,
        };

        env.storage()
            .persistent()
            .set(&StreamStorageKey::Stream(stream_id), &stream);

        let next_stream_id = stream_id.checked_add(1).ok_or(StreamError::MathOverflow)?;
        env.storage()
            .instance()
            .set(&InstanceKey::NextStreamId, &next_stream_id);

        env.events().publish(
            (symbol_short!("create"),),
            (
                stream_id,
                sender,
                recipient,
                total_amount,
                start_time,
                end_time,
            ),
        );

        Ok(stream_id)
    }

    /// Cancel a stream early and refund any remaining locked tokens to `sender`.
    ///
    /// # Arguments
    /// * `sender` - Stream payer. Must authorize cancellation.
    /// * `stream_id` - The stream to cancel.
    ///
    /// # Returns
    /// The refund amount returned to `sender`.
    ///
    /// # Notes
    /// Cancellation stops further unlocking. The effective stream end is set to
    /// the cancellation timestamp (capped at the original `end_time`).
    pub fn cancel_stream(env: Env, sender: Address, stream_id: u64) -> Result<i128, StreamError> {
        sender.require_auth();

        let mut stream = Self::load_stream(&env, stream_id)?;
        if stream.sender != sender {
            return Err(StreamError::Unauthorized);
        }

        // Idempotent cancellation: only refund once.
        if stream.cancelled {
            return Ok(0);
        }

        let now = env.ledger().timestamp();
        let cancel_time = now.min(stream.end_time);

        stream.cancelled = true;
        stream.cancel_time = cancel_time;
        env.storage()
            .persistent()
            .set(&StreamStorageKey::Stream(stream_id), &stream);

        let unlocked_total = Self::unlocked_total(&stream, now)?;
        let refund_amount = stream
            .total_amount
            .checked_sub(unlocked_total)
            .ok_or(StreamError::MathOverflow)?;

        if refund_amount > 0 {
            token::Client::new(&env, &stream.token).transfer(
                &env.current_contract_address(),
                &sender,
                &refund_amount,
            );
        }

        env.events().publish(
            (symbol_short!("cancel"),),
            (stream_id, sender, refund_amount, cancel_time),
        );

        Ok(refund_amount)
    }

    /// Withdraw newly unlocked tokens from a stream.
    ///
    /// # Arguments
    /// * `recipient` - Stream recipient. Must authorize withdrawal.
    /// * `stream_id` - The stream to withdraw from.
    ///
    /// # Returns
    /// The number of tokens transferred to `recipient`.
    ///
    /// # Security
    /// Prevents re-entrancy by using a contract-wide guard during the withdrawal
    /// interaction phase and by applying the checks-effects-interactions pattern.
    pub fn withdraw_from_stream(
        env: Env,
        recipient: Address,
        stream_id: u64,
    ) -> Result<i128, StreamError> {
        let mut stream = Self::load_stream(&env, stream_id)?;
        if stream.recipient != recipient {
            return Err(StreamError::Unauthorized);
        }

        recipient.require_auth();

        // Re-entrancy guard: must be held across the token transfer call.
        if Self::withdrawal_guard_is_set(&env) {
            return Err(StreamError::Reentrancy);
        }

        let now = env.ledger().timestamp();
        let unlocked_total = Self::unlocked_total(&stream, now)?;
        if unlocked_total <= stream.withdrawn_amount {
            return Ok(0);
        }

        let already_withdrawn = stream.withdrawn_amount;
        let amount_to_withdraw = unlocked_total
            .checked_sub(already_withdrawn)
            .ok_or(StreamError::InconsistentAccounting)?;

        if amount_to_withdraw <= 0 {
            return Ok(0);
        }

        // Effects: advance withdrawn amount before the external token transfer.
        stream.withdrawn_amount = unlocked_total;
        env.storage()
            .persistent()
            .set(&StreamStorageKey::Stream(stream_id), &stream);

        // Interaction guard.
        env.storage()
            .instance()
            .set(&InstanceKey::WithdrawalInProgress, &true);
        token::Client::new(&env, &stream.token).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount_to_withdraw,
        );
        env.storage()
            .instance()
            .set(&InstanceKey::WithdrawalInProgress, &false);

        env.events().publish(
            (symbol_short!("withdraw"),),
            (stream_id, recipient, amount_to_withdraw),
        );

        Ok(amount_to_withdraw)
    }

    /// Read the full stream record.
    ///
    /// # Arguments
    /// * `stream_id` - Stream identifier.
    ///
    /// # Returns
    /// The stored [`Stream`] metadata and accounting fields.
    ///
    /// # Errors
    /// Returns [`StreamError::StreamNotFound`] if the id does not exist.
    pub fn get_stream(env: Env, stream_id: u64) -> Result<Stream, StreamError> {
        Self::load_stream(&env, stream_id)
    }

    /// Return the total unlocked balance at the current ledger timestamp.
    ///
    /// This is the amount unlocked linearly from `start_time` until the current
    /// ledger timestamp (or until effective end-time if cancelled).
    ///
    /// # Arguments
    /// * `stream_id` - Stream identifier.
    ///
    /// # Returns
    /// Total unlocked tokens (does not subtract `withdrawn_amount`).
    pub fn get_unlocked_total(env: Env, stream_id: u64) -> i128 {
        let maybe = env
            .storage()
            .persistent()
            .get(&StreamStorageKey::Stream(stream_id));
        if let Some(stream) = maybe {
            Self::unlocked_total(&stream, env.ledger().timestamp()).unwrap_or_default()
        } else {
            0
        }
    }

    /// Return the withdrawable balance at the current ledger timestamp.
    ///
    /// # Arguments
    /// * `stream_id` - Stream identifier.
    ///
    /// # Returns
    /// `max(unlocked_total - withdrawn_amount, 0)`.
    pub fn get_withdrawable_amount(env: Env, stream_id: u64) -> i128 {
        let maybe = env
            .storage()
            .persistent()
            .get(&StreamStorageKey::Stream(stream_id));
        if let Some(stream) = maybe {
            match Self::unlocked_total(&stream, env.ledger().timestamp()) {
                Ok(unlocked_total) => {
                    if unlocked_total <= stream.withdrawn_amount {
                        0
                    } else {
                        unlocked_total
                            .checked_sub(stream.withdrawn_amount)
                            .unwrap_or(0)
                    }
                }
                Err(_) => 0,
            }
        } else {
            0
        }
    }

    // ── Internal helpers ────────────────────────────────────────────────

    fn next_stream_id(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get(&InstanceKey::NextStreamId)
            .unwrap_or(1)
    }

    fn withdrawal_guard_is_set(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&InstanceKey::WithdrawalInProgress)
            .unwrap_or(false)
    }

    fn load_stream(env: &Env, stream_id: u64) -> Result<Stream, StreamError> {
        env.storage()
            .persistent()
            .get(&StreamStorageKey::Stream(stream_id))
            .ok_or(StreamError::StreamNotFound)
    }

    /// Compute unlocked total balance for a stream at `now`.
    ///
    /// # Exactness
    /// Uses integer arithmetic for deterministic, timestamp-based unlocking:
    /// `unlocked_total = total_amount * elapsed / duration`, where `elapsed` is
    /// capped by the effective end-time (original end-time or cancel-time).
    fn unlocked_total(stream: &Stream, now: u64) -> Result<i128, StreamError> {
        let duration = stream
            .end_time
            .checked_sub(stream.start_time)
            .ok_or(StreamError::InvalidTime)?;

        if duration == 0 {
            return Err(StreamError::InvalidTime);
        }

        let effective_end = if stream.cancelled {
            stream.cancel_time
        } else {
            stream.end_time
        };

        let capped_now = if now >= effective_end {
            effective_end
        } else {
            now
        };
        if capped_now <= stream.start_time {
            return Ok(0);
        }

        let elapsed = capped_now
            .checked_sub(stream.start_time)
            .ok_or(StreamError::InvalidTime)?;
        let numerator = stream
            .total_amount
            .checked_mul(elapsed as i128)
            .ok_or(StreamError::MathOverflow)?;
        let denom = duration as i128;
        numerator
            .checked_div(denom)
            .ok_or(StreamError::MathOverflow)
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod test;
