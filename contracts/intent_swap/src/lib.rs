#![no_std]
#![allow(clippy::too_many_arguments)]

//! # Intent-Based Swap Architecture (CowSwap Style)
//!
//! Instead of users submitting raw swap transactions (vulnerable to MEV),
//! they sign an "Intent" specifying what they want to trade. A network of
//! solvers then competes to fill the intent at the best price.
//!
//! ## Flow
//! 1. User creates an intent: "I want to sell X of token A for at least Y of token B"
//! 2. Solvers monitor open intents and submit solutions
//! 3. The protocol picks the best solution (highest output for the user)
//! 4. Settlement executes atomically — user gets filled or nothing happens
//!
//! ## MEV Protection
//! - Users never submit raw swaps, so sandwich attacks are impossible
//! - Solver competition ensures best execution
//! - Intents have expiry timestamps and minimum output guarantees

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
};

// ── Storage Keys ────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Admin,
    Initialized,
    Intent(u64),
    NextIntentId,
    Solver(Address),
    SolverStake(Address),
    Solution(u64),
    MinStake,
    ProtocolFeeBps,
    FeeRecipient,
    SolverCount,
    Nonce(Address, u64),
    MaxQuoteAge,
}

// ── Data Structures ─────────────────────────────────────────────────────

/// Signature domain of an intent: the network and the deployment it is
/// valid on. The owner signs it as a `create_intent` argument, so a signed
/// intent cannot be replayed on another network or another deployment.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentDomain {
    /// SHA-256 of the network passphrase.
    pub network_id: BytesN<32>,
    pub verifying_contract: Address,
}

/// Lifecycle of an owner-scoped intent nonce. Absent means unused.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NonceState {
    /// Consumed by the intent with this ID.
    Bound(u64),
    /// Invalidated by the owner; can never back an intent or a fill.
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum IntentStatus {
    Open = 0,
    Filled = 1,
    Cancelled = 2,
    Expired = 3,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct SwapIntent {
    pub id: u64,
    pub owner: Address,
    pub sell_token: Address,
    pub buy_token: Address,
    pub sell_amount: i128,
    pub min_buy_amount: i128,
    /// Owner-signed cap on protocol + solver fees, in buy-token units.
    pub max_fee: i128,
    pub expiry: u64,
    pub status: IntentStatus,
    pub created_at: u64,
    pub partial_fill: bool,
    pub filled_sell: i128,
    pub filled_buy: i128,
    pub fill_count: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Solution {
    pub intent_id: u64,
    pub solver: Address,
    pub buy_amount: i128,
    pub sell_amount: i128,
    pub submitted_at: u64,
}

/// Stable settlement receipt, published exactly once per successful fill.
///
/// Contracts cannot observe their transaction hash, so the on-chain
/// reference is `(intent_id, fill_index)` anchored at `ledger`; RPC
/// `getEvents` returns the `txHash` alongside this event.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementReceipt {
    pub intent_id: u64,
    pub solver: Address,
    /// Escrowed sell tokens released to the solver.
    pub input_amount: i128,
    /// Buy tokens delivered to the intent owner.
    pub output_amount: i128,
    pub protocol_fee: i128,
    pub solver_fee: i128,
    pub ledger: u32,
    pub fill_index: u32,
}

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum SwapError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    ZeroAmount = 3,
    Unauthorized = 4,
    IntentNotFound = 5,
    IntentNotOpen = 6,
    IntentExpired = 7,
    InsufficientOutput = 8,
    SolverNotRegistered = 9,
    InsufficientStake = 10,
    SolverAlreadyRegistered = 11,
    InvalidExpiry = 12,
    SelfTrade = 13,
    PartialFillExceeded = 14,
    InvalidFee = 15,
    NonceUsed = 16,
    FeeCapExceeded = 17,
    DomainMismatch = 18,
    QuoteExpired = 19,
    QuoteFromFuture = 20,
}

const MAX_PROTOCOL_FEE_BPS: u32 = 100;
/// Seconds a solver quote stays settleable when the admin has not set a
/// window: about six ledgers at Stellar's ~5 s close time.
const DEFAULT_MAX_QUOTE_AGE_SECS: u64 = 30;

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct IntentSwap;

#[allow(clippy::too_many_arguments)]
#[contractimpl]
impl IntentSwap {
    // ── Initialization ──────────────────────────────────────────────

    /// Initialize the intent swap protocol.
    ///
    /// # Arguments
    /// * `admin` — Protocol admin address
    /// * `min_stake` — Minimum stake required for solver registration
    /// * `protocol_fee_bps` — Protocol fee in basis points (max 100 = 1%)
    /// * `fee_recipient` — Address that receives protocol fees
    pub fn initialize(
        env: Env,
        admin: Address,
        min_stake: i128,
        protocol_fee_bps: u32,
        fee_recipient: Address,
    ) -> Result<(), SwapError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(SwapError::AlreadyInitialized);
        }
        if protocol_fee_bps > MAX_PROTOCOL_FEE_BPS {
            return Err(SwapError::InvalidFee);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextIntentId, &1u64);
        env.storage().instance().set(&DataKey::MinStake, &min_stake);
        env.storage()
            .instance()
            .set(&DataKey::ProtocolFeeBps, &protocol_fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::FeeRecipient, &fee_recipient);
        env.storage().instance().set(&DataKey::SolverCount, &0u32);
        env.storage().instance().set(&DataKey::Initialized, &true);

        env.events().publish(
            (symbol_short!("init"),),
            (admin, min_stake, protocol_fee_bps),
        );

        Ok(())
    }

    // ── Intent Creation ─────────────────────────────────────────────

    /// Create a new swap intent. The user's sell tokens are escrowed in
    /// the contract until the intent is filled, cancelled, or expires.
    ///
    /// # Arguments
    /// * `owner` — Intent creator (must authorize)
    /// * `sell_token` — Token the user wants to sell
    /// * `buy_token` — Token the user wants to receive
    /// * `sell_amount` — Amount of sell_token to trade
    /// * `min_buy_amount` — Minimum acceptable amount of buy_token
    /// * `max_fee` — Maximum combined protocol + solver fee, in buy_token
    ///   (pro-rated per partial fill; must be below `min_buy_amount`)
    /// * `expiry` — Ledger timestamp after which the intent expires
    /// * `partial_fill` — Whether partial fills are allowed
    /// * `nonce` — Owner-scoped single-use nonce; cancellable via `cancel_nonce`
    /// * `domain` — Signed network and deployment; must equal `get_domain()`
    ///
    /// # Returns
    /// The intent ID
    pub fn create_intent(
        env: Env,
        owner: Address,
        sell_token: Address,
        buy_token: Address,
        sell_amount: i128,
        min_buy_amount: i128,
        max_fee: i128,
        expiry: u64,
        partial_fill: bool,
        nonce: u64,
        domain: IntentDomain,
    ) -> Result<u64, SwapError> {
        Self::require_init(&env)?;
        owner.require_auth();

        if domain != Self::get_domain(env.clone()) {
            return Err(SwapError::DomainMismatch);
        }
        if sell_amount <= 0 || min_buy_amount <= 0 {
            return Err(SwapError::ZeroAmount);
        }
        if max_fee < 0 || max_fee >= min_buy_amount {
            return Err(SwapError::InvalidFee);
        }

        let now = env.ledger().timestamp();
        if expiry <= now {
            return Err(SwapError::InvalidExpiry);
        }

        let nonce_key = DataKey::Nonce(owner.clone(), nonce);
        if env.storage().persistent().has(&nonce_key) {
            return Err(SwapError::NonceUsed);
        }

        // Escrow sell tokens from user
        let sell_client = token::Client::new(&env, &sell_token);
        sell_client.transfer(&owner, &env.current_contract_address(), &sell_amount);

        let intent_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextIntentId)
            .unwrap();

        let intent = SwapIntent {
            id: intent_id,
            owner: owner.clone(),
            sell_token: sell_token.clone(),
            buy_token: buy_token.clone(),
            sell_amount,
            min_buy_amount,
            max_fee,
            expiry,
            status: IntentStatus::Open,
            created_at: now,
            partial_fill,
            filled_sell: 0,
            filled_buy: 0,
            fill_count: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Intent(intent_id), &intent);
        env.storage()
            .persistent()
            .set(&nonce_key, &NonceState::Bound(intent_id));
        env.storage()
            .instance()
            .set(&DataKey::NextIntentId, &(intent_id + 1));

        env.events().publish(
            (symbol_short!("intent"),),
            (intent_id, owner, sell_amount, min_buy_amount),
        );

        Ok(intent_id)
    }

    // ── Intent Cancellation ─────────────────────────────────────────

    /// Cancel an open intent and return escrowed tokens to the owner.
    pub fn cancel_intent(env: Env, owner: Address, intent_id: u64) -> Result<(), SwapError> {
        Self::require_init(&env)?;
        owner.require_auth();

        let mut intent: SwapIntent = env
            .storage()
            .persistent()
            .get(&DataKey::Intent(intent_id))
            .ok_or(SwapError::IntentNotFound)?;

        if intent.owner != owner {
            return Err(SwapError::Unauthorized);
        }
        if intent.status != IntentStatus::Open {
            return Err(SwapError::IntentNotOpen);
        }

        Self::close_and_refund(&env, &mut intent, IntentStatus::Cancelled);

        env.events()
            .publish((symbol_short!("cancel"),), (intent_id,));

        Ok(())
    }

    /// Invalidate one of the owner's nonces without affecting any other.
    ///
    /// An unused nonce can never back an intent afterwards. A nonce bound
    /// to an open intent cancels that intent (rejecting later fills) and
    /// refunds its remaining escrow. A nonce already cancelled, or bound to
    /// a closed intent, returns `NonceUsed`.
    pub fn cancel_nonce(env: Env, owner: Address, nonce: u64) -> Result<(), SwapError> {
        Self::require_init(&env)?;
        owner.require_auth();

        let nonce_key = DataKey::Nonce(owner.clone(), nonce);
        match env.storage().persistent().get(&nonce_key) {
            None => {}
            Some(NonceState::Bound(intent_id)) => {
                let mut intent: SwapIntent = env
                    .storage()
                    .persistent()
                    .get(&DataKey::Intent(intent_id))
                    .ok_or(SwapError::IntentNotFound)?;
                if intent.status != IntentStatus::Open {
                    return Err(SwapError::NonceUsed);
                }
                Self::close_and_refund(&env, &mut intent, IntentStatus::Cancelled);
                env.events()
                    .publish((symbol_short!("cancel"),), (intent_id,));
            }
            Some(NonceState::Cancelled) => return Err(SwapError::NonceUsed),
        }

        env.storage()
            .persistent()
            .set(&nonce_key, &NonceState::Cancelled);
        env.events()
            .publish((symbol_short!("nonce_cxl"),), (owner, nonce));

        Ok(())
    }

    // ── Solver Fills Intent ─────────────────────────────────────────

    /// A registered solver fills an open intent by providing buy tokens
    /// and receiving the escrowed sell tokens.
    ///
    /// The protocol fee and the solver fee are deducted from the buy tokens
    /// before delivery; their sum is verified against the owner-signed
    /// `max_fee` (pro-rated for partial fills) before any transfer. The
    /// owner's net output, summed over every fill of the intent, must reach
    /// `min_buy_amount` pro-rated to the sell amount filled so far.
    ///
    /// The quote is settleable while `quoted_at <= now <= quoted_at +
    /// max_quote_age`, where `now` is the ledger close time.
    ///
    /// Settlement is atomic: if any leg fails, the host reverts every prior
    /// leg, all state writes, and the receipt, leaving the escrow reserved
    /// on the still-open intent (refundable via cancel/expire).
    ///
    /// # Arguments
    /// * `solver` — Registered solver address (must authorize)
    /// * `intent_id` — The intent to fill
    /// * `buy_amount` — Amount of buy tokens the solver provides
    /// * `sell_amount` — Amount of sell tokens the solver wants (for partial fills)
    /// * `solver_fee` — Buy tokens the solver retains from `buy_amount`
    /// * `quoted_at` — Ledger timestamp at which the solver priced the quote
    pub fn fill_intent(
        env: Env,
        solver: Address,
        intent_id: u64,
        buy_amount: i128,
        sell_amount: i128,
        solver_fee: i128,
        quoted_at: u64,
    ) -> Result<(), SwapError> {
        Self::require_init(&env)?;
        solver.require_auth();

        // Verify solver is registered
        if !Self::is_solver_registered(&env, &solver) {
            return Err(SwapError::SolverNotRegistered);
        }

        let mut intent: SwapIntent = env
            .storage()
            .persistent()
            .get(&DataKey::Intent(intent_id))
            .ok_or(SwapError::IntentNotFound)?;

        if intent.status != IntentStatus::Open {
            return Err(SwapError::IntentNotOpen);
        }

        // Check expiry. No state is written here: an error reverts the frame,
        // and the escrow stays refundable through `expire_intent`.
        let now = env.ledger().timestamp();
        if now >= intent.expiry {
            return Err(SwapError::IntentExpired);
        }
        if quoted_at > now {
            return Err(SwapError::QuoteFromFuture);
        }
        if now - quoted_at > Self::get_max_quote_age(env.clone()) {
            return Err(SwapError::QuoteExpired);
        }

        // Prevent self-trading
        if solver == intent.owner {
            return Err(SwapError::SelfTrade);
        }

        // Calculate effective amounts for this fill
        let remaining_sell = intent.sell_amount - intent.filled_sell;
        let fill_sell = if intent.partial_fill {
            if sell_amount <= 0 || sell_amount > remaining_sell {
                return Err(SwapError::PartialFillExceeded);
            }
            sell_amount
        } else {
            remaining_sell
        };

        // Verify actual fees against the owner-signed cap before any transfer
        if solver_fee < 0 {
            return Err(SwapError::InvalidFee);
        }
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProtocolFeeBps)
            .unwrap_or(0);
        let protocol_fee = (buy_amount * fee_bps as i128) / 10_000;
        // Subtraction form: a solver-supplied `solver_fee` cannot overflow the sum
        if solver_fee > Self::fill_share(&intent, intent.max_fee, fill_sell) - protocol_fee {
            return Err(SwapError::FeeCapExceeded);
        }
        let user_receives = buy_amount - protocol_fee - solver_fee;

        // The signed minimum binds net output across all fills, so per-fill
        // rounding can never settle the intent below `min_buy_amount`.
        let min_net = Self::min_cumulative_output(&intent, intent.filled_sell + fill_sell);
        if user_receives < 0 || intent.filled_buy + user_receives < min_net {
            return Err(SwapError::InsufficientOutput);
        }

        // Transfer buy tokens from solver to user
        let buy_client = token::Client::new(&env, &intent.buy_token);
        buy_client.transfer(&solver, &intent.owner, &user_receives);

        // Transfer protocol fee
        if protocol_fee > 0 {
            let fee_recipient: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeRecipient)
                .unwrap();
            buy_client.transfer(&solver, &fee_recipient, &protocol_fee);
        }

        // Transfer escrowed sell tokens from contract to solver
        let sell_client = token::Client::new(&env, &intent.sell_token);
        sell_client.transfer(&env.current_contract_address(), &solver, &fill_sell);

        // Update intent state
        intent.filled_sell += fill_sell;
        intent.filled_buy += user_receives;
        intent.fill_count += 1;

        if intent.filled_sell >= intent.sell_amount {
            intent.status = IntentStatus::Filled;
        }

        // Store solution record
        let solution = Solution {
            intent_id,
            solver: solver.clone(),
            buy_amount: user_receives,
            sell_amount: fill_sell,
            submitted_at: now,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Solution(intent_id), &solution);

        env.storage()
            .persistent()
            .set(&DataKey::Intent(intent_id), &intent);

        env.events().publish(
            (symbol_short!("fill"),),
            (intent_id, solver.clone(), fill_sell, user_receives),
        );

        // Published last, so it exists only if every leg above succeeded
        let receipt = SettlementReceipt {
            intent_id,
            solver,
            input_amount: fill_sell,
            output_amount: user_receives,
            protocol_fee,
            solver_fee,
            ledger: env.ledger().sequence(),
            fill_index: intent.fill_count,
        };
        env.events()
            .publish((symbol_short!("receipt"), intent_id), receipt);

        Ok(())
    }

    // ── Expire Intent ───────────────────────────────────────────────

    /// Mark an expired intent and return remaining escrowed tokens.
    /// Anyone can call this for housekeeping.
    pub fn expire_intent(env: Env, intent_id: u64) -> Result<(), SwapError> {
        Self::require_init(&env)?;

        let mut intent: SwapIntent = env
            .storage()
            .persistent()
            .get(&DataKey::Intent(intent_id))
            .ok_or(SwapError::IntentNotFound)?;

        if intent.status != IntentStatus::Open {
            return Err(SwapError::IntentNotOpen);
        }

        let now = env.ledger().timestamp();
        if now < intent.expiry {
            return Err(SwapError::InvalidExpiry);
        }

        Self::close_and_refund(&env, &mut intent, IntentStatus::Expired);

        env.events()
            .publish((symbol_short!("expire"),), (intent_id,));

        Ok(())
    }

    // ── Admin ───────────────────────────────────────────────────────

    /// Update protocol fee. Admin only.
    pub fn set_protocol_fee(env: Env, admin: Address, fee_bps: u32) -> Result<(), SwapError> {
        Self::require_admin(&env, &admin)?;
        if fee_bps > MAX_PROTOCOL_FEE_BPS {
            return Err(SwapError::InvalidFee);
        }
        env.storage()
            .instance()
            .set(&DataKey::ProtocolFeeBps, &fee_bps);
        env.events()
            .publish((symbol_short!("set_fee"),), (fee_bps,));
        Ok(())
    }

    /// Update minimum solver stake. Admin only.
    pub fn set_min_stake(env: Env, admin: Address, min_stake: i128) -> Result<(), SwapError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::MinStake, &min_stake);
        Ok(())
    }

    /// Update the oldest a solver quote may be at settlement, in seconds.
    /// Admin only.
    pub fn set_max_quote_age(env: Env, admin: Address, max_age_secs: u64) -> Result<(), SwapError> {
        Self::require_admin(&env, &admin)?;
        env.storage()
            .instance()
            .set(&DataKey::MaxQuoteAge, &max_age_secs);
        env.events()
            .publish((symbol_short!("quote_age"),), (max_age_secs,));
        Ok(())
    }

    // ── View Functions ──────────────────────────────────────────────

    /// The domain an intent must sign to be accepted by this deployment.
    pub fn get_domain(env: Env) -> IntentDomain {
        IntentDomain {
            network_id: env.ledger().network_id(),
            verifying_contract: env.current_contract_address(),
        }
    }

    pub fn get_max_quote_age(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::MaxQuoteAge)
            .unwrap_or(DEFAULT_MAX_QUOTE_AGE_SECS)
    }

    pub fn get_intent(env: Env, intent_id: u64) -> Result<SwapIntent, SwapError> {
        env.storage()
            .persistent()
            .get(&DataKey::Intent(intent_id))
            .ok_or(SwapError::IntentNotFound)
    }

    pub fn get_solution(env: Env, intent_id: u64) -> Result<Solution, SwapError> {
        env.storage()
            .persistent()
            .get(&DataKey::Solution(intent_id))
            .ok_or(SwapError::IntentNotFound)
    }

    pub fn get_solver_stake(env: Env, solver: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::SolverStake(solver))
            .unwrap_or(0)
    }

    pub fn solver_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::SolverCount)
            .unwrap_or(0)
    }

    pub fn get_protocol_fee(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ProtocolFeeBps)
            .unwrap_or(0)
    }

    // ── Solver Registration ─────────────────────────────────────────

    /// Register as a solver by staking tokens.
    ///
    /// # Arguments
    /// * `solver` — Address to register as solver (must authorize)
    /// * `stake_token` — Token to stake
    /// * `stake_amount` — Amount to stake (must meet minimum)
    pub fn register_solver(
        env: Env,
        solver: Address,
        stake_token: Address,
        stake_amount: i128,
    ) -> Result<(), SwapError> {
        Self::require_init(&env)?;
        solver.require_auth();

        if Self::is_solver_registered(&env, &solver) {
            return Err(SwapError::SolverAlreadyRegistered);
        }

        let min_stake: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinStake)
            .unwrap_or(0);

        if stake_amount < min_stake {
            return Err(SwapError::InsufficientStake);
        }

        // Transfer stake from solver to contract
        let client = token::Client::new(&env, &stake_token);
        client.transfer(&solver, &env.current_contract_address(), &stake_amount);

        // Register solver
        env.storage()
            .persistent()
            .set(&DataKey::Solver(solver.clone()), &true);
        env.storage()
            .persistent()
            .set(&DataKey::SolverStake(solver.clone()), &stake_amount);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SolverCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::SolverCount, &(count + 1));

        env.events()
            .publish((symbol_short!("solver"),), (solver, stake_amount));

        Ok(())
    }

    /// Withdraw stake and deregister as a solver.
    ///
    /// # Arguments
    /// * `solver` — Solver address (must authorize)
    /// * `stake_token` — Token to return
    pub fn withdraw_stake(
        env: Env,
        solver: Address,
        stake_token: Address,
    ) -> Result<(), SwapError> {
        Self::require_init(&env)?;
        solver.require_auth();

        if !Self::is_solver_registered(&env, &solver) {
            return Err(SwapError::SolverNotRegistered);
        }

        let stake: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::SolverStake(solver.clone()))
            .unwrap_or(0);

        // Return stake
        if stake > 0 {
            let client = token::Client::new(&env, &stake_token);
            client.transfer(&env.current_contract_address(), &solver, &stake);
        }

        // Deregister
        env.storage()
            .persistent()
            .set(&DataKey::Solver(solver.clone()), &false);
        env.storage()
            .persistent()
            .set(&DataKey::SolverStake(solver.clone()), &0i128);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SolverCount)
            .unwrap_or(1);
        env.storage()
            .instance()
            .set(&DataKey::SolverCount, &(count.saturating_sub(1)));

        env.events().publish((symbol_short!("unstake"),), (solver,));

        Ok(())
    }

    // ── Internal ────────────────────────────────────────────────────

    fn require_init(env: &Env) -> Result<(), SwapError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(SwapError::NotInitialized);
        }
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), SwapError> {
        Self::require_init(env)?;
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(SwapError::NotInitialized)?;
        if *caller != admin {
            return Err(SwapError::Unauthorized);
        }
        Ok(())
    }

    fn is_solver_registered(env: &Env, solver: &Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Solver(solver.clone()))
            .unwrap_or(false)
    }

    /// Share of an intent-wide amount owed for a fill of `fill_sell`.
    /// Exact for full fills; floored (in the owner's favour for caps) otherwise.
    fn fill_share(intent: &SwapIntent, amount: i128, fill_sell: i128) -> i128 {
        if intent.partial_fill {
            (amount * fill_sell) / intent.sell_amount
        } else {
            amount
        }
    }

    /// Least cumulative net output owed once `filled_sell` has been sold:
    /// `min_buy_amount` pro-rated and rounded up (exact on completion).
    fn min_cumulative_output(intent: &SwapIntent, filled_sell: i128) -> i128 {
        if filled_sell == intent.sell_amount {
            return intent.min_buy_amount;
        }
        let scaled = intent.min_buy_amount * filled_sell;
        let min_net = scaled / intent.sell_amount;
        if scaled % intent.sell_amount == 0 {
            min_net
        } else {
            min_net + 1
        }
    }

    /// Close an open intent and return its remaining escrow to the owner.
    fn close_and_refund(env: &Env, intent: &mut SwapIntent, status: IntentStatus) {
        intent.status = status;
        env.storage()
            .persistent()
            .set(&DataKey::Intent(intent.id), intent);

        let remaining = intent.sell_amount - intent.filled_sell;
        if remaining > 0 {
            let sell_client = token::Client::new(env, &intent.sell_token);
            sell_client.transfer(&env.current_contract_address(), &intent.owner, &remaining);
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Events as _, IssuerFlags, Ledger};
    use soroban_sdk::{Bytes, Env, Symbol, TryFromVal};

    fn setup_env() -> (
        Env,
        IntentSwapClient<'static>,
        Address,
        Address,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(IntentSwap, ());
        let client = IntentSwapClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let fee_recipient = Address::generate(&env);

        let token_a_contract = env.register_stellar_asset_contract_v2(admin.clone());
        let token_b_contract = env.register_stellar_asset_contract_v2(fee_recipient.clone());
        let token_a = token_a_contract.address();
        let token_b = token_b_contract.address();

        client.initialize(&admin, &1000, &50, &fee_recipient); // 0.5% fee, 1000 min stake

        (
            env,
            client,
            admin,
            fee_recipient,
            token_a,
            token_b,
            contract_id,
        )
    }

    fn mint_tokens(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
        let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    #[test]
    fn test_initialize() {
        let (_, client, _, _, _, _, _) = setup_env();
        assert_eq!(client.solver_count(), 0);
        assert_eq!(client.get_protocol_fee(), 50);
    }

    #[test]
    fn test_initialize_rejects_fee_above_max() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(IntentSwap, ());
        let client = IntentSwapClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let fee_recipient = Address::generate(&env);

        let result = client.try_initialize(&admin, &1000, &101, &fee_recipient);
        assert_eq!(result, Err(Ok(SwapError::InvalidFee)));
    }

    #[test]
    fn test_set_protocol_fee_bounds() {
        let (_, client, admin, _, _, _, _) = setup_env();

        // zero fee
        client.set_protocol_fee(&admin, &0);
        assert_eq!(client.get_protocol_fee(), 0);

        // normal fee
        client.set_protocol_fee(&admin, &50);
        assert_eq!(client.get_protocol_fee(), 50);

        // max fee
        client.set_protocol_fee(&admin, &100);
        assert_eq!(client.get_protocol_fee(), 100);

        // invalid fee above max
        let invalid = client.try_set_protocol_fee(&admin, &101);
        assert_eq!(invalid, Err(Ok(SwapError::InvalidFee)));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let (_, client, admin, fee_recipient, _, _, _) = setup_env();
        client.initialize(&admin, &1000, &50, &fee_recipient);
    }

    #[test]
    fn test_create_intent() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let user = Address::generate(&env);
        mint_tokens(&env, &token_a, &user, 10_000);

        env.ledger().set_timestamp(100);

        let intent_id = client.create_intent(
            &user,
            &token_a,
            &token_b,
            &10_000,
            &9_500, // min 9500 buy tokens
            &100,   // max combined fee
            &200,   // expires at ledger 200
            &false,
            &1,
            &client.get_domain(),
        );

        assert_eq!(intent_id, 1);
        let intent = client.get_intent(&intent_id);
        assert_eq!(intent.owner, user);
        assert_eq!(intent.sell_amount, 10_000);
        assert_eq!(intent.min_buy_amount, 9_500);
        assert_eq!(intent.status, IntentStatus::Open);
    }

    #[test]
    fn test_cancel_intent() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let user = Address::generate(&env);
        mint_tokens(&env, &token_a, &user, 10_000);

        env.ledger().set_timestamp(100);
        let intent_id = client.create_intent(
            &user,
            &token_a,
            &token_b,
            &10_000,
            &9_500,
            &100,
            &200,
            &false,
            &1,
            &client.get_domain(),
        );

        client.cancel_intent(&user, &intent_id);

        let intent = client.get_intent(&intent_id);
        assert_eq!(intent.status, IntentStatus::Cancelled);

        // Check tokens returned
        let token_client = token::Client::new(&env, &token_a);
        assert_eq!(token_client.balance(&user), 10_000);
    }

    #[test]
    fn test_solver_register_and_fill() {
        let (env, client, _admin, _, token_a, token_b, _) = setup_env();
        let user = Address::generate(&env);
        let solver_addr = Address::generate(&env);

        mint_tokens(&env, &token_a, &user, 10_000);
        mint_tokens(&env, &token_a, &solver_addr, 1_000); // for stake
        mint_tokens(&env, &token_b, &solver_addr, 20_000); // for filling

        env.ledger().set_timestamp(100);

        // Register solver
        client.register_solver(&solver_addr, &token_a, &1_000);
        assert_eq!(client.solver_count(), 1);

        // Create intent
        let intent_id = client.create_intent(
            &user,
            &token_a,
            &token_b,
            &10_000,
            &9_500,
            &100,
            &200,
            &false,
            &1,
            &client.get_domain(),
        );

        // Fill intent — solver provides 10_000 buy tokens
        client.fill_intent(&solver_addr, &intent_id, &10_000, &10_000, &0, &100);

        let intent = client.get_intent(&intent_id);
        assert_eq!(intent.status, IntentStatus::Filled);

        // User should have received buy tokens minus 0.5% fee
        let buy_client = token::Client::new(&env, &token_b);
        // 10000 - 50bps fee = 10000 - 50 = 9950
        assert_eq!(buy_client.balance(&user), 9_950);
    }

    #[test]
    fn test_partial_fill() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let user = Address::generate(&env);
        let solver_addr = Address::generate(&env);

        mint_tokens(&env, &token_a, &user, 10_000);
        mint_tokens(&env, &token_a, &solver_addr, 1_000);
        mint_tokens(&env, &token_b, &solver_addr, 20_000);

        env.ledger().set_timestamp(100);

        client.register_solver(&solver_addr, &token_a, &1_000);

        // Create intent with partial fill enabled
        let intent_id = client.create_intent(
            &user,
            &token_a,
            &token_b,
            &10_000,
            &9_500,
            &100,
            &200,
            &true,
            &1,
            &client.get_domain(),
        );

        // Partial fill — only 5000 of 10000
        client.fill_intent(&solver_addr, &intent_id, &5_000, &5_000, &0, &100);

        let intent = client.get_intent(&intent_id);
        assert_eq!(intent.status, IntentStatus::Open); // Still open
        assert_eq!(intent.filled_sell, 5_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_insufficient_output_panics() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let user = Address::generate(&env);
        let solver_addr = Address::generate(&env);

        mint_tokens(&env, &token_a, &user, 10_000);
        mint_tokens(&env, &token_a, &solver_addr, 1_000);
        mint_tokens(&env, &token_b, &solver_addr, 20_000);

        env.ledger().set_timestamp(100);

        client.register_solver(&solver_addr, &token_a, &1_000);
        let intent_id = client.create_intent(
            &user,
            &token_a,
            &token_b,
            &10_000,
            &9_500,
            &100,
            &200,
            &false,
            &1,
            &client.get_domain(),
        );

        // Try to fill with less than min_buy_amount
        client.fill_intent(&solver_addr, &intent_id, &5_000, &10_000, &0, &100);
    }

    #[test]
    fn test_expire_intent() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let user = Address::generate(&env);

        mint_tokens(&env, &token_a, &user, 10_000);

        env.ledger().set_timestamp(100);
        let intent_id = client.create_intent(
            &user,
            &token_a,
            &token_b,
            &10_000,
            &9_500,
            &100,
            &200,
            &false,
            &1,
            &client.get_domain(),
        );

        // Advance time past expiry
        env.ledger().set_timestamp(201);
        client.expire_intent(&intent_id);

        let intent = client.get_intent(&intent_id);
        assert_eq!(intent.status, IntentStatus::Expired);

        // Tokens returned
        let token_client = token::Client::new(&env, &token_a);
        assert_eq!(token_client.balance(&user), 10_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn test_unregistered_solver_panics() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let user = Address::generate(&env);
        let rando = Address::generate(&env);

        mint_tokens(&env, &token_a, &user, 10_000);
        mint_tokens(&env, &token_b, &rando, 20_000);

        env.ledger().set_timestamp(100);
        let intent_id = client.create_intent(
            &user,
            &token_a,
            &token_b,
            &10_000,
            &9_500,
            &100,
            &200,
            &false,
            &1,
            &client.get_domain(),
        );

        // Non-registered solver tries to fill
        client.fill_intent(&rando, &intent_id, &10_000, &10_000, &0, &100);
    }

    #[test]
    fn test_solver_withdraw_stake() {
        let (env, client, _, _, token_a, _, _) = setup_env();
        let solver_addr = Address::generate(&env);

        mint_tokens(&env, &token_a, &solver_addr, 2_000);

        client.register_solver(&solver_addr, &token_a, &1_500);
        assert_eq!(client.get_solver_stake(&solver_addr), 1_500);
        assert_eq!(client.solver_count(), 1);

        client.withdraw_stake(&solver_addr, &token_a);
        assert_eq!(client.get_solver_stake(&solver_addr), 0);
        assert_eq!(client.solver_count(), 0);

        // Tokens returned
        let token_client = token::Client::new(&env, &token_a);
        assert_eq!(token_client.balance(&solver_addr), 2_000);
    }

    // ── Helpers for nonce, fee-cap, receipt and rollback tests ──────────

    /// Registers a solver staked in `stake_token` holding `buy_balance` of `buy_token`.
    fn funded_solver(
        env: &Env,
        client: &IntentSwapClient,
        stake_token: &Address,
        buy_token: &Address,
        buy_balance: i128,
    ) -> Address {
        let solver = Address::generate(env);
        mint_tokens(env, stake_token, &solver, 1_000);
        mint_tokens(env, buy_token, &solver, buy_balance);
        client.register_solver(&solver, stake_token, &1_000);
        solver
    }

    /// Opens a 10_000 → ≥9_500 intent (nonce 1) for a fresh owner.
    fn open_intent(
        env: &Env,
        client: &IntentSwapClient,
        sell_token: &Address,
        buy_token: &Address,
        max_fee: i128,
        partial_fill: bool,
    ) -> (Address, u64) {
        let owner = Address::generate(env);
        mint_tokens(env, sell_token, &owner, 10_000);
        env.ledger().set_timestamp(100);
        let intent_id = client.create_intent(
            &owner,
            sell_token,
            buy_token,
            &10_000,
            &9_500,
            &max_fee,
            &200,
            &partial_fill,
            &1,
            &client.get_domain(),
        );
        (owner, intent_id)
    }

    /// Settlement receipts published by the last top-level invocation.
    fn receipts(env: &Env) -> soroban_sdk::Vec<SettlementReceipt> {
        let mut out = soroban_sdk::Vec::new(env);
        for (_, topics, data) in env.events().all().iter() {
            let is_receipt = Symbol::try_from_val(env, &topics.get_unchecked(0))
                .is_ok_and(|tag| tag == symbol_short!("receipt"));
            if is_receipt {
                out.push_back(SettlementReceipt::try_from_val(env, &data).unwrap());
            }
        }
        out
    }

    /// Must run directly after a rejected fill. Asserts it left no partial
    /// effects (no receipt, intent untouched, no buy tokens moved) and that
    /// the full escrow is still recoverable, i.e. no balance is stranded.
    fn assert_rolled_back_and_refundable(
        env: &Env,
        client: &IntentSwapClient,
        intent_id: u64,
        buy_token: &Address,
        solver: &Address,
        solver_buy_before: i128,
    ) {
        assert_eq!(receipts(env).len(), 0);

        let intent = client.get_intent(&intent_id);
        assert_eq!(intent.status, IntentStatus::Open);
        assert_eq!(intent.filled_sell, 0);
        assert_eq!(intent.filled_buy, 0);
        assert_eq!(intent.fill_count, 0);
        assert!(client.try_get_solution(&intent_id).is_err());

        let buy = token::Client::new(env, buy_token);
        assert_eq!(buy.balance(&intent.owner), 0);
        assert_eq!(buy.balance(solver), solver_buy_before);

        let sell = token::Client::new(env, &intent.sell_token);
        let contract_before = sell.balance(&client.address);
        client.cancel_intent(&intent.owner, &intent_id);
        assert_eq!(sell.balance(&intent.owner), intent.sell_amount);
        assert_eq!(
            sell.balance(&client.address),
            contract_before - intent.sell_amount
        );
    }

    // ── #1491 Nonce invalidation ─────────────────────────────────────────

    #[test]
    fn test_cancel_nonce_rejects_later_fills_and_refunds() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (owner, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        client.cancel_nonce(&owner, &1);

        assert_eq!(
            client.get_intent(&intent_id).status,
            IntentStatus::Cancelled
        );
        assert_eq!(token::Client::new(&env, &token_a).balance(&owner), 10_000);
        assert_eq!(
            client.try_fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &100),
            Err(Ok(SwapError::IntentNotOpen))
        );
        assert_eq!(
            client.try_cancel_nonce(&owner, &1),
            Err(Ok(SwapError::NonceUsed))
        );
    }

    #[test]
    fn test_nonce_replay_rejected() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (owner, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);
        mint_tokens(&env, &token_a, &owner, 10_000);

        client.fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &100);

        // A consumed nonce can neither back a new intent nor be cancelled
        assert_eq!(
            client.try_create_intent(
                &owner,
                &token_a,
                &token_b,
                &10_000,
                &9_500,
                &100,
                &200,
                &false,
                &1,
                &client.get_domain()
            ),
            Err(Ok(SwapError::NonceUsed))
        );
        assert_eq!(
            client.try_cancel_nonce(&owner, &1),
            Err(Ok(SwapError::NonceUsed))
        );

        // A nonce cancelled before use can never back an intent
        client.cancel_nonce(&owner, &7);
        assert_eq!(
            client.try_create_intent(
                &owner,
                &token_a,
                &token_b,
                &10_000,
                &9_500,
                &100,
                &200,
                &false,
                &7,
                &client.get_domain()
            ),
            Err(Ok(SwapError::NonceUsed))
        );
        assert_eq!(token::Client::new(&env, &token_a).balance(&owner), 10_000);
    }

    #[test]
    fn test_nonces_are_independent() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (owner, first_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);
        mint_tokens(&env, &token_a, &owner, 10_000);
        let second_id = client.create_intent(
            &owner,
            &token_a,
            &token_b,
            &10_000,
            &9_500,
            &100,
            &200,
            &false,
            &2,
            &client.get_domain(),
        );

        client.cancel_nonce(&owner, &1);

        // Nonce 2 of the same owner is unaffected
        client.fill_intent(&solver, &second_id, &10_000, &10_000, &0, &100);
        assert_eq!(client.get_intent(&first_id).status, IntentStatus::Cancelled);
        assert_eq!(client.get_intent(&second_id).status, IntentStatus::Filled);

        // Nonces are scoped per owner
        let (_, other_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);
        assert_eq!(client.get_intent(&other_id).status, IntentStatus::Open);
    }

    // ── #1492 Signed fee caps ────────────────────────────────────────────

    #[test]
    fn test_protocol_fee_alone_capped_by_signed_max() {
        let (env, client, admin, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (owner, intent_id) = open_intent(&env, &client, &token_a, &token_b, 50, false);

        // Admin raises the fee after signing: 51 > signed cap of 50
        client.set_protocol_fee(&admin, &51);
        assert_eq!(
            client.try_fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &100),
            Err(Ok(SwapError::FeeCapExceeded))
        );

        // Exactly at the cap settles
        client.set_protocol_fee(&admin, &50);
        client.fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &100);
        assert_eq!(token::Client::new(&env, &token_b).balance(&owner), 9_950);
    }

    #[test]
    fn test_solver_fee_alone_capped_by_signed_max() {
        let (env, client, admin, _, token_a, token_b, _) = setup_env();
        client.set_protocol_fee(&admin, &0);
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (owner, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        for solver_fee in [101, i128::MAX] {
            assert_eq!(
                client.try_fill_intent(&solver, &intent_id, &10_000, &10_000, &solver_fee, &100),
                Err(Ok(SwapError::FeeCapExceeded))
            );
        }

        client.fill_intent(&solver, &intent_id, &10_000, &10_000, &100, &100);
        let buy = token::Client::new(&env, &token_b);
        assert_eq!(buy.balance(&owner), 9_900);
        // Solver retains its fee: pays only 9_900 out of 20_000
        assert_eq!(buy.balance(&solver), 10_100);
    }

    #[test]
    fn test_combined_fees_capped_by_signed_max() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (owner, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        // protocol 50 and solver 51 each fit the cap of 100; their sum does not
        assert_eq!(
            client.try_fill_intent(&solver, &intent_id, &10_000, &10_000, &51, &100),
            Err(Ok(SwapError::FeeCapExceeded))
        );

        client.fill_intent(&solver, &intent_id, &10_000, &10_000, &50, &100);
        let buy = token::Client::new(&env, &token_b);
        assert_eq!(buy.balance(&owner), 9_900);
        assert_eq!(buy.balance(&solver), 20_000 - 9_900 - 50);
    }

    #[test]
    fn test_fee_cap_pro_rated_for_partial_fill() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (_, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, true);

        // Half fill → cap 50; protocol 25 + solver 26 = 51
        assert_eq!(
            client.try_fill_intent(&solver, &intent_id, &5_000, &5_000, &26, &100),
            Err(Ok(SwapError::FeeCapExceeded))
        );
        client.fill_intent(&solver, &intent_id, &5_000, &5_000, &25, &100);
        assert_eq!(client.get_intent(&intent_id).filled_buy, 4_950);
    }

    #[test]
    fn test_invalid_fee_inputs_rejected() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let owner = Address::generate(&env);
        mint_tokens(&env, &token_a, &owner, 10_000);
        env.ledger().set_timestamp(100);

        for max_fee in [-1, 9_500] {
            assert_eq!(
                client.try_create_intent(
                    &owner,
                    &token_a,
                    &token_b,
                    &10_000,
                    &9_500,
                    &max_fee,
                    &200,
                    &false,
                    &1,
                    &client.get_domain()
                ),
                Err(Ok(SwapError::InvalidFee))
            );
        }

        let intent_id = client.create_intent(
            &owner,
            &token_a,
            &token_b,
            &10_000,
            &9_500,
            &100,
            &200,
            &false,
            &1,
            &client.get_domain(),
        );
        assert_eq!(
            client.try_fill_intent(&solver, &intent_id, &10_000, &10_000, &-1, &100),
            Err(Ok(SwapError::InvalidFee))
        );
    }

    // ── #1493 Settlement receipts ────────────────────────────────────────

    #[test]
    fn test_fill_emits_exactly_one_receipt() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (_, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        client.fill_intent(&solver, &intent_id, &10_000, &10_000, &20, &100);

        let receipts = receipts(&env);
        assert_eq!(receipts.len(), 1);
        assert_eq!(
            receipts.get_unchecked(0),
            SettlementReceipt {
                intent_id,
                solver,
                input_amount: 10_000,
                output_amount: 9_930,
                protocol_fee: 50,
                solver_fee: 20,
                ledger: env.ledger().sequence(),
                fill_index: 1,
            }
        );
    }

    #[test]
    fn test_each_partial_fill_emits_one_indexed_receipt() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (_, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, true);

        for fill_index in 1..=2u32 {
            client.fill_intent(&solver, &intent_id, &5_000, &5_000, &0, &100);
            let receipts = receipts(&env);
            assert_eq!(receipts.len(), 1);
            assert_eq!(receipts.get_unchecked(0).fill_index, fill_index);
        }
        assert_eq!(client.get_intent(&intent_id).status, IntentStatus::Filled);
    }

    #[test]
    fn test_rejected_execution_emits_no_receipt() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (_, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        assert_eq!(
            client.try_fill_intent(&solver, &intent_id, &10_000, &10_000, &51, &100),
            Err(Ok(SwapError::FeeCapExceeded))
        );
        assert_rolled_back_and_refundable(&env, &client, intent_id, &token_b, &solver, 20_000);
    }

    // ── #1494 Atomic rollback on a failed settlement leg ─────────────────

    // A failing token leg propagates the Stellar Asset Contract's own error
    // code, which the typed client decodes into the `SwapError` sharing it.
    const SAC_BALANCE_ERROR: u32 = 10;
    const SAC_BALANCE_DEAUTHORIZED_ERROR: u32 = 11;

    #[test]
    fn test_owner_payment_leg_failure_rolls_back() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        // Cannot cover the 9_950 owner payment
        let solver = funded_solver(&env, &client, &token_a, &token_b, 9_000);
        let (_, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        let err = client
            .try_fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &100)
            .unwrap_err()
            .unwrap();
        assert_eq!(err as u32, SAC_BALANCE_ERROR);
        assert_rolled_back_and_refundable(&env, &client, intent_id, &token_b, &solver, 9_000);
    }

    #[test]
    fn test_protocol_fee_leg_failure_rolls_back() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        // Covers the 9_950 owner payment, but not the 50 protocol fee after it
        let solver = funded_solver(&env, &client, &token_a, &token_b, 9_950);
        let (_, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        let err = client
            .try_fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &100)
            .unwrap_err()
            .unwrap();
        assert_eq!(err as u32, SAC_BALANCE_ERROR);
        // The already-executed owner payment is reverted too
        assert_rolled_back_and_refundable(&env, &client, intent_id, &token_b, &solver, 9_950);
    }

    #[test]
    fn test_escrow_release_leg_failure_rolls_back() {
        let (env, client, admin, _, token_a, token_b, _) = setup_env();
        let sell_sac = env.register_stellar_asset_contract_v2(admin.clone());
        sell_sac.issuer().set_flag(IssuerFlags::RevocableFlag);
        let sell_token = sell_sac.address();

        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (_, intent_id) = open_intent(&env, &client, &sell_token, &token_b, 100, false);

        // Solver cannot receive the escrowed sell tokens: final leg fails
        soroban_sdk::token::StellarAssetClient::new(&env, &sell_token)
            .set_authorized(&solver, &false);

        let err = client
            .try_fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &100)
            .unwrap_err()
            .unwrap();
        assert_eq!(err as u32, SAC_BALANCE_DEAUTHORIZED_ERROR);
        // Both buy-side legs already executed are reverted
        assert_rolled_back_and_refundable(&env, &client, intent_id, &token_b, &solver, 20_000);
    }

    #[test]
    fn test_fill_after_expiry_keeps_escrow_refundable() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (owner, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        env.ledger().set_timestamp(200);
        assert_eq!(
            client.try_fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &100),
            Err(Ok(SwapError::IntentExpired))
        );
        assert_eq!(client.get_intent(&intent_id).status, IntentStatus::Open);

        client.expire_intent(&intent_id);
        assert_eq!(client.get_intent(&intent_id).status, IntentStatus::Expired);
        assert_eq!(token::Client::new(&env, &token_a).balance(&owner), 10_000);
    }

    // ── #1488 Network-bound signature domain ─────────────────────────────

    const PUBNET: &str = "Public Global Stellar Network ; September 2015";
    const TESTNET: &str = "Test SDF Network ; September 2015";

    fn network_id(env: &Env, passphrase: &str) -> BytesN<32> {
        env.crypto()
            .sha256(&Bytes::from_slice(env, passphrase.as_bytes()))
            .to_bytes()
    }

    #[test]
    fn test_intent_signed_for_current_network_is_accepted() {
        let (env, client, _, _, token_a, token_b, contract_id) = setup_env();
        env.ledger()
            .set_network_id(network_id(&env, PUBNET).to_array());
        let owner = Address::generate(&env);
        mint_tokens(&env, &token_a, &owner, 10_000);
        env.ledger().set_timestamp(100);

        let domain = IntentDomain {
            network_id: network_id(&env, PUBNET),
            verifying_contract: contract_id,
        };
        assert_eq!(client.get_domain(), domain);
        let intent_id = client.create_intent(
            &owner, &token_a, &token_b, &10_000, &9_500, &100, &200, &false, &1, &domain,
        );
        assert_eq!(client.get_intent(&intent_id).status, IntentStatus::Open);
    }

    #[test]
    fn test_cross_network_replay_rejected() {
        let (env, client, _, _, token_a, token_b, contract_id) = setup_env();
        env.ledger()
            .set_network_id(network_id(&env, PUBNET).to_array());
        let owner = Address::generate(&env);
        mint_tokens(&env, &token_a, &owner, 10_000);
        env.ledger().set_timestamp(100);

        let testnet_intent = IntentDomain {
            network_id: network_id(&env, TESTNET),
            verifying_contract: contract_id,
        };
        let other_deployment = IntentDomain {
            network_id: network_id(&env, PUBNET),
            verifying_contract: env.register(IntentSwap, ()),
        };
        for domain in [testnet_intent, other_deployment] {
            assert_eq!(
                client.try_create_intent(
                    &owner, &token_a, &token_b, &10_000, &9_500, &100, &200, &false, &1, &domain
                ),
                Err(Ok(SwapError::DomainMismatch))
            );
        }

        // Rejected before escrow and nonce use
        assert_eq!(token::Client::new(&env, &token_a).balance(&owner), 10_000);
        client.create_intent(
            &owner,
            &token_a,
            &token_b,
            &10_000,
            &9_500,
            &100,
            &200,
            &false,
            &1,
            &client.get_domain(),
        );
    }

    // ── #1489 Solver quote freshness ─────────────────────────────────────

    #[test]
    fn test_quote_settles_up_to_max_age_inclusive() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (_, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        // Ledger time 100: a quote from 70 is exactly the default 30 s old
        assert_eq!(client.get_max_quote_age(), 30);
        client.fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &70);
        assert_eq!(client.get_intent(&intent_id).status, IntentStatus::Filled);
    }

    #[test]
    fn test_expired_quote_rejected() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (_, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        assert_eq!(
            client.try_fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &69),
            Err(Ok(SwapError::QuoteExpired))
        );
        assert_rolled_back_and_refundable(&env, &client, intent_id, &token_b, &solver, 20_000);
    }

    #[test]
    fn test_future_dated_quote_rejected() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (_, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        assert_eq!(
            client.try_fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &101),
            Err(Ok(SwapError::QuoteFromFuture))
        );
        assert_rolled_back_and_refundable(&env, &client, intent_id, &token_b, &solver, 20_000);
    }

    #[test]
    fn test_admin_sets_max_quote_age() {
        let (env, client, admin, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (_, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        let outsider = Address::generate(&env);
        assert_eq!(
            client.try_set_max_quote_age(&outsider, &0),
            Err(Ok(SwapError::Unauthorized))
        );

        // Zero admits only quotes priced at the settling ledger's close time
        client.set_max_quote_age(&admin, &0);
        assert_eq!(client.get_max_quote_age(), 0);
        assert_eq!(
            client.try_fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &99),
            Err(Ok(SwapError::QuoteExpired))
        );
        client.fill_intent(&solver, &intent_id, &10_000, &10_000, &0, &100);
    }

    // ── #1490 Net minimum across fills ───────────────────────────────────

    #[test]
    fn test_single_fill_net_output_must_reach_minimum() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (owner, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, false);

        // 50 bps protocol fee on each is 47. Gross 9_500 meets the minimum but
        // nets 9_453; 9_546 nets 9_499; 9_548 less a solver fee of 2 nets 9_499.
        for (buy_amount, solver_fee) in [(9_500, 0), (9_546, 0), (9_548, 2)] {
            assert_eq!(
                client.try_fill_intent(
                    &solver,
                    &intent_id,
                    &buy_amount,
                    &10_000,
                    &solver_fee,
                    &100
                ),
                Err(Ok(SwapError::InsufficientOutput))
            );
        }

        client.fill_intent(&solver, &intent_id, &9_547, &10_000, &0, &100);
        assert_eq!(token::Client::new(&env, &token_b).balance(&owner), 9_500);
    }

    #[test]
    fn test_partial_fills_cannot_round_below_minimum_together() {
        let (env, client, admin, _, token_a, token_b, _) = setup_env();
        client.set_protocol_fee(&admin, &0);
        let solver = funded_solver(&env, &client, &token_a, &token_b, 20_000);
        let (owner, intent_id) = open_intent(&env, &client, &token_a, &token_b, 100, true);

        // Legs of 3_333, 3_333 and 3_334 owe 3_166.35, 3_166.35 and 3_167.3.
        // Flooring each would settle 9_499 in total; the cumulative minimum is
        // rounded up, so the legs owe 3_167, 3_166 and 3_167.
        for (fill_sell, owed) in [(3_333, 3_167), (3_333, 3_166), (3_334, 3_167)] {
            // One unit short, by gross output or by the solver's fee
            for (buy_amount, solver_fee) in [(owed - 1, 0), (owed + 1, 2)] {
                assert_eq!(
                    client.try_fill_intent(
                        &solver,
                        &intent_id,
                        &buy_amount,
                        &fill_sell,
                        &solver_fee,
                        &100
                    ),
                    Err(Ok(SwapError::InsufficientOutput))
                );
            }
            client.fill_intent(&solver, &intent_id, &owed, &fill_sell, &0, &100);
        }

        let intent = client.get_intent(&intent_id);
        assert_eq!(intent.status, IntentStatus::Filled);
        assert_eq!(intent.filled_buy, 9_500);
        assert_eq!(token::Client::new(&env, &token_b).balance(&owner), 9_500);
    }

    /// A buy token that accepts any transfer, as a non-SAC token may.
    #[contract]
    struct PermissiveToken;

    #[contractimpl]
    impl PermissiveToken {
        pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
    }

    #[test]
    fn test_negative_net_leg_rejected_after_over_delivery() {
        let (env, client, admin, _, token_a, _, _) = setup_env();
        client.set_protocol_fee(&admin, &0);
        let buy_token = env.register(PermissiveToken, ());
        let solver = Address::generate(&env);
        mint_tokens(&env, &token_a, &solver, 1_000);
        client.register_solver(&solver, &token_a, &1_000);
        let (_, intent_id) = open_intent(&env, &client, &token_a, &buy_token, 100, true);

        // The first leg over-delivers, so the cumulative minimum alone would
        // admit a later leg that pays the owner a negative amount.
        client.fill_intent(&solver, &intent_id, &9_000, &5_000, &0, &100);
        assert_eq!(
            client.try_fill_intent(&solver, &intent_id, &-100, &1, &0, &100),
            Err(Ok(SwapError::InsufficientOutput))
        );
        assert_eq!(client.get_intent(&intent_id).filled_sell, 5_000);
    }
}
