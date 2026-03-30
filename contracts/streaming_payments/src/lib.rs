#![no_std]

//! # Streaming payments
//!
//! Linear token streams: the sender escrows `amount_total` and the recipient
//! unlocks it continuously from `start_time` until `end_time`, proportional to
//! elapsed ledger time. Withdrawals use **checks–effects–interactions**: balances
//! are updated before any token transfer to mitigate re-entrancy.

use soroban_sdk::{
    contract, contracterror, contractimpl, contractmeta, contracttype, symbol_short, token,
    Address, Env,
};

contractmeta!(key = "name", val = "Streaming Payments");
contractmeta!(key = "version", val = "0.1.0");
contractmeta!(
    key = "description",
    val = "Linear time-locked token streams with cancel and withdraw."
);

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    NextStreamId,
    Stream(u32),
}

/// One linear payment stream (all amounts in the token’s smallest units).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stream {
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    /// Total escrowed for this stream (constant).
    pub amount_total: i128,
    /// Cumulative amount already paid out to the recipient.
    pub withdrawn: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cancelled: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StreamError {
    NotFound = 1,
    Unauthorized = 2,
    ZeroAmount = 3,
    InvalidTimeRange = 4,
    NothingToWithdraw = 5,
    AlreadyCancelled = 6,
    Overflow = 7,
    StreamComplete = 8,
}

#[contract]
pub struct StreamingPayments;

#[contractimpl]
impl StreamingPayments {
    /// Create a linear stream: `sender` escrows `amount_total` of `token` for `recipient`.
    ///
    /// Unlocked balance at ledger time `t` is:
    /// `0` if `t <= start_time`, `amount_total` if `t >= end_time`, otherwise
    /// `amount_total * (t - start_time) / (end_time - start_time)` (integer division, rounds down).
    ///
    /// # Arguments
    ///
    /// * `sender` — Funds the stream; must authorize and hold `amount_total`.
    /// * `recipient` — Address that may [`withdraw_from_stream`](Self::withdraw_from_stream).
    /// * `token` — SAC / token contract address.
    /// * `amount_total` — Amount to lock (smallest units).
    /// * `start_time` / `end_time` — UNIX timestamps (seconds); require `start_time < end_time`.
    ///
    /// # Returns
    ///
    /// New stream id (monotonic).
    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token_addr: Address,
        amount_total: i128,
        start_time: u64,
        end_time: u64,
    ) -> Result<u32, StreamError> {
        sender.require_auth();
        if amount_total <= 0 {
            return Err(StreamError::ZeroAmount);
        }
        if start_time >= end_time {
            return Err(StreamError::InvalidTimeRange);
        }

        let this = env.current_contract_address();
        let tok = token::Client::new(&env, &token_addr);
        tok.transfer(&sender, &this, &amount_total);

        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextStreamId)
            .unwrap_or(1u32);

        let stream = Stream {
            sender: sender.clone(),
            recipient: recipient.clone(),
            token: token_addr.clone(),
            amount_total,
            withdrawn: 0,
            start_time,
            end_time,
            cancelled: false,
        };

        env.storage().instance().set(&DataKey::Stream(id), &stream);
        env.storage()
            .instance()
            .set(&DataKey::NextStreamId, &(id.saturating_add(1)));

        env.events().publish(
            (symbol_short!("strm_new"),),
            (
                id,
                sender,
                recipient,
                token_addr,
                amount_total,
                start_time,
                end_time,
            ),
        );

        Ok(id)
    }

    /// Recipient pulls unlocked tokens not yet withdrawn.
    ///
    /// Updates `withdrawn` **before** transferring tokens to reduce re-entrancy risk from
    /// malicious ERC-20-style hooks.
    pub fn withdraw_from_stream(
        env: Env,
        recipient: Address,
        stream_id: u32,
    ) -> Result<i128, StreamError> {
        recipient.require_auth();

        let mut s: Stream = Self::load_stream(&env, stream_id)?;
        if s.cancelled {
            return Err(StreamError::AlreadyCancelled);
        }
        if s.recipient != recipient {
            return Err(StreamError::Unauthorized);
        }

        let now = env.ledger().timestamp();
        let unlocked = Self::unlocked_amount(&s, now);
        let claim = unlocked
            .checked_sub(s.withdrawn)
            .ok_or(StreamError::Overflow)?;
        if claim <= 0 {
            return Err(StreamError::NothingToWithdraw);
        }

        s.withdrawn = s
            .withdrawn
            .checked_add(claim)
            .ok_or(StreamError::Overflow)?;
        env.storage()
            .instance()
            .set(&DataKey::Stream(stream_id), &s);

        let this = env.current_contract_address();
        let tok = token::Client::new(&env, &s.token);
        tok.transfer(&this, &recipient, &claim);

        env.events()
            .publish((symbol_short!("strm_wd"),), (stream_id, recipient, claim));

        Ok(claim)
    }

    /// Sender cancels the stream: recipient receives remaining unlocked tokens; sender receives the unvested remainder.
    ///
    /// State (`cancelled`, `withdrawn`) is finalized **before** any outbound transfers.
    ///
    /// # Arguments
    ///
    /// * `sender` — Must equal the stream sender and authorize this call.
    /// * `stream_id` — Id returned by [`create_stream`](Self::create_stream).
    ///
    /// # Errors
    ///
    /// * [`StreamError::StreamComplete`] — Full amount was already withdrawn by the recipient.
    pub fn cancel_stream(env: Env, sender: Address, stream_id: u32) -> Result<(), StreamError> {
        sender.require_auth();

        let mut s: Stream = Self::load_stream(&env, stream_id)?;
        if s.sender != sender {
            return Err(StreamError::Unauthorized);
        }
        if s.cancelled {
            return Err(StreamError::AlreadyCancelled);
        }
        if s.withdrawn >= s.amount_total {
            return Err(StreamError::StreamComplete);
        }

        let now = env.ledger().timestamp();
        let unlocked = Self::unlocked_amount(&s, now);
        let pay_recipient = unlocked
            .checked_sub(s.withdrawn)
            .ok_or(StreamError::Overflow)?;
        let pay_sender = s
            .amount_total
            .checked_sub(unlocked)
            .ok_or(StreamError::Overflow)?;

        s.withdrawn = unlocked;
        s.cancelled = true;
        env.storage()
            .instance()
            .set(&DataKey::Stream(stream_id), &s);

        let this = env.current_contract_address();
        let tok = token::Client::new(&env, &s.token);
        if pay_recipient > 0 {
            tok.transfer(&this, &s.recipient, &pay_recipient);
        }
        if pay_sender > 0 {
            tok.transfer(&this, &s.sender, &pay_sender);
        }

        env.events().publish(
            (symbol_short!("strm_can"),),
            (stream_id, pay_recipient, pay_sender),
        );

        Ok(())
    }

    /// Returns total unlocked amount at the current ledger timestamp (ignores withdrawals).
    pub fn unlocked_at(env: Env, stream_id: u32) -> Result<i128, StreamError> {
        let s = Self::load_stream(&env, stream_id)?;
        let now = env.ledger().timestamp();
        Ok(Self::unlocked_amount(&s, now))
    }

    /// Returns claimable amount for the recipient at the current ledger time (`unlocked - withdrawn`).
    ///
    /// After cancellation, returns `0` (final balances were settled in [`cancel_stream`](Self::cancel_stream)).
    pub fn claimable(env: Env, stream_id: u32) -> Result<i128, StreamError> {
        let s = Self::load_stream(&env, stream_id)?;
        if s.cancelled {
            return Ok(0);
        }
        let now = env.ledger().timestamp();
        let unlocked = Self::unlocked_amount(&s, now);
        unlocked
            .checked_sub(s.withdrawn)
            .ok_or(StreamError::Overflow)
    }

    /// Returns full on-chain state for `stream_id`, or [`StreamError::NotFound`].
    pub fn get_stream(env: Env, stream_id: u32) -> Result<Stream, StreamError> {
        Self::load_stream(&env, stream_id)
    }

    fn load_stream(env: &Env, id: u32) -> Result<Stream, StreamError> {
        env.storage()
            .instance()
            .get(&DataKey::Stream(id))
            .ok_or(StreamError::NotFound)
    }

    /// Exact linear unlock: `amount_total * elapsed / duration` with `u64` time in seconds.
    fn unlocked_amount(s: &Stream, now: u64) -> i128 {
        if now <= s.start_time {
            return 0;
        }
        if now >= s.end_time {
            return s.amount_total;
        }
        let duration = s.end_time.saturating_sub(s.start_time);
        if duration == 0 {
            return s.amount_total;
        }
        let elapsed = (now.saturating_sub(s.start_time)) as i128;
        let dur = duration as i128;
        s.amount_total.saturating_mul(elapsed).saturating_div(dur)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn setup_token(env: &Env) -> Address {
        env.mock_all_auths();
        let admin = Address::generate(env);
        env.register_stellar_asset_contract_v2(admin.clone())
            .address()
    }

    fn deploy(env: &Env) -> (StreamingPaymentsClient<'static>, Address) {
        let id = env.register(StreamingPayments, ());
        let client = StreamingPaymentsClient::new(env, &id);
        (client, id)
    }

    fn mint_tokens(env: &Env, token: &Address, to: &Address, amt: i128) {
        soroban_sdk::token::StellarAssetClient::new(env, token).mint(to, &amt);
    }

    #[test]
    fn create_and_full_withdraw_after_end() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, contract) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 1_000_000);

        env.ledger().set_timestamp(1_000);
        let id = client.create_stream(
            &sender, &recipient, &token, &1_000_000, &2_000u64, &3_000u64,
        );

        env.ledger().set_timestamp(2_500);
        assert_eq!(client.claimable(&id), 500_000);

        env.ledger().set_timestamp(3_500);
        assert_eq!(client.claimable(&id), 1_000_000);

        let out = client.withdraw_from_stream(&recipient, &id);
        assert_eq!(out, 1_000_000);
        assert_eq!(client.claimable(&id), 0);
        let tok = token::Client::new(&env, &token);
        assert_eq!(tok.balance(&recipient), 1_000_000);
        assert_eq!(tok.balance(&contract), 0);
    }

    #[test]
    fn partial_mid_stream_withdraw() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, _) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 1_200_000);

        env.ledger().set_timestamp(0);
        let id = client.create_stream(&sender, &recipient, &token, &1_200_000, &0u64, &12_000u64);

        env.ledger().set_timestamp(3_000);
        let w1 = client.withdraw_from_stream(&recipient, &id);
        assert_eq!(w1, 300_000);

        env.ledger().set_timestamp(6_000);
        let w2 = client.withdraw_from_stream(&recipient, &id);
        assert_eq!(w2, 300_000);

        let tok = token::Client::new(&env, &token);
        assert_eq!(tok.balance(&recipient), 600_000);
    }

    #[test]
    fn cancel_refunds_unvested() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, contract) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 1_000_000);

        env.ledger().set_timestamp(100);
        let id = client.create_stream(&sender, &recipient, &token, &1_000_000, &100u64, &1_100u64);

        // 50% through [100, 1100] -> unlocked 500k at t=600
        env.ledger().set_timestamp(600);
        client.cancel_stream(&sender, &id);

        let tok = token::Client::new(&env, &token);
        assert_eq!(tok.balance(&recipient), 500_000);
        assert_eq!(tok.balance(&sender), 500_000);
        assert_eq!(tok.balance(&contract), 0);
        assert!(client.try_withdraw_from_stream(&recipient, &id).is_err());
    }

    #[test]
    fn non_recipient_cannot_withdraw() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, _) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let other = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 100);

        env.ledger().set_timestamp(0);
        let id = client.create_stream(&sender, &recipient, &token, &100, &0u64, &1000u64);

        env.ledger().set_timestamp(500);
        assert!(client.try_withdraw_from_stream(&other, &id).is_err());
    }

    #[test]
    fn non_sender_cannot_cancel() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, _) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let other = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 100);

        env.ledger().set_timestamp(0);
        let id = client.create_stream(&sender, &recipient, &token, &100, &0u64, &1000u64);

        assert!(client.try_cancel_stream(&other, &id).is_err());
    }

    #[test]
    fn double_cancel_fails() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, _) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 100);

        env.ledger().set_timestamp(0);
        let id = client.create_stream(&sender, &recipient, &token, &100, &0u64, &1000u64);

        env.ledger().set_timestamp(100);
        client.cancel_stream(&sender, &id);
        assert!(client.try_cancel_stream(&sender, &id).is_err());
    }

    #[test]
    fn cancel_after_full_withdraw_is_stream_complete() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, _) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 100);

        env.ledger().set_timestamp(0);
        let id = client.create_stream(&sender, &recipient, &token, &100, &0u64, &100u64);

        env.ledger().set_timestamp(100);
        client.withdraw_from_stream(&recipient, &id);
        assert!(client.try_cancel_stream(&sender, &id).is_err());
    }

    #[test]
    fn invalid_range_rejected() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, _) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 100);

        env.ledger().set_timestamp(0);
        assert!(client
            .try_create_stream(&sender, &recipient, &token, &100, &500u64, &100u64)
            .is_err());
    }

    #[test]
    fn zero_amount_rejected() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, _) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 100);

        assert!(client
            .try_create_stream(&sender, &recipient, &token, &0, &0u64, &100u64)
            .is_err());
    }

    #[test]
    fn nothing_to_withdraw_errors() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, _) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 100);

        env.ledger().set_timestamp(0);
        let id = client.create_stream(&sender, &recipient, &token, &100, &100u64, &200u64);

        env.ledger().set_timestamp(50);
        assert!(client.try_withdraw_from_stream(&recipient, &id).is_err());
    }

    #[test]
    fn get_stream_not_found() {
        let env = Env::default();
        let (client, _) = deploy(&env);
        assert!(client.try_get_stream(&99).is_err());
    }

    #[test]
    fn unlocked_before_start_zero() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, _) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 1000);

        env.ledger().set_timestamp(0);
        let id = client.create_stream(&sender, &recipient, &token, &1000, &500u64, &1500u64);

        env.ledger().set_timestamp(100);
        assert_eq!(client.unlocked_at(&id), 0);
        assert_eq!(client.claimable(&id), 0);
    }

    #[test]
    fn one_second_duration_full_unlock() {
        let env = Env::default();
        let token = setup_token(&env);
        let (client, _) = deploy(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint_tokens(&env, &token, &sender, 42);

        env.ledger().set_timestamp(10);
        let id = client.create_stream(&sender, &recipient, &token, &42, &10u64, &11u64);

        env.ledger().set_timestamp(11);
        assert_eq!(client.unlocked_at(&id), 42);
    }
}
