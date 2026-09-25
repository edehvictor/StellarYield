#![no_std]

//! # StreamingPayments
//!
//! Escrows a fixed token amount and unlocks it linearly between two ledger
//! timestamps. The recipient can withdraw vested funds over time. The sender can
//! cancel a stream to reclaim funds that have not vested yet.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Initialized,
    Admin,
    NextStreamId,
    Stream(u64),
    Withdrawing(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StreamStatus {
    Active = 0,
    Cancelled = 1,
    Depleted = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stream {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub withdrawn: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub status: StreamStatus,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StreamError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    ZeroAmount = 3,
    InvalidTimeRange = 4,
    StreamNotFound = 5,
    Unauthorized = 6,
    StreamNotActive = 7,
    NothingToWithdraw = 8,
    ReentrantWithdrawal = 9,
    MathOverflow = 10,
}

#[contract]
pub struct StreamingPayments;

#[contractimpl]
impl StreamingPayments {
    /// Initialize the streaming payments contract.
    ///
    /// # Arguments
    /// * `admin` - Administrative address recorded for deployment metadata.
    pub fn initialize(env: Env, admin: Address) -> Result<(), StreamError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(StreamError::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextStreamId, &1u64);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.events().publish((symbol_short!("init"),), admin);

        Ok(())
    }

    /// Create a linear token stream and escrow `amount` from `sender`.
    ///
    /// # Arguments
    /// * `sender` - Account funding the stream. Must authorize.
    /// * `recipient` - Account allowed to withdraw vested funds.
    /// * `token` - Soroban token contract address.
    /// * `amount` - Total token amount to stream.
    /// * `start_time` - Ledger timestamp when unlocking starts.
    /// * `end_time` - Ledger timestamp when the full amount is unlocked.
    ///
    /// # Returns
    /// The new stream ID.
    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        amount: i128,
        start_time: u64,
        end_time: u64,
    ) -> Result<u64, StreamError> {
        Self::require_init(&env)?;
        sender.require_auth();

        if amount <= 0 {
            return Err(StreamError::ZeroAmount);
        }
        if end_time <= start_time {
            return Err(StreamError::InvalidTimeRange);
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        let stream_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextStreamId)
            .unwrap();
        let stream = Stream {
            id: stream_id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token: token.clone(),
            amount,
            withdrawn: 0,
            start_time,
            end_time,
            status: StreamStatus::Active,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);
        env.storage()
            .instance()
            .set(&DataKey::NextStreamId, &(stream_id + 1));
        env.events().publish(
            (symbol_short!("created"),),
            (stream_id, sender, recipient, amount),
        );

        Ok(stream_id)
    }

    /// Cancel an active stream and refund unvested funds to the sender.
    ///
    /// Vested funds remain withdrawable by the recipient. The stream's
    /// effective amount is reduced to the vested amount at cancellation time.
    pub fn cancel_stream(env: Env, sender: Address, stream_id: u64) -> Result<i128, StreamError> {
        Self::require_init(&env)?;
        sender.require_auth();

        let mut stream = Self::load_stream(&env, stream_id)?;
        if stream.sender != sender {
            return Err(StreamError::Unauthorized);
        }
        if stream.status != StreamStatus::Active {
            return Err(StreamError::StreamNotActive);
        }

        let vested = Self::unlocked_amount_at(&stream, env.ledger().timestamp())?;
        let refund = stream.amount - vested;
        stream.amount = vested;
        stream.end_time = env.ledger().timestamp();
        stream.status = if stream.withdrawn >= stream.amount {
            StreamStatus::Depleted
        } else {
            StreamStatus::Cancelled
        };

        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);

        if refund > 0 {
            let token_client = token::Client::new(&env, &stream.token);
            token_client.transfer(&env.current_contract_address(), &stream.sender, &refund);
        }

        env.events()
            .publish((symbol_short!("cancel"),), (stream_id, sender, refund));

        Ok(refund)
    }

    /// Withdraw currently unlocked funds from a stream.
    ///
    /// # Arguments
    /// * `recipient` - Stream recipient. Must authorize.
    /// * `stream_id` - Stream to withdraw from.
    ///
    /// # Security
    /// A per-stream lock is set before transfer and cleared afterward to reject
    /// nested withdrawal attempts.
    pub fn withdraw_from_stream(
        env: Env,
        recipient: Address,
        stream_id: u64,
    ) -> Result<i128, StreamError> {
        Self::require_init(&env)?;
        recipient.require_auth();

        if env
            .storage()
            .temporary()
            .get(&DataKey::Withdrawing(stream_id))
            .unwrap_or(false)
        {
            return Err(StreamError::ReentrantWithdrawal);
        }

        let mut stream = Self::load_stream(&env, stream_id)?;
        if stream.recipient != recipient {
            return Err(StreamError::Unauthorized);
        }
        if stream.status == StreamStatus::Depleted {
            return Err(StreamError::StreamNotActive);
        }

        let withdrawable = Self::withdrawable_internal(&env, &stream)?;
        if withdrawable <= 0 {
            return Err(StreamError::NothingToWithdraw);
        }

        env.storage()
            .temporary()
            .set(&DataKey::Withdrawing(stream_id), &true);

        stream.withdrawn += withdrawable;
        if stream.withdrawn >= stream.amount {
            stream.status = StreamStatus::Depleted;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);

        let token_client = token::Client::new(&env, &stream.token);
        token_client.transfer(&env.current_contract_address(), &recipient, &withdrawable);

        env.storage()
            .temporary()
            .set(&DataKey::Withdrawing(stream_id), &false);
        env.events().publish(
            (symbol_short!("withdraw"),),
            (stream_id, recipient, withdrawable),
        );

        Ok(withdrawable)
    }

    /// Return the amount currently withdrawable for `stream_id`.
    pub fn withdrawable(env: Env, stream_id: u64) -> Result<i128, StreamError> {
        Self::require_init(&env)?;
        let stream = Self::load_stream(&env, stream_id)?;
        Self::withdrawable_internal(&env, &stream)
    }

    /// Return full stream metadata for `stream_id`.
    pub fn get_stream(env: Env, stream_id: u64) -> Result<Stream, StreamError> {
        Self::require_init(&env)?;
        Self::load_stream(&env, stream_id)
    }

    /// Return the next stream ID that will be assigned.
    pub fn next_stream_id(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::NextStreamId)
            .unwrap_or(1)
    }

    fn require_init(env: &Env) -> Result<(), StreamError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(StreamError::NotInitialized);
        }
        Ok(())
    }

    fn load_stream(env: &Env, stream_id: u64) -> Result<Stream, StreamError> {
        env.storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .ok_or(StreamError::StreamNotFound)
    }

    fn withdrawable_internal(env: &Env, stream: &Stream) -> Result<i128, StreamError> {
        let unlocked = Self::unlocked_amount_at(stream, env.ledger().timestamp())?;
        Ok(unlocked - stream.withdrawn)
    }

    fn unlocked_amount_at(stream: &Stream, timestamp: u64) -> Result<i128, StreamError> {
        if timestamp <= stream.start_time {
            return Ok(0);
        }
        if timestamp >= stream.end_time {
            return Ok(stream.amount);
        }

        let elapsed = (timestamp - stream.start_time) as i128;
        let duration = (stream.end_time - stream.start_time) as i128;
        stream
            .amount
            .checked_mul(elapsed)
            .map(|value| value / duration)
            .ok_or(StreamError::MathOverflow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::Env;

    fn setup() -> (
        Env,
        StreamingPaymentsClient<'static>,
        Address,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(StreamingPayments, ());
        let client = StreamingPaymentsClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let token_addr = token_contract.address();

        client.initialize(&admin);
        mint(&env, &token_addr, &sender, 10_000);

        (env, client, sender, recipient, token_addr, contract_id)
    }

    fn mint(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
        let admin_client = token::StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    fn balance(env: &Env, token_addr: &Address, account: &Address) -> i128 {
        token::Client::new(env, token_addr).balance(account)
    }

    #[test]
    fn create_stream_escrows_tokens() {
        let (env, client, sender, recipient, token_addr, contract_id) = setup();

        let stream_id =
            client.create_stream(&sender, &recipient, &token_addr, &1_200, &100, &3_700);

        assert_eq!(stream_id, 1);
        assert_eq!(client.next_stream_id(), 2);
        assert_eq!(balance(&env, &token_addr, &sender), 8_800);
        assert_eq!(balance(&env, &token_addr, &contract_id), 1_200);
    }

    #[test]
    fn rejects_invalid_stream_inputs() {
        let (_, client, sender, recipient, token_addr, _) = setup();

        assert_eq!(
            client.try_create_stream(&sender, &recipient, &token_addr, &0, &100, &200),
            Err(Ok(StreamError::ZeroAmount)),
        );
        assert_eq!(
            client.try_create_stream(&sender, &recipient, &token_addr, &100, &200, &200),
            Err(Ok(StreamError::InvalidTimeRange)),
        );
    }

    #[test]
    fn calculates_linear_withdrawable_amounts() {
        let (env, client, sender, recipient, token_addr, _) = setup();
        let stream_id = client.create_stream(&sender, &recipient, &token_addr, &1_000, &100, &200);

        env.ledger().set_timestamp(99);
        assert_eq!(client.withdrawable(&stream_id), 0);

        env.ledger().set_timestamp(150);
        assert_eq!(client.withdrawable(&stream_id), 500);

        env.ledger().set_timestamp(200);
        assert_eq!(client.withdrawable(&stream_id), 1_000);
    }

    #[test]
    fn withdraw_transfers_only_unlocked_delta() {
        let (env, client, sender, recipient, token_addr, _) = setup();
        let stream_id = client.create_stream(&sender, &recipient, &token_addr, &1_000, &100, &200);

        env.ledger().set_timestamp(150);
        assert_eq!(client.withdraw_from_stream(&recipient, &stream_id), 500);
        assert_eq!(balance(&env, &token_addr, &recipient), 500);
        assert_eq!(client.withdrawable(&stream_id), 0);

        env.ledger().set_timestamp(200);
        assert_eq!(client.withdraw_from_stream(&recipient, &stream_id), 500);
        assert_eq!(balance(&env, &token_addr, &recipient), 1_000);
        assert_eq!(client.get_stream(&stream_id).status, StreamStatus::Depleted);
    }

    #[test]
    fn rejects_unauthorized_withdrawal() {
        let (env, client, sender, recipient, token_addr, _) = setup();
        let stream_id = client.create_stream(&sender, &recipient, &token_addr, &1_000, &100, &200);
        let attacker = Address::generate(&env);
        env.ledger().set_timestamp(150);

        assert_eq!(
            client.try_withdraw_from_stream(&attacker, &stream_id),
            Err(Ok(StreamError::Unauthorized)),
        );
    }

    #[test]
    fn cancel_refunds_unvested_and_leaves_vested_withdrawable() {
        let (env, client, sender, recipient, token_addr, _) = setup();
        let stream_id = client.create_stream(&sender, &recipient, &token_addr, &1_000, &100, &200);

        env.ledger().set_timestamp(160);
        assert_eq!(client.cancel_stream(&sender, &stream_id), 400);
        assert_eq!(balance(&env, &token_addr, &sender), 9_400);
        assert_eq!(client.withdrawable(&stream_id), 600);

        assert_eq!(client.withdraw_from_stream(&recipient, &stream_id), 600);
        assert_eq!(balance(&env, &token_addr, &recipient), 600);
        assert_eq!(client.get_stream(&stream_id).status, StreamStatus::Depleted);
    }
}
