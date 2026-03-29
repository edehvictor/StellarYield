#![no_std]

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
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
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
}

// ── Data Structures ─────────────────────────────────────────────────────

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
    pub expiry: u64,
    pub status: IntentStatus,
    pub created_at: u64,
    pub partial_fill: bool,
    pub filled_sell: i128,
    pub filled_buy: i128,
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
}

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct IntentSwap;

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
    /// * `expiry` — Ledger timestamp after which the intent expires
    /// * `partial_fill` — Whether partial fills are allowed
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
        expiry: u64,
        partial_fill: bool,
    ) -> Result<u64, SwapError> {
        Self::require_init(&env)?;
        owner.require_auth();

        if sell_amount <= 0 || min_buy_amount <= 0 {
            return Err(SwapError::ZeroAmount);
        }

        let now = env.ledger().timestamp();
        if expiry <= now {
            return Err(SwapError::InvalidExpiry);
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
            expiry,
            status: IntentStatus::Open,
            created_at: now,
            partial_fill,
            filled_sell: 0,
            filled_buy: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Intent(intent_id), &intent);
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

        intent.status = IntentStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Intent(intent_id), &intent);

        // Return remaining escrowed sell tokens
        let remaining = intent.sell_amount - intent.filled_sell;
        if remaining > 0 {
            let sell_client = token::Client::new(&env, &intent.sell_token);
            sell_client.transfer(&env.current_contract_address(), &owner, &remaining);
        }

        env.events()
            .publish((symbol_short!("cancel"),), (intent_id,));

        Ok(())
    }

    // ── Solver Fills Intent ─────────────────────────────────────────

    /// A registered solver fills an open intent by providing buy tokens
    /// and receiving the escrowed sell tokens.
    ///
    /// The solver must provide at least `min_buy_amount` of buy tokens.
    /// A protocol fee is deducted from the buy tokens before delivery.
    ///
    /// # Arguments
    /// * `solver` — Registered solver address (must authorize)
    /// * `intent_id` — The intent to fill
    /// * `buy_amount` — Amount of buy tokens the solver provides
    /// * `sell_amount` — Amount of sell tokens the solver wants (for partial fills)
    pub fn fill_intent(
        env: Env,
        solver: Address,
        intent_id: u64,
        buy_amount: i128,
        sell_amount: i128,
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

        // Check expiry
        let now = env.ledger().timestamp();
        if now >= intent.expiry {
            intent.status = IntentStatus::Expired;
            env.storage()
                .persistent()
                .set(&DataKey::Intent(intent_id), &intent);
            return Err(SwapError::IntentExpired);
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

        // Calculate proportional min_buy for this chunk
        let proportional_min_buy = if intent.partial_fill {
            (intent.min_buy_amount * fill_sell) / intent.sell_amount
        } else {
            intent.min_buy_amount
        };

        if buy_amount < proportional_min_buy {
            return Err(SwapError::InsufficientOutput);
        }

        // Calculate protocol fee
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProtocolFeeBps)
            .unwrap_or(0);
        let protocol_fee = (buy_amount * fee_bps as i128) / 10_000;
        let user_receives = buy_amount - protocol_fee;

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
            (intent_id, solver, fill_sell, user_receives),
        );

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

        intent.status = IntentStatus::Expired;
        env.storage()
            .persistent()
            .set(&DataKey::Intent(intent_id), &intent);

        // Return remaining escrowed tokens
        let remaining = intent.sell_amount - intent.filled_sell;
        if remaining > 0 {
            let sell_client = token::Client::new(&env, &intent.sell_token);
            sell_client.transfer(&env.current_contract_address(), &intent.owner, &remaining);
        }

        env.events()
            .publish((symbol_short!("expire"),), (intent_id,));

        Ok(())
    }

    // ── Admin ───────────────────────────────────────────────────────

    /// Update protocol fee. Admin only.
    pub fn set_protocol_fee(env: Env, admin: Address, fee_bps: u32) -> Result<(), SwapError> {
        Self::require_admin(&env, &admin)?;
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

    // ── View Functions ──────────────────────────────────────────────

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
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::Env;

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
            &user, &token_a, &token_b, &10_000, &9_500, // min 9500 buy tokens
            &200,   // expires at ledger 200
            &false,
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
        let intent_id =
            client.create_intent(&user, &token_a, &token_b, &10_000, &9_500, &200, &false);

        client.cancel_intent(&user, &intent_id);

        let intent = client.get_intent(&intent_id);
        assert_eq!(intent.status, IntentStatus::Cancelled);

        // Check tokens returned
        let token_client = token::Client::new(&env, &token_a);
        assert_eq!(token_client.balance(&user), 10_000);
    }

    #[test]
    fn test_solver_register_and_fill() {
        let (env, client, admin, _, token_a, token_b, _) = setup_env();
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
        let intent_id =
            client.create_intent(&user, &token_a, &token_b, &10_000, &9_500, &200, &false);

        // Fill intent — solver provides 10_000 buy tokens
        client.fill_intent(&solver_addr, &intent_id, &10_000, &10_000);

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
        let intent_id =
            client.create_intent(&user, &token_a, &token_b, &10_000, &9_500, &200, &true);

        // Partial fill — only 5000 of 10000
        client.fill_intent(&solver_addr, &intent_id, &5_000, &5_000);

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
        let intent_id =
            client.create_intent(&user, &token_a, &token_b, &10_000, &9_500, &200, &false);

        // Try to fill with less than min_buy_amount
        client.fill_intent(&solver_addr, &intent_id, &5_000, &10_000);
    }

    #[test]
    fn test_expire_intent() {
        let (env, client, _, _, token_a, token_b, _) = setup_env();
        let user = Address::generate(&env);

        mint_tokens(&env, &token_a, &user, 10_000);

        env.ledger().set_timestamp(100);
        let intent_id =
            client.create_intent(&user, &token_a, &token_b, &10_000, &9_500, &200, &false);

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
        let intent_id =
            client.create_intent(&user, &token_a, &token_b, &10_000, &9_500, &200, &false);

        // Non-registered solver tries to fill
        client.fill_intent(&rando, &intent_id, &10_000, &10_000);
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
}
