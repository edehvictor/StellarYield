//! # Withdrawal Queue
//!
//! FIFO queue for withdrawal requests that cannot be filled instantly
//! (e.g. when the vault's liquid balance is temporarily below the amount
//! requested because assets are deployed into a strategy). Requests are
//! always fulfilled strictly in the order they were enqueued: a request
//! can only be fulfilled once every request enqueued before it has
//! already been fulfilled or cancelled.
//!
//! ## Ordering Invariant
//! - `head <= tail` at all times.
//! - Fulfilling or cancelling a request always advances `head` by exactly
//!   one and always targets the request at position `head`.
//! - No request at position `> head` can be fulfilled before the request
//!   at position `head`.

use soroban_sdk::{contractimpl, contracttype, symbol_short, Address, Env};

use crate::{DataKey, VaultError, YieldVault};

/// Storage keys for the withdrawal queue.
#[contracttype]
pub enum WithdrawalQueueKey {
    /// Index of the next request to be fulfilled (front of the queue).
    Head,
    /// Index the next enqueued request will receive (one past the back).
    Tail,
    /// Individual withdrawal request, keyed by its queue position.
    Request(u32),
}

/// A single queued withdrawal request.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawalRequest {
    pub position: u32,
    pub user: Address,
    pub shares: i128,
    pub requested_at: u64,
    pub fulfilled: bool,
}

fn read_head(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&WithdrawalQueueKey::Head)
        .unwrap_or(0)
}

fn read_tail(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&WithdrawalQueueKey::Tail)
        .unwrap_or(0)
}

fn write_head(env: &Env, head: u32) {
    env.storage().instance().set(&WithdrawalQueueKey::Head, &head);
}

fn write_tail(env: &Env, tail: u32) {
    env.storage().instance().set(&WithdrawalQueueKey::Tail, &tail);
}

#[contractimpl]
impl YieldVault {
    /// Enqueue a withdrawal request for `shares` on behalf of `user`.
    /// Returns the request's queue position.
    ///
    /// The caller must have already been authorized (`user.require_auth()`)
    /// and must hold at least `shares` vault shares; this mirrors the
    /// validation performed by the instant `withdraw` path.
    pub fn request_withdrawal(env: Env, user: Address, shares: i128) -> Result<u32, VaultError> {
        Self::require_init(&env)?;
        user.require_auth();

        if shares <= 0 {
            return Err(VaultError::ZeroAmount);
        }

        let user_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Shares(user.clone()))
            .unwrap_or(0);
        if user_shares < shares {
            return Err(VaultError::InsufficientShares);
        }

        let position = read_tail(&env);
        let request = WithdrawalRequest {
            position,
            user: user.clone(),
            shares,
            requested_at: env.ledger().timestamp(),
            fulfilled: false,
        };

        env.storage()
            .instance()
            .set(&WithdrawalQueueKey::Request(position), &request);
        write_tail(&env, position + 1);

        env.events()
            .publish((symbol_short!("wqenq"),), (user, position, shares));

        Ok(position)
    }

    /// Fulfill the withdrawal request at the front of the queue, paying
    /// `to` (the request's original user) the underlying assets for its
    /// shares. Only callable once every earlier request has already been
    /// fulfilled — the queue is strictly FIFO.
    pub fn fulfill_next_withdrawal(env: Env, admin: Address) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        Self::require_admin(&env, &admin)?;

        let head = read_head(&env);
        let tail = read_tail(&env);
        if head >= tail {
            return Err(VaultError::StorageKeyNotFound);
        }

        let mut request: WithdrawalRequest = env
            .storage()
            .instance()
            .get(&WithdrawalQueueKey::Request(head))
            .ok_or(VaultError::StorageKeyNotFound)?;

        if request.fulfilled {
            return Err(VaultError::StorageKeyNotFound);
        }

        let assets = Self::withdraw(env.clone(), request.user.clone(), request.shares)?;

        request.fulfilled = true;
        env.storage()
            .instance()
            .set(&WithdrawalQueueKey::Request(head), &request);
        write_head(&env, head + 1);

        env.events().publish(
            (symbol_short!("wqfill"),),
            (request.user, head, request.shares, assets),
        );

        Ok(assets)
    }

    /// Number of requests currently waiting in the queue (not yet at the
    /// front, or at the front but not yet fulfilled).
    pub fn withdrawal_queue_length(env: Env) -> u32 {
        read_tail(&env) - read_head(&env)
    }

    /// Position of the next request to be fulfilled.
    pub fn withdrawal_queue_head(env: Env) -> u32 {
        read_head(&env)
    }

    /// Fetch a specific queued withdrawal request by its position, if any.
    pub fn get_withdrawal_request(env: Env, position: u32) -> Option<WithdrawalRequest> {
        env.storage()
            .instance()
            .get(&WithdrawalQueueKey::Request(position))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{YieldVaultClient};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup_env() -> (Env, YieldVaultClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(YieldVault, ());
        let client = YieldVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();

        client.initialize(&admin, &token_addr);

        (env, client, admin, token_addr, token_admin)
    }

    fn mint_tokens(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
        let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    #[test]
    fn test_requests_are_fulfilled_in_fifo_order() {
        let (env, client, admin, token_addr, _) = setup_env();
        let user_a = Address::generate(&env);
        let user_b = Address::generate(&env);

        mint_tokens(&env, &token_addr, &user_a, 1000);
        mint_tokens(&env, &token_addr, &user_b, 1000);
        client.deposit(&user_a, &1000, &1000);
        client.deposit(&user_b, &1000, &1000);

        let pos_a = client.request_withdrawal(&user_a, &400);
        let pos_b = client.request_withdrawal(&user_b, &300);
        assert_eq!(pos_a, 0);
        assert_eq!(pos_b, 1);
        assert_eq!(client.withdrawal_queue_length(), 2);

        // Fulfilling always targets the head of the queue: user_a first.
        client.fulfill_next_withdrawal(&admin);
        let req_a = client.get_withdrawal_request(&pos_a).unwrap();
        assert!(req_a.fulfilled);
        assert_eq!(client.withdrawal_queue_head(), 1);

        client.fulfill_next_withdrawal(&admin);
        let req_b = client.get_withdrawal_request(&pos_b).unwrap();
        assert!(req_b.fulfilled);
        assert_eq!(client.withdrawal_queue_head(), 2);
        assert_eq!(client.withdrawal_queue_length(), 0);
    }

    #[test]
    fn test_cannot_fulfill_when_queue_is_empty() {
        let (_, client, admin, _, _) = setup_env();
        let result = client.try_fulfill_next_withdrawal(&admin);
        assert!(result.is_err());
    }

    #[test]
    fn test_second_request_cannot_be_fulfilled_before_first() {
        // Invariant: the queue never exposes a way to fulfill position 1
        // while position 0 is still pending — fulfill_next_withdrawal
        // always resolves the head, so this is enforced structurally.
        let (env, client, admin, token_addr, _) = setup_env();
        let user_a = Address::generate(&env);
        let user_b = Address::generate(&env);

        mint_tokens(&env, &token_addr, &user_a, 500);
        mint_tokens(&env, &token_addr, &user_b, 500);
        client.deposit(&user_a, &500, &500);
        client.deposit(&user_b, &500, &500);

        client.request_withdrawal(&user_a, &100);
        client.request_withdrawal(&user_b, &100);

        // The only entry point advances strictly from head=0, so the
        // second request (position 1) cannot be fulfilled first.
        let assets = client.fulfill_next_withdrawal(&admin);
        let req_a = client.get_withdrawal_request(&0u32).unwrap();
        let req_b = client.get_withdrawal_request(&1u32).unwrap();
        assert!(req_a.fulfilled);
        assert!(!req_b.fulfilled);
        assert!(assets > 0);
    }

    #[test]
    fn test_request_rejects_insufficient_shares() {
        let (env, client, _, token_addr, _) = setup_env();
        let user = Address::generate(&env);
        mint_tokens(&env, &token_addr, &user, 100);
        client.deposit(&user, &100, &100);

        let result = client.try_request_withdrawal(&user, &1000);
        assert!(result.is_err());
    }
}
