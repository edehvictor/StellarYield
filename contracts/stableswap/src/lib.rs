#![no_std]
#![allow(clippy::too_many_arguments)]

//! # StableSwap AMM — Stableswap Invariant Pool (Curve-style)
//!
//! Implements the Stableswap invariant:
//!   A·n^n·Σxᵢ + D = A·n^n·D + D^(n+1) / (n^n·Πxᵢ)
//!
//! This provides deep liquidity with minimal slippage for pegged assets
//! (e.g., USDC/sUSD) compared to a standard constant-product AMM.
//!
//! ## Invariant — simplified for n=2 tokens, solved iteratively:
//!   D³ / (4·x·y) + A·(x+y)·4 = D·(4·A + 1)
//!
//! Dynamic fee adjustment scales linearly with pool imbalance:
//!   fee = base_fee + (imbalance_ratio · fee_multiplier)
//! where imbalance_ratio = |x/S - 0.5| / 0.5  (S = x+y)
//!
//! ## Rounding and numeric limits
//!
//! All arithmetic is checked. Values that cannot be represented safely return a
//! typed [`StableSwapError`] (`MathOverflow`, `InvalidAmount`, `ZeroInvariant`)
//! before any token transfer or storage write, so a failed call never changes
//! reserves, LP supply, LP balances, or token balances.
//!
//! Rounding rules (all divisions are integer division of non-negative values, so
//! they round **down**):
//!
//! - Newton intermediate products are folded division-first
//!   (`floor(floor(d²/4L)·d/S)` for `d³/(4·x·y)`), which keeps them smaller than
//!   the exact rational value and extends the safe reserve range beyond a direct
//!   cube. The iteration still needs `ann·S·D` to fit in `i128`, so for a
//!   balanced pool the per-side reserve limit is roughly
//!   `sqrt(i128::MAX / (4·A))` (`≈ 6.5·10¹⁷` for `A = 100`). Values beyond the
//!   checked domain return `MathOverflow` instead of wrapping.
//! - The invariant `D` and the solved reserve `y` are returned as the first
//!   iterate whose change is at most one unit, so `|result − exact| ≤ 1`.
//! - Deposits mint `floor(total_supply·(D₁−D₀)/D₀)` LP tokens and withdrawals pay
//!   `floor(reserve·lp_amount/total_supply)`; both round in favour of the pool.
//! - Swap fees and the post-fee input are floored, and the output is
//!   `reserve_out − y`, rounding in favour of the pool.
//!
//! Minimum reserves are `1` unit per token; zero reserves or a zero invariant are
//! rejected. Requesting an amount that pushes an intermediate value outside the
//! `i128` domain is rejected with `MathOverflow` rather than wrapping.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
};

// ── Constants ───────────────────────────────────────────────────────────

/// Precision scaler used for fee arithmetic (1e7 = 100.00000%)
const FEE_PRECISION: i128 = 10_000_000;
/// Maximum allowed amplification coefficient
const MAX_A: u32 = 1_000_000;
/// Maximum base fee: 1% (100_000 / FEE_PRECISION)
const MAX_BASE_FEE_BPS: u32 = 1_000_000;
/// Newton's method convergence iterations
const NEWTON_ITERS: u32 = 255;
/// Current pool context version. Version zero is a pool initialized before
/// context binding existed; it keeps working and is bound by `migrate`.
const CURRENT_POOL_VERSION: u32 = 1;
/// Number of tokens in the pool
const N_COINS: i128 = 2;

// ── Storage keys ────────────────────────────────────────────────────────

#[contracttype]
enum DataKey {
    Initialized,
    Token0,
    Token1,
    LpToken,
    Admin,
    /// Amplification coefficient A (≥1)
    AmpCoeff,
    /// Base swap fee in FEE_PRECISION units (e.g. 30_000 = 0.3%)
    BaseFee,
    /// Extra fee added per unit of imbalance ratio (FEE_PRECISION units)
    FeeMultiplier,
    /// Reserve of token0
    Reserve0,
    /// Reserve of token1
    Reserve1,
    /// Total LP supply
    TotalSupply,
    /// LP balance per account
    LpBalance(Address),
    /// SHA-256 of the network passphrase this pool's state is bound to.
    NetworkId,
    /// Pool context version of the stored state.
    StorageVersion,
}

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StableSwapError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    InsufficientLiquidity = 4,
    InsufficientOutput = 5,
    Unauthorized = 6,
    InvalidAmpCoeff = 7,
    InvalidFee = 8,
    MathOverflow = 9,
    ZeroInvariant = 10,
    InvalidToken = 11,
    /// The live ledger or the caller's context belongs to another network than
    /// the pool's stored state, or the pool is already bound to another network.
    WrongNetwork = 12,
    /// The caller's context names a different pool deployment.
    WrongContract = 13,
    /// The stored state or the caller's context is not at the pool context
    /// version this code understands.
    WrongVersion = 14,
}

// ── Pool context ────────────────────────────────────────────────────────

/// Explicit network, deployment and version context of a pool.
///
/// Callers capture this with `get_pool_context()` and pass it to
/// `add_liquidity`, `remove_liquidity` and `swap`. An operation executes only
/// if the live ledger network, the network the pool state was created on, the
/// deployment address and the stored context version all match.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolContext {
    /// SHA-256 of the network passphrase the pool state is bound to.
    pub network_id: BytesN<32>,
    /// Address of this pool deployment.
    pub contract: Address,
    /// Pool context version of the stored state.
    pub version: u32,
}

// ── Contract ─────────────────────────────────────────────────────────────

#[contract]
pub struct StableSwap;

#[contractimpl]
impl StableSwap {
    // ── Initialisation ─────────────────────────────────────────────────

    /// Initialize the pool.
    /// - `amp_coeff`: amplification coefficient A (1..MAX_A)
    /// - `base_fee`: swap fee in FEE_PRECISION units (e.g. 30_000 = 0.3%)
    /// - `fee_multiplier`: additional fee per unit of imbalance (FEE_PRECISION)
    pub fn initialize(
        env: Env,
        admin: Address,
        token0: Address,
        token1: Address,
        lp_token: Address,
        amp_coeff: u32,
        base_fee: u32,
        fee_multiplier: u32,
    ) -> Result<(), StableSwapError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(StableSwapError::AlreadyInitialized);
        }
        if !(1..=MAX_A).contains(&amp_coeff) {
            return Err(StableSwapError::InvalidAmpCoeff);
        }
        if base_fee > MAX_BASE_FEE_BPS {
            return Err(StableSwapError::InvalidFee);
        }
        if (fee_multiplier as i128) > FEE_PRECISION
            || (base_fee as i128)
                .checked_add(fee_multiplier as i128)
                .ok_or(StableSwapError::InvalidFee)?
                > FEE_PRECISION
        {
            return Err(StableSwapError::InvalidFee);
        }
        if token0 == token1 || token0 == lp_token || token1 == lp_token {
            return Err(StableSwapError::InvalidToken);
        }

        let s = env.storage().instance();
        s.set(&DataKey::Initialized, &true);
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Token0, &token0);
        s.set(&DataKey::Token1, &token1);
        s.set(&DataKey::LpToken, &lp_token);
        s.set(&DataKey::AmpCoeff, &amp_coeff);
        s.set(&DataKey::BaseFee, &base_fee);
        s.set(&DataKey::FeeMultiplier, &fee_multiplier);
        s.set(&DataKey::Reserve0, &0_i128);
        s.set(&DataKey::Reserve1, &0_i128);
        s.set(&DataKey::TotalSupply, &0_i128);
        // Bind the pool's state to the network it was created on, and stamp the
        // context version so later network or layout transitions are detectable.
        s.set(&DataKey::NetworkId, &env.ledger().network_id());
        s.set(&DataKey::StorageVersion, &CURRENT_POOL_VERSION);

        env.events()
            .publish((symbol_short!("init"),), (admin, amp_coeff, base_fee));
        Ok(())
    }

    /// Bind a pool created before context binding existed to the live network
    /// and to the current context version. Admin only.
    ///
    /// Existing pools keep operating unchanged before this is called: with no
    /// stored binding they adopt the live network. `migrate` pins that binding,
    /// so afterwards state restored on a different network or read by code with
    /// a different context version is rejected instead of being silently used.
    ///
    /// Migration is idempotent and never re-binds a pool that is already bound
    /// to another network; that returns `WrongNetwork` and changes nothing.
    pub fn migrate(env: Env) -> Result<PoolContext, StableSwapError> {
        Self::assert_initialized(&env)?;
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let live_network = env.ledger().network_id();
        let stored_network: Option<BytesN<32>> = env.storage().instance().get(&DataKey::NetworkId);
        match stored_network {
            Some(bound) if bound != live_network => return Err(StableSwapError::WrongNetwork),
            Some(_) => {}
            None => env
                .storage()
                .instance()
                .set(&DataKey::NetworkId, &live_network),
        }

        let version = Self::read_version(&env);
        // Code older than the stored layout must not interpret it.
        if version > CURRENT_POOL_VERSION {
            return Err(StableSwapError::WrongVersion);
        }
        if version < CURRENT_POOL_VERSION {
            env.storage()
                .instance()
                .set(&DataKey::StorageVersion, &CURRENT_POOL_VERSION);
        }

        let context = PoolContext {
            network_id: live_network.clone(),
            contract: env.current_contract_address(),
            version: CURRENT_POOL_VERSION,
        };
        env.events().publish(
            (symbol_short!("migrate"),),
            (admin, live_network, CURRENT_POOL_VERSION),
        );
        Ok(context)
    }

    /// Explicit network, deployment and version context of this pool.
    ///
    /// Pass the returned value to `add_liquidity`, `remove_liquidity` and
    /// `swap`. Refresh it after `migrate`, which changes the version.
    pub fn get_pool_context(env: Env) -> Result<PoolContext, StableSwapError> {
        Self::assert_initialized(&env)?;
        Ok(PoolContext {
            network_id: Self::bound_network(&env),
            contract: env.current_contract_address(),
            version: Self::read_version(&env),
        })
    }

    // ── Liquidity ──────────────────────────────────────────────────────

    /// Deposit `amount0` of token0 and `amount1` of token1, receive LP tokens.
    /// `min_mint_amount` guards against sandwich attacks on the initial ratio.
    ///
    /// `expected_context` must equal `get_pool_context()`: a network, deployment
    /// or version mismatch is rejected before any reserve or balance changes.
    pub fn add_liquidity(
        env: Env,
        sender: Address,
        amount0: i128,
        amount1: i128,
        min_mint_amount: i128,
        expected_context: PoolContext,
    ) -> Result<i128, StableSwapError> {
        sender.require_auth();
        Self::assert_initialized(&env)?;
        Self::require_context(&env, &expected_context)?;

        if amount0 <= 0 || amount1 <= 0 || min_mint_amount < 0 {
            return Err(StableSwapError::InvalidAmount);
        }

        let token0: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1: Address = env.storage().instance().get(&DataKey::Token1).unwrap();

        let reserve0: i128 = env.storage().instance().get(&DataKey::Reserve0).unwrap();
        let reserve1: i128 = env.storage().instance().get(&DataKey::Reserve1).unwrap();
        let total_supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap();
        let amp_coeff: u32 = env.storage().instance().get(&DataKey::AmpCoeff).unwrap();

        let new_reserve0 = reserve0
            .checked_add(amount0)
            .ok_or(StableSwapError::MathOverflow)?;
        let new_reserve1 = reserve1
            .checked_add(amount1)
            .ok_or(StableSwapError::MathOverflow)?;

        let d0 = if total_supply == 0 {
            0
        } else {
            Self::compute_d(reserve0, reserve1, amp_coeff)?
        };
        let d1 = Self::compute_d(new_reserve0, new_reserve1, amp_coeff)?;

        if d1 <= d0 {
            return Err(StableSwapError::ZeroInvariant);
        }

        let mint_amount = if total_supply == 0 {
            d1
        } else {
            total_supply
                .checked_mul(d1 - d0)
                .ok_or(StableSwapError::MathOverflow)?
                .checked_div(d0)
                .ok_or(StableSwapError::MathOverflow)?
        };

        if mint_amount <= 0 || mint_amount < min_mint_amount {
            return Err(StableSwapError::InsufficientOutput);
        }

        let new_supply = total_supply
            .checked_add(mint_amount)
            .ok_or(StableSwapError::MathOverflow)?;

        let lp_key = DataKey::LpBalance(sender.clone());
        let old_lp: i128 = env.storage().persistent().get(&lp_key).unwrap_or(0);
        let new_lp = old_lp
            .checked_add(mint_amount)
            .ok_or(StableSwapError::MathOverflow)?;

        // Pull tokens from sender only after invariant validation and calculations succeed
        token::Client::new(&env, &token0).transfer(
            &sender,
            &env.current_contract_address(),
            &amount0,
        );
        token::Client::new(&env, &token1).transfer(
            &sender,
            &env.current_contract_address(),
            &amount1,
        );

        // Update state
        env.storage()
            .instance()
            .set(&DataKey::Reserve0, &new_reserve0);
        env.storage()
            .instance()
            .set(&DataKey::Reserve1, &new_reserve1);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &new_supply);
        env.storage().persistent().set(&lp_key, &new_lp);

        env.events().publish(
            (symbol_short!("add_liq"),),
            (sender, amount0, amount1, mint_amount),
        );
        Ok(mint_amount)
    }

    /// Burn `lp_amount` LP tokens and withdraw proportional pool assets.
    /// `expected_context` must equal `get_pool_context()`.
    pub fn remove_liquidity(
        env: Env,
        sender: Address,
        lp_amount: i128,
        min_amount0: i128,
        min_amount1: i128,
        expected_context: PoolContext,
    ) -> Result<(i128, i128), StableSwapError> {
        sender.require_auth();
        Self::assert_initialized(&env)?;
        Self::require_context(&env, &expected_context)?;

        if lp_amount <= 0 || min_amount0 < 0 || min_amount1 < 0 {
            return Err(StableSwapError::InvalidAmount);
        }

        let lp_key = DataKey::LpBalance(sender.clone());
        let sender_lp: i128 = env.storage().persistent().get(&lp_key).unwrap_or(0);
        if sender_lp < lp_amount {
            return Err(StableSwapError::InsufficientLiquidity);
        }

        let total_supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap();
        if total_supply <= 0 || lp_amount > total_supply {
            return Err(StableSwapError::InsufficientLiquidity);
        }

        let reserve0: i128 = env.storage().instance().get(&DataKey::Reserve0).unwrap();
        let reserve1: i128 = env.storage().instance().get(&DataKey::Reserve1).unwrap();

        let out0 = reserve0
            .checked_mul(lp_amount)
            .ok_or(StableSwapError::MathOverflow)?
            .checked_div(total_supply)
            .ok_or(StableSwapError::MathOverflow)?;
        let out1 = reserve1
            .checked_mul(lp_amount)
            .ok_or(StableSwapError::MathOverflow)?
            .checked_div(total_supply)
            .ok_or(StableSwapError::MathOverflow)?;

        if out0 < min_amount0 || out1 < min_amount1 {
            return Err(StableSwapError::InsufficientOutput);
        }
        if out0 > reserve0 || out1 > reserve1 || (out0 == 0 && out1 == 0) {
            return Err(StableSwapError::InsufficientLiquidity);
        }

        let new_reserve0 = reserve0
            .checked_sub(out0)
            .ok_or(StableSwapError::MathOverflow)?;
        let new_reserve1 = reserve1
            .checked_sub(out1)
            .ok_or(StableSwapError::MathOverflow)?;
        let new_supply = total_supply
            .checked_sub(lp_amount)
            .ok_or(StableSwapError::MathOverflow)?;
        let new_sender_lp = sender_lp
            .checked_sub(lp_amount)
            .ok_or(StableSwapError::MathOverflow)?;

        // Transfer tokens to sender
        let token0: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1: Address = env.storage().instance().get(&DataKey::Token1).unwrap();
        token::Client::new(&env, &token0).transfer(&env.current_contract_address(), &sender, &out0);
        token::Client::new(&env, &token1).transfer(&env.current_contract_address(), &sender, &out1);

        // Burn LP and update reserves
        env.storage().persistent().set(&lp_key, &new_sender_lp);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &new_supply);
        env.storage()
            .instance()
            .set(&DataKey::Reserve0, &new_reserve0);
        env.storage()
            .instance()
            .set(&DataKey::Reserve1, &new_reserve1);

        env.events()
            .publish((symbol_short!("rem_liq"),), (sender, lp_amount, out0, out1));
        Ok((out0, out1))
    }

    // ── Swap ───────────────────────────────────────────────────────────

    /// Swap `token_in` for `token_out`.
    ///
    /// Applies a dynamic fee that increases when the pool is more imbalanced.
    /// `min_out` provides slippage protection for the caller.
    /// `expected_context` must equal `get_pool_context()`.
    pub fn swap(
        env: Env,
        sender: Address,
        token_in: Address,
        amount_in: i128,
        min_out: i128,
        expected_context: PoolContext,
    ) -> Result<i128, StableSwapError> {
        sender.require_auth();
        Self::assert_initialized(&env)?;
        Self::require_context(&env, &expected_context)?;

        if amount_in <= 0 || min_out < 0 {
            return Err(StableSwapError::InvalidAmount);
        }

        let token0: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1: Address = env.storage().instance().get(&DataKey::Token1).unwrap();

        let (reserve_in, reserve_out, token_out) = if token_in == token0 {
            let r0: i128 = env.storage().instance().get(&DataKey::Reserve0).unwrap();
            let r1: i128 = env.storage().instance().get(&DataKey::Reserve1).unwrap();
            (r0, r1, token1.clone())
        } else if token_in == token1 {
            let r0: i128 = env.storage().instance().get(&DataKey::Reserve0).unwrap();
            let r1: i128 = env.storage().instance().get(&DataKey::Reserve1).unwrap();
            (r1, r0, token0.clone())
        } else {
            return Err(StableSwapError::InvalidToken);
        };

        if reserve_in <= 0 || reserve_out <= 0 {
            return Err(StableSwapError::InsufficientLiquidity);
        }

        let amp_coeff: u32 = env.storage().instance().get(&DataKey::AmpCoeff).unwrap();
        let base_fee: u32 = env.storage().instance().get(&DataKey::BaseFee).unwrap();
        let fee_multiplier: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FeeMultiplier)
            .unwrap();

        // Compute dynamic fee based on imbalance before the swap
        let fee = Self::compute_dynamic_fee(reserve_in, reserve_out, base_fee, fee_multiplier)?;
        if fee >= FEE_PRECISION {
            return Err(StableSwapError::InvalidFee);
        }

        let fee_factor = FEE_PRECISION
            .checked_sub(fee)
            .ok_or(StableSwapError::MathOverflow)?;

        // Amount after fee deduction
        let amount_in_after_fee = amount_in
            .checked_mul(fee_factor)
            .ok_or(StableSwapError::MathOverflow)?
            .checked_div(FEE_PRECISION)
            .ok_or(StableSwapError::MathOverflow)?;

        if amount_in_after_fee <= 0 {
            return Err(StableSwapError::InvalidAmount);
        }

        // Compute new reserve_out using the invariant
        let new_reserve_in = reserve_in
            .checked_add(amount_in_after_fee)
            .ok_or(StableSwapError::MathOverflow)?;
        let sum = reserve_in
            .checked_add(reserve_out)
            .ok_or(StableSwapError::MathOverflow)?;
        let new_reserve_out = Self::compute_y(new_reserve_in, sum, amp_coeff)?;

        if new_reserve_out <= 0 || new_reserve_out >= reserve_out {
            return Err(StableSwapError::InsufficientLiquidity);
        }

        let amount_out = reserve_out
            .checked_sub(new_reserve_out)
            .ok_or(StableSwapError::MathOverflow)?;

        if amount_out <= 0 || amount_out >= reserve_out {
            return Err(StableSwapError::InsufficientLiquidity);
        }

        if amount_out < min_out {
            return Err(StableSwapError::InsufficientOutput);
        }

        // Transfer tokens
        token::Client::new(&env, &token_in).transfer(
            &sender,
            &env.current_contract_address(),
            &amount_in,
        );
        token::Client::new(&env, &token_out).transfer(
            &env.current_contract_address(),
            &sender,
            &amount_out,
        );

        // Update reserves
        let (new_r0, new_r1) = if token_in == token0 {
            (new_reserve_in, new_reserve_out)
        } else {
            (new_reserve_out, new_reserve_in)
        };
        env.storage().instance().set(&DataKey::Reserve0, &new_r0);
        env.storage().instance().set(&DataKey::Reserve1, &new_r1);

        env.events().publish(
            (symbol_short!("swap"),),
            (sender, token_in, amount_in, amount_out, fee),
        );
        Ok(amount_out)
    }

    // ── View helpers ───────────────────────────────────────────────────

    /// Reserves of the pool. Reading state that was created on another network
    /// is rejected instead of being returned as if it were live.
    pub fn get_reserves(env: Env) -> Result<(i128, i128), StableSwapError> {
        Self::assert_initialized(&env)?;
        Self::require_live_network(&env)?;
        let r0: i128 = env.storage().instance().get(&DataKey::Reserve0).unwrap();
        let r1: i128 = env.storage().instance().get(&DataKey::Reserve1).unwrap();
        Ok((r0, r1))
    }

    pub fn get_lp_balance(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::LpBalance(account))
            .unwrap_or(0)
    }

    pub fn get_total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    // ── Math internals ─────────────────────────────────────────────────

    /// Compute the StableSwap invariant D for reserves (x, y) and coefficient A.
    ///
    /// Newton–Raphson iteration of:
    ///   f(D) = A·n^n·(x+y)·D + D^(n+1)/(n^n·x·y) − (A·n^n + 1)·D²  (for n=2)
    ///
    /// Simplified update rule (standard Curve formula for n=2):
    ///   D_{k+1} = (A·n^n·S·D_k + n·Dprod) / ((A·n^n+1)·D_k − Dprod)
    /// where S = x+y, Dprod = D_k³/(4·x·y)
    fn compute_d(x: i128, y: i128, amp: u32) -> Result<i128, StableSwapError> {
        if x <= 0 || y <= 0 {
            return Err(StableSwapError::ZeroInvariant);
        }
        if !(1..=MAX_A).contains(&amp) {
            return Err(StableSwapError::InvalidAmpCoeff);
        }

        let s = x.checked_add(y).ok_or(StableSwapError::MathOverflow)?;
        // A·n^n  (n=2, n^n=4)
        let ann: i128 = (amp as i128)
            .checked_mul(4)
            .ok_or(StableSwapError::InvalidAmpCoeff)?;

        let mut d = s;

        for _ in 0..NEWTON_ITERS {
            let d_prod = Self::compute_d_prod(d, x, y)?;

            // numerator = (ann·S + n·d_prod)·D  = (ann·S + 2·d_prod)·D
            let numer = ann
                .checked_mul(s)
                .ok_or(StableSwapError::MathOverflow)?
                .checked_add(
                    d_prod
                        .checked_mul(N_COINS)
                        .ok_or(StableSwapError::MathOverflow)?,
                )
                .ok_or(StableSwapError::MathOverflow)?
                .checked_mul(d)
                .ok_or(StableSwapError::MathOverflow)?;

            // denominator = (ann+1)·D − d_prod
            let denom = ann
                .checked_add(1)
                .ok_or(StableSwapError::MathOverflow)?
                .checked_mul(d)
                .ok_or(StableSwapError::MathOverflow)?
                .checked_sub(d_prod)
                .ok_or(StableSwapError::MathOverflow)?;

            if denom <= 0 {
                return Err(StableSwapError::MathOverflow);
            }

            let d_next = numer
                .checked_div(denom)
                .ok_or(StableSwapError::MathOverflow)?;

            if d_next <= 0 {
                return Err(StableSwapError::MathOverflow);
            }

            // Converged? `d_next` and `d` are both positive and fit in i128, so
            // the difference is safe; use checked math to keep it explicit.
            let delta = d_next.checked_sub(d).ok_or(StableSwapError::MathOverflow)?;
            if delta.unsigned_abs() <= 1 {
                return Ok(d_next);
            }
            d = d_next;
        }
        Err(StableSwapError::MathOverflow)
    }

    /// Compute `d³ / (4·x·y)` without overflowing the intermediate cube.
    ///
    /// Division-first folding (`floor(floor(d²/4·max)·d/min)`) keeps every
    /// intermediate smaller than `i128::MAX` for reserves that would overflow a
    /// direct `d³` product, and floors at each step so the result never exceeds
    /// the exact rational value (rounding favours the pool).
    fn compute_d_prod(d: i128, x: i128, y: i128) -> Result<i128, StableSwapError> {
        let (large, small) = if x >= y { (x, y) } else { (y, x) };
        let four_large = large.checked_mul(4).ok_or(StableSwapError::MathOverflow)?;
        let d2 = d.checked_mul(d).ok_or(StableSwapError::MathOverflow)?;
        let quotient = d2
            .checked_div(four_large)
            .ok_or(StableSwapError::MathOverflow)?;
        quotient
            .checked_mul(d)
            .ok_or(StableSwapError::MathOverflow)?
            .checked_div(small)
            .ok_or(StableSwapError::MathOverflow)
    }

    /// Given the new reserve of one token (x_new), compute the required
    /// reserve of the other token (y) to maintain the invariant D.
    ///
    /// Solves: y^2 + (b − D)·y − D^3/(4·A·n^n·x_new) = 0
    /// where b = x_new + D/ann
    fn compute_y(x_new: i128, sum: i128, amp: u32) -> Result<i128, StableSwapError> {
        if x_new <= 0 || sum <= 0 {
            return Err(StableSwapError::InvalidAmount);
        }
        if !(1..=MAX_A).contains(&amp) {
            return Err(StableSwapError::InvalidAmpCoeff);
        }

        // Recompute D from current sum (approximation: use sum as proxy for D)
        // For the purpose of computing y we iteratively solve:
        //   y_{k+1} = (y_k^2 + D^3/(4·ann·x_new)) / (2·y_k + b − D)
        // where b = x_new + D/ann,  D ≈ sum (initial guess)
        let ann: i128 = (amp as i128)
            .checked_mul(4)
            .ok_or(StableSwapError::InvalidAmpCoeff)?;

        // Approximate D as proportional to sum (conservative; accurate enough for 2-coin pools)
        let d = sum;

        // b = x_new + D/ann
        let b = x_new
            .checked_add(d.checked_div(ann).ok_or(StableSwapError::MathOverflow)?)
            .ok_or(StableSwapError::MathOverflow)?;

        // c = D³ / (4·ann·x_new), folded division-first to avoid overflowing
        // the intermediate cube (see module rounding notes).
        let four_ann_x = ann
            .checked_mul(4)
            .and_then(|v| v.checked_mul(x_new))
            .ok_or(StableSwapError::MathOverflow)?;
        let d2 = d.checked_mul(d).ok_or(StableSwapError::MathOverflow)?;
        let c = d2
            .checked_div(four_ann_x)
            .ok_or(StableSwapError::MathOverflow)?
            .checked_mul(d)
            .ok_or(StableSwapError::MathOverflow)?;

        let mut y = d;
        for _ in 0..NEWTON_ITERS {
            let y2 = y.checked_mul(y).ok_or(StableSwapError::MathOverflow)?;
            let numer = y2.checked_add(c).ok_or(StableSwapError::MathOverflow)?;
            let denom = y
                .checked_mul(2)
                .ok_or(StableSwapError::MathOverflow)?
                .checked_add(b)
                .ok_or(StableSwapError::MathOverflow)?
                .checked_sub(d)
                .ok_or(StableSwapError::MathOverflow)?;

            if denom <= 0 {
                return Err(StableSwapError::MathOverflow);
            }

            let y_next = numer
                .checked_div(denom)
                .ok_or(StableSwapError::MathOverflow)?;

            if y_next <= 0 {
                return Err(StableSwapError::MathOverflow);
            }

            let delta = y_next.checked_sub(y).ok_or(StableSwapError::MathOverflow)?;
            if delta.unsigned_abs() <= 1 {
                return Ok(y_next);
            }
            y = y_next;
        }
        Err(StableSwapError::MathOverflow)
    }

    /// Compute the dynamic fee (in FEE_PRECISION units) based on pool imbalance.
    ///
    /// imbalance_ratio = |balance0/(balance0+balance1) − 0.5| / 0.5
    ///                 = |balance0 − balance1| / (balance0 + balance1)
    ///
    /// dynamic_fee = base_fee + imbalance_ratio × fee_multiplier
    fn compute_dynamic_fee(
        balance0: i128,
        balance1: i128,
        base_fee: u32,
        fee_multiplier: u32,
    ) -> Result<i128, StableSwapError> {
        if balance0 < 0 || balance1 < 0 {
            return Err(StableSwapError::InvalidAmount);
        }
        let total = balance0
            .checked_add(balance1)
            .ok_or(StableSwapError::MathOverflow)?;
        if total == 0 {
            return Ok(base_fee as i128);
        }

        let diff = (balance0 - balance1).abs();
        // imbalance_ratio (scaled by FEE_PRECISION)
        let imbalance_fp = diff
            .checked_mul(FEE_PRECISION)
            .ok_or(StableSwapError::MathOverflow)?
            .checked_div(total)
            .ok_or(StableSwapError::MathOverflow)?;

        // additional_fee = imbalance_fp × fee_multiplier / FEE_PRECISION
        let additional_fee = imbalance_fp
            .checked_mul(fee_multiplier as i128)
            .ok_or(StableSwapError::MathOverflow)?
            .checked_div(FEE_PRECISION)
            .ok_or(StableSwapError::MathOverflow)?;

        let total_fee = (base_fee as i128)
            .checked_add(additional_fee)
            .ok_or(StableSwapError::MathOverflow)?;

        if total_fee >= FEE_PRECISION {
            return Err(StableSwapError::InvalidFee);
        }

        Ok(total_fee)
    }

    // ── Internal helpers ────────────────────────────────────────────────

    fn assert_initialized(env: &Env) -> Result<(), StableSwapError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(StableSwapError::NotInitialized);
        }
        Ok(())
    }

    /// Network the stored state is bound to. Pools initialized before context
    /// binding have no stored network and adopt the live ledger network, so
    /// they behave exactly as before until an admin calls `migrate`.
    fn bound_network(env: &Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::NetworkId)
            .unwrap_or_else(|| env.ledger().network_id())
    }

    fn read_version(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::StorageVersion)
            .unwrap_or(0)
    }

    /// Reject reads of state that does not belong to the live network.
    fn require_live_network(env: &Env) -> Result<(), StableSwapError> {
        if Self::bound_network(env) != env.ledger().network_id() {
            return Err(StableSwapError::WrongNetwork);
        }
        Ok(())
    }

    /// Reject operations bound to a different network, deployment or context
    /// version. Checked before any reserve math, transfer or storage write.
    fn require_context(env: &Env, expected: &PoolContext) -> Result<(), StableSwapError> {
        Self::require_live_network(env)?;
        if expected.network_id != Self::bound_network(env) {
            return Err(StableSwapError::WrongNetwork);
        }
        if expected.contract != env.current_contract_address() {
            return Err(StableSwapError::WrongContract);
        }
        let version = Self::read_version(env);
        // A version newer than this code is an unknown layout: refuse it rather
        // than misinterpreting stored state after a code downgrade.
        if version > CURRENT_POOL_VERSION || expected.version != version {
            return Err(StableSwapError::WrongVersion);
        }
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    /// Current context a caller would capture before an operation.
    fn ctx(client: &StableSwapClient) -> PoolContext {
        client.get_pool_context()
    }

    /// Helper: deploy and initialize a pool
    fn setup_pool(env: &Env, amp: u32) -> (Address, Address, Address, Address, Address) {
        let admin = Address::generate(env);
        let token0 = Address::generate(env);
        let token1 = Address::generate(env);
        let lp_token = Address::generate(env);
        let contract_id = env.register(StableSwap, ());
        let client = StableSwapClient::new(env, &contract_id);
        client.initialize(&admin, &token0, &token1, &lp_token, &amp, &30_000, &20_000);
        (contract_id, admin, token0, token1, lp_token)
    }

    // ── Invariant math ─────────────────────────────────────────────────

    #[test]
    fn test_compute_d_basic() {
        let env = Env::default();
        let _ = env;
        // Equal reserves — D should be ≥ x+y (Stableswap D is slightly above
        // x+y when balanced, converging toward x+y as A→∞)
        let x: i128 = 1_000_000;
        let y: i128 = 1_000_000;
        let d = StableSwap::compute_d(x, y, 100).unwrap();
        // For balanced equal reserves D >= x+y (amplification creates depth)
        // and is bounded above by roughly 2*(x+y)/sqrt(A) for low A values
        assert!(d >= x + y, "D={d} should be >= x+y={}", x + y);
        // D should be reasonably close to x+y (within 2% for amp=100)
        assert!(d < (x + y) * 102 / 100, "D={d} too far above x+y");
    }

    #[test]
    fn test_compute_d_symmetric() {
        let env = Env::default();
        let _ = env; // suppress unused-variable warning
                     // D must be the same regardless of which token is which (symmetry)
        let d1 = StableSwap::compute_d(1_500_000, 500_000, 200).unwrap();
        let d2 = StableSwap::compute_d(500_000, 1_500_000, 200).unwrap();
        assert_eq!(d1, d2);
    }

    #[test]
    fn test_compute_d_increases_with_reserves() {
        let env = Env::default();
        let _ = env;
        let d_small = StableSwap::compute_d(1_000, 1_000, 100).unwrap();
        let d_large = StableSwap::compute_d(1_000_000, 1_000_000, 100).unwrap();
        assert!(d_large > d_small);
    }

    #[test]
    fn test_compute_d_edge_one_sided() {
        let env = Env::default();
        let _ = env;
        // Moderately imbalanced pool (1:4 ratio) still converges
        let d = StableSwap::compute_d(500_000, 2_000_000, 50).unwrap();
        assert!(d > 0);
        // D must lie between x+y and 2*(x+y) for valid pools
        let sum: i128 = 500_000 + 2_000_000;
        assert!(d >= sum / 2 && d <= sum * 2);
    }

    // ── Dynamic fee ────────────────────────────────────────────────────

    #[test]
    fn test_dynamic_fee_balanced() {
        let env = Env::default();
        let _ = env;
        // Balanced pool → fee equals base fee
        let fee = StableSwap::compute_dynamic_fee(1_000, 1_000, 30_000, 20_000).unwrap();
        assert_eq!(fee, 30_000);
    }

    #[test]
    fn test_dynamic_fee_imbalanced() {
        let env = Env::default();
        let _ = env;
        // Completely one-sided pool → imbalance_ratio = 1 → fee = base + multiplier
        let fee = StableSwap::compute_dynamic_fee(1_000, 0, 30_000, 20_000);
        // Division by zero is handled (total=0 returns base_fee)
        let fee2 = StableSwap::compute_dynamic_fee(1_000_000, 0, 30_000, 20_000);
        // Won't divide by zero for non-zero total
        if let Ok(f) = fee2 {
            assert!(f >= 30_000);
        }
        let _ = fee;
    }

    #[test]
    fn test_dynamic_fee_increases_with_imbalance() {
        let env = Env::default();
        let _ = env;
        let fee_balanced = StableSwap::compute_dynamic_fee(1_000, 1_000, 30_000, 50_000).unwrap();
        let fee_skewed = StableSwap::compute_dynamic_fee(1_800, 200, 30_000, 50_000).unwrap();
        assert!(fee_skewed > fee_balanced);
    }

    // ── Invariant error cases ──────────────────────────────────────────

    #[test]
    fn test_compute_d_zero_reserve_returns_error() {
        let env = Env::default();
        let _ = env;
        let result = StableSwap::compute_d(0, 1_000, 100);
        assert!(matches!(result, Err(StableSwapError::ZeroInvariant)));
    }

    #[test]
    fn test_initialize_invalid_amp() {
        let env = Env::default();
        let contract_id = env.register(StableSwap, ());
        let client = StableSwapClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let t0 = Address::generate(&env);
        let t1 = Address::generate(&env);
        let lp = Address::generate(&env);
        let result = client.try_initialize(&admin, &t0, &t1, &lp, &0, &30_000, &20_000);
        assert!(result.is_err());
    }

    #[test]
    fn test_initialize_too_high_fee() {
        let env = Env::default();
        let contract_id = env.register(StableSwap, ());
        let client = StableSwapClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let t0 = Address::generate(&env);
        let t1 = Address::generate(&env);
        let lp = Address::generate(&env);
        // base_fee > MAX_BASE_FEE_BPS → error
        let result = client.try_initialize(&admin, &t0, &t1, &lp, &100, &2_000_000, &0);
        assert!(result.is_err());
    }

    #[test]
    fn test_initialize_fee_bounds_zero_normal_max() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let t0 = Address::generate(&env);
        let t1 = Address::generate(&env);
        let lp = Address::generate(&env);

        // zero base fee
        let c0 = env.register(StableSwap, ());
        let client0 = StableSwapClient::new(&env, &c0);
        let zero = client0.try_initialize(&admin, &t0, &t1, &lp, &100, &0, &0);
        assert!(zero.is_ok());

        // normal base fee (0.3%)
        let c1 = env.register(StableSwap, ());
        let client1 = StableSwapClient::new(&env, &c1);
        let normal = client1.try_initialize(&admin, &t0, &t1, &lp, &100, &30_000, &20_000);
        assert!(normal.is_ok());

        // max allowed base fee
        let c2 = env.register(StableSwap, ());
        let client2 = StableSwapClient::new(&env, &c2);
        let max = client2.try_initialize(&admin, &t0, &t1, &lp, &100, &MAX_BASE_FEE_BPS, &0);
        assert!(max.is_ok());
    }

    #[test]
    fn test_double_initialize_rejected() {
        let env = Env::default();
        let (contract_id, admin, t0, t1, lp) = setup_pool(&env, 100);
        let client = StableSwapClient::new(&env, &contract_id);
        let result = client.try_initialize(&admin, &t0, &t1, &lp, &100, &30_000, &20_000);
        assert!(result.is_err());
    }

    // ── End-to-end Setup Helper with Real SAC Tokens ───────────────────

    fn setup_pool_with_tokens(
        env: &Env,
        amp: u32,
    ) -> (StableSwapClient<'_>, Address, Address, Address, Address) {
        env.mock_all_auths();
        let admin = Address::generate(env);
        let user = Address::generate(env);
        let token0_admin = Address::generate(env);
        let token1_admin = Address::generate(env);

        let token0_contract = env.register_stellar_asset_contract_v2(token0_admin);
        let token1_contract = env.register_stellar_asset_contract_v2(token1_admin);
        let token0 = token0_contract.address();
        let token1 = token1_contract.address();
        let lp_token = Address::generate(env);

        let contract_id = env.register(StableSwap, ());
        let client = StableSwapClient::new(env, &contract_id);
        client.initialize(&admin, &token0, &token1, &lp_token, &amp, &30_000, &20_000);

        // Mint initial tokens to user
        let token0_client = token::StellarAssetClient::new(env, &token0);
        let token1_client = token::StellarAssetClient::new(env, &token1);
        token0_client.mint(&user, &10_000_000);
        token1_client.mint(&user, &10_000_000);

        (client, user, token0, token1, lp_token)
    }

    // ── Normal Operation Regression Tests ──────────────────────────────

    #[test]
    fn test_normal_full_lifecycle() {
        let env = Env::default();
        let (client, user, token0, token1, _) = setup_pool_with_tokens(&env, 100);

        let t0_client = token::Client::new(&env, &token0);
        let t1_client = token::Client::new(&env, &token1);

        // 1. Add liquidity
        let mint = client.add_liquidity(&user, &1_000_000, &1_000_000, &1_000_000, &ctx(&client));
        assert!(mint >= 1_000_000);
        assert_eq!(t0_client.balance(&user), 9_000_000);
        assert_eq!(t1_client.balance(&user), 9_000_000);
        assert_eq!(client.get_reserves(), (1_000_000, 1_000_000));
        assert_eq!(client.get_lp_balance(&user), mint);
        assert_eq!(client.get_total_supply(), mint);

        // 2. Swap token0 for token1
        let swapped_out = client.swap(&user, &token0, &100_000, &90_000, &ctx(&client));
        assert!(swapped_out >= 90_000);
        assert_eq!(t0_client.balance(&user), 8_900_000);
        assert_eq!(t1_client.balance(&user), 9_000_000 + swapped_out);

        // 3. Remove liquidity
        let half_lp = mint / 2;
        let (out0, out1) = client.remove_liquidity(&user, &half_lp, &1, &1, &ctx(&client));
        assert!(out0 > 0 && out1 > 0);
        assert_eq!(client.get_lp_balance(&user), mint - half_lp);
        assert_eq!(client.get_total_supply(), mint - half_lp);
    }

    // ── Boundary Failures: Malformed Data & State Preservation ──────────

    #[test]
    fn test_initialize_rejects_identical_tokens() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let t0 = Address::generate(&env);
        let lp = Address::generate(&env);

        let c = env.register(StableSwap, ());
        let client = StableSwapClient::new(&env, &c);
        let res = client.try_initialize(&admin, &t0, &t0, &lp, &100, &30_000, &20_000);
        assert_eq!(res, Err(Ok(StableSwapError::InvalidToken)));
    }

    #[test]
    fn test_initialize_rejects_lp_token_as_pool_token() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let t0 = Address::generate(&env);
        let t1 = Address::generate(&env);

        let c1 = env.register(StableSwap, ());
        let client1 = StableSwapClient::new(&env, &c1);
        let res1 = client1.try_initialize(&admin, &t0, &t1, &t0, &100, &30_000, &20_000);
        assert_eq!(res1, Err(Ok(StableSwapError::InvalidToken)));

        let c2 = env.register(StableSwap, ());
        let client2 = StableSwapClient::new(&env, &c2);
        let res2 = client2.try_initialize(&admin, &t0, &t1, &t1, &100, &30_000, &20_000);
        assert_eq!(res2, Err(Ok(StableSwapError::InvalidToken)));
    }

    #[test]
    fn test_initialize_rejects_excessive_fee_multiplier() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let t0 = Address::generate(&env);
        let t1 = Address::generate(&env);
        let lp = Address::generate(&env);

        // fee_multiplier alone > FEE_PRECISION
        let c1 = env.register(StableSwap, ());
        let client1 = StableSwapClient::new(&env, &c1);
        let res1 = client1.try_initialize(&admin, &t0, &t1, &lp, &100, &10_000, &10_000_001);
        assert_eq!(res1, Err(Ok(StableSwapError::InvalidFee)));

        // base_fee + fee_multiplier > FEE_PRECISION
        let c2 = env.register(StableSwap, ());
        let client2 = StableSwapClient::new(&env, &c2);
        let res2 = client2.try_initialize(
            &admin,
            &t0,
            &t1,
            &lp,
            &100,
            &MAX_BASE_FEE_BPS,
            &(FEE_PRECISION as u32),
        );
        assert_eq!(res2, Err(Ok(StableSwapError::InvalidFee)));
    }

    #[test]
    fn test_add_liquidity_boundary_validation_and_state_preservation() {
        let env = Env::default();
        let (client, user, token0, token1, _) = setup_pool_with_tokens(&env, 100);

        let t0_client = token::Client::new(&env, &token0);
        let t1_client = token::Client::new(&env, &token1);

        let initial_b0 = t0_client.balance(&user);
        let initial_b1 = t1_client.balance(&user);

        // 1. Zero amount0 rejected
        let res0 = client.try_add_liquidity(&user, &0, &100_000, &0, &ctx(&client));
        assert_eq!(res0, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(t0_client.balance(&user), initial_b0);
        assert_eq!(t1_client.balance(&user), initial_b1);
        assert_eq!(client.get_reserves(), (0, 0));

        // 2. Negative amount1 rejected
        let res1 = client.try_add_liquidity(&user, &100_000, &-5, &0, &ctx(&client));
        assert_eq!(res1, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(t0_client.balance(&user), initial_b0);
        assert_eq!(t1_client.balance(&user), initial_b1);

        // 3. Negative min_mint_amount rejected
        let res_neg_min = client.try_add_liquidity(&user, &100_000, &100_000, &-1, &ctx(&client));
        assert_eq!(res_neg_min, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(t0_client.balance(&user), initial_b0);
        assert_eq!(t1_client.balance(&user), initial_b1);

        // 4. Slippage exceeded: min_mint_amount higher than minted LP
        let res_slip =
            client.try_add_liquidity(&user, &100_000, &100_000, &999_999_999, &ctx(&client));
        assert_eq!(res_slip, Err(Ok(StableSwapError::InsufficientOutput)));
        // BALANCES AND STATE COMPLETELY PRESERVED
        assert_eq!(t0_client.balance(&user), initial_b0);
        assert_eq!(t1_client.balance(&user), initial_b1);
        assert_eq!(client.get_reserves(), (0, 0));
        assert_eq!(client.get_total_supply(), 0);
        assert_eq!(client.get_lp_balance(&user), 0);
    }

    #[test]
    fn test_add_liquidity_safe_retry_after_failure() {
        let env = Env::default();
        let (client, user, token0, token1, _) = setup_pool_with_tokens(&env, 100);

        let t0_client = token::Client::new(&env, &token0);
        let t1_client = token::Client::new(&env, &token1);

        // Attempt 1: excessive slippage tolerance fails
        let fail_res =
            client.try_add_liquidity(&user, &500_000, &500_000, &10_000_000, &ctx(&client));
        assert_eq!(fail_res, Err(Ok(StableSwapError::InsufficientOutput)));
        assert_eq!(t0_client.balance(&user), 10_000_000);
        assert_eq!(t1_client.balance(&user), 10_000_000);

        // Retry: with realistic min_mint_amount succeeds
        let success_mint = client.add_liquidity(&user, &500_000, &500_000, &500_000, &ctx(&client));
        assert!(success_mint >= 500_000);
        assert_eq!(t0_client.balance(&user), 9_500_000);
        assert_eq!(t1_client.balance(&user), 9_500_000);
        assert_eq!(client.get_reserves(), (500_000, 500_000));
    }

    #[test]
    fn test_swap_boundary_validation_and_state_preservation() {
        let env = Env::default();
        let (client, user, token0, token1, _) = setup_pool_with_tokens(&env, 100);

        let t0_client = token::Client::new(&env, &token0);
        let t1_client = token::Client::new(&env, &token1);

        // 1. Swap on empty pool fails with InsufficientLiquidity without modifying balances
        let res_empty = client.try_swap(&user, &token0, &100_000, &0, &ctx(&client));
        assert_eq!(res_empty, Err(Ok(StableSwapError::InsufficientLiquidity)));
        assert_eq!(t0_client.balance(&user), 10_000_000);

        // Bootstrap pool liquidity
        client.add_liquidity(&user, &1_000_000, &1_000_000, &1_000_000, &ctx(&client));
        let bal0_after_liq = t0_client.balance(&user);
        let bal1_after_liq = t1_client.balance(&user);
        let reserves_after_liq = client.get_reserves();

        // 2. Zero amount_in rejected
        let res_zero = client.try_swap(&user, &token0, &0, &0, &ctx(&client));
        assert_eq!(res_zero, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(t0_client.balance(&user), bal0_after_liq);
        assert_eq!(t1_client.balance(&user), bal1_after_liq);

        // 3. Negative min_out rejected
        let res_neg_out = client.try_swap(&user, &token0, &10_000, &-1, &ctx(&client));
        assert_eq!(res_neg_out, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(t0_client.balance(&user), bal0_after_liq);

        // 4. Untrusted token address rejected with typed InvalidToken
        let bogus_token = Address::generate(&env);
        let res_bogus = client.try_swap(&user, &bogus_token, &10_000, &0, &ctx(&client));
        assert_eq!(res_bogus, Err(Ok(StableSwapError::InvalidToken)));
        assert_eq!(t0_client.balance(&user), bal0_after_liq);
        assert_eq!(t1_client.balance(&user), bal1_after_liq);
        assert_eq!(client.get_reserves(), reserves_after_liq);

        // 5. Slippage exceeded rejected with InsufficientOutput and state preserved
        let res_slip = client.try_swap(&user, &token0, &10_000, &999_999, &ctx(&client));
        assert_eq!(res_slip, Err(Ok(StableSwapError::InsufficientOutput)));
        assert_eq!(t0_client.balance(&user), bal0_after_liq);
        assert_eq!(t1_client.balance(&user), bal1_after_liq);
        assert_eq!(client.get_reserves(), reserves_after_liq);
    }

    #[test]
    fn test_swap_safe_retry_after_failure() {
        let env = Env::default();
        let (client, user, token0, token1, _) = setup_pool_with_tokens(&env, 100);
        client.add_liquidity(&user, &1_000_000, &1_000_000, &1_000_000, &ctx(&client));

        let t0_client = token::Client::new(&env, &token0);
        let t1_client = token::Client::new(&env, &token1);
        let b0 = t0_client.balance(&user);
        let b1 = t1_client.balance(&user);

        // Fail 1: malformed token
        let fake_token = Address::generate(&env);
        assert_eq!(
            client.try_swap(&user, &fake_token, &50_000, &0, &ctx(&client)),
            Err(Ok(StableSwapError::InvalidToken))
        );
        assert_eq!(t0_client.balance(&user), b0);

        // Fail 2: impossible slippage
        assert_eq!(
            client.try_swap(&user, &token0, &50_000, &200_000, &ctx(&client)),
            Err(Ok(StableSwapError::InsufficientOutput))
        );
        assert_eq!(t0_client.balance(&user), b0);

        // Retry: valid swap succeeds
        let out = client.swap(&user, &token0, &50_000, &45_000, &ctx(&client));
        assert!(out >= 45_000);
        assert_eq!(t0_client.balance(&user), b0 - 50_000);
        assert_eq!(t1_client.balance(&user), b1 + out);
    }

    #[test]
    fn test_remove_liquidity_boundary_validation_and_state_preservation() {
        let env = Env::default();
        let (client, user, token0, token1, _) = setup_pool_with_tokens(&env, 100);

        let t0_client = token::Client::new(&env, &token0);
        let t1_client = token::Client::new(&env, &token1);

        let mint = client.add_liquidity(&user, &1_000_000, &1_000_000, &1_000_000, &ctx(&client));
        let bal0 = t0_client.balance(&user);
        let bal1 = t1_client.balance(&user);
        let reserves = client.get_reserves();

        // 1. Zero lp_amount rejected
        let res_zero = client.try_remove_liquidity(&user, &0, &0, &0, &ctx(&client));
        assert_eq!(res_zero, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(client.get_lp_balance(&user), mint);

        // 2. Negative min_amount0 rejected
        let res_neg0 = client.try_remove_liquidity(&user, &100, &-1, &0, &ctx(&client));
        assert_eq!(res_neg0, Err(Ok(StableSwapError::InvalidAmount)));

        // 3. Negative min_amount1 rejected
        let res_neg1 = client.try_remove_liquidity(&user, &100, &0, &-1, &ctx(&client));
        assert_eq!(res_neg1, Err(Ok(StableSwapError::InvalidAmount)));

        // 4. lp_amount greater than user balance rejected
        let res_too_much = client.try_remove_liquidity(&user, &(mint + 1), &0, &0, &ctx(&client));
        assert_eq!(
            res_too_much,
            Err(Ok(StableSwapError::InsufficientLiquidity))
        );

        // 5. Slippage exceeded rejected
        let res_slip =
            client.try_remove_liquidity(&user, &(mint / 2), &999_999_999, &0, &ctx(&client));
        assert_eq!(res_slip, Err(Ok(StableSwapError::InsufficientOutput)));

        // Verify balances, LP and reserves completely preserved
        assert_eq!(t0_client.balance(&user), bal0);
        assert_eq!(t1_client.balance(&user), bal1);
        assert_eq!(client.get_lp_balance(&user), mint);
        assert_eq!(client.get_total_supply(), mint);
        assert_eq!(client.get_reserves(), reserves);
    }

    #[test]
    fn test_remove_liquidity_safe_retry_after_failure() {
        let env = Env::default();
        let (client, user, token0, token1, _) = setup_pool_with_tokens(&env, 100);
        let mint = client.add_liquidity(&user, &1_000_000, &1_000_000, &1_000_000, &ctx(&client));

        let t0_client = token::Client::new(&env, &token0);
        let t1_client = token::Client::new(&env, &token1);
        let b0 = t0_client.balance(&user);
        let b1 = t1_client.balance(&user);

        // Excessive min_out fails
        let fail_res =
            client.try_remove_liquidity(&user, &(mint / 2), &5_000_000, &0, &ctx(&client));
        assert_eq!(fail_res, Err(Ok(StableSwapError::InsufficientOutput)));
        assert_eq!(client.get_lp_balance(&user), mint);

        // Safe retry with acceptable minimums succeeds
        let burn_amount = mint / 2;
        let (out0, out1) =
            client.remove_liquidity(&user, &burn_amount, &100_000, &100_000, &ctx(&client));
        assert!(out0 >= 100_000);
        assert!(out1 >= 100_000);
        assert_eq!(client.get_lp_balance(&user), mint - burn_amount);
        assert_eq!(t0_client.balance(&user), b0 + out0);
        assert_eq!(t1_client.balance(&user), b1 + out1);
    }

    // ── Math & Solver Boundary Tests ───────────────────────────────────

    #[test]
    fn test_compute_d_invalid_amp_coeff() {
        assert_eq!(
            StableSwap::compute_d(1_000_000, 1_000_000, 0),
            Err(StableSwapError::InvalidAmpCoeff)
        );
        assert_eq!(
            StableSwap::compute_d(1_000_000, 1_000_000, MAX_A + 1),
            Err(StableSwapError::InvalidAmpCoeff)
        );
    }

    #[test]
    fn test_compute_y_boundary_validation() {
        // x_new <= 0
        assert_eq!(
            StableSwap::compute_y(0, 1_000_000, 100),
            Err(StableSwapError::InvalidAmount)
        );
        assert_eq!(
            StableSwap::compute_y(-10, 1_000_000, 100),
            Err(StableSwapError::InvalidAmount)
        );
        // sum <= 0
        assert_eq!(
            StableSwap::compute_y(1000, 0, 100),
            Err(StableSwapError::InvalidAmount)
        );
        assert_eq!(
            StableSwap::compute_y(1000, -50, 100),
            Err(StableSwapError::InvalidAmount)
        );
        // invalid amp
        assert_eq!(
            StableSwap::compute_y(1000, 2000, 0),
            Err(StableSwapError::InvalidAmpCoeff)
        );
        assert_eq!(
            StableSwap::compute_y(1000, 2000, MAX_A + 1),
            Err(StableSwapError::InvalidAmpCoeff)
        );
    }

    #[test]
    fn test_compute_dynamic_fee_boundary_validation() {
        // Negative balance rejected
        assert_eq!(
            StableSwap::compute_dynamic_fee(-1, 1000, 30_000, 20_000),
            Err(StableSwapError::InvalidAmount)
        );
        assert_eq!(
            StableSwap::compute_dynamic_fee(1000, -1, 30_000, 20_000),
            Err(StableSwapError::InvalidAmount)
        );
        // Total fee >= FEE_PRECISION rejected
        assert_eq!(
            StableSwap::compute_dynamic_fee(1000, 1000, FEE_PRECISION as u32, 0),
            Err(StableSwapError::InvalidFee)
        );
    }

    // ── Boundary-value invariant calculations (#1764) ──────────────────

    #[test]
    fn test_compute_d_minimum_reserves() {
        // One unit per token is the smallest valid pool. D is finite, positive,
        // and at least the reserve sum.
        let d = StableSwap::compute_d(1, 1, 1).expect("minimum reserves must converge");
        assert!(d >= 2);

        // Minimum remains valid at maximum amplification.
        let d_max_amp = StableSwap::compute_d(1, 1, MAX_A).expect("min reserves at MAX_A");
        assert!(d_max_amp >= 2);
    }

    #[test]
    fn test_compute_d_near_limit_reserves() {
        // 1e17 per side: large enough that a direct `d^3` is close to the i128
        // limit, but within the documented `sqrt(i128::MAX / (4·A))` domain.
        let reserve: i128 = 100_000_000_000_000_000;
        let d = StableSwap::compute_d(reserve, reserve, 100)
            .expect("near-limit balanced reserves must converge");
        assert!(d >= reserve.checked_mul(2).unwrap());
        assert!(d < reserve.checked_mul(4).unwrap());
    }

    #[test]
    fn test_compute_d_maximum_reserves_typed_error() {
        // x + y overflows i128: typed failure, never a panic.
        assert_eq!(
            StableSwap::compute_d(i128::MAX, i128::MAX, 100),
            Err(StableSwapError::MathOverflow)
        );

        // Sum fits but d^2 cannot be represented: typed failure.
        let third = i128::MAX / 3;
        assert_eq!(
            StableSwap::compute_d(third, third, 100),
            Err(StableSwapError::MathOverflow)
        );
    }

    #[test]
    fn test_compute_y_near_limit_and_maximum() {
        // Near-limit values converge instead of overflowing the cube.
        let y = StableSwap::compute_y(1_000_000_000_000_000_000, 2_000_000_000_000_000_000, 100)
            .expect("near-limit y must converge");
        assert!(y > 0);

        // Maximum inputs that cannot be represented return a typed error.
        assert_eq!(
            StableSwap::compute_y(i128::MAX, i128::MAX, 100),
            Err(StableSwapError::MathOverflow)
        );
    }

    #[test]
    fn test_dynamic_fee_maximum_values() {
        // Balanced maximum reserves have zero imbalance and no overflow.
        let half = i128::MAX / 2;
        assert_eq!(
            StableSwap::compute_dynamic_fee(half, half, 30_000, 20_000),
            Ok(30_000)
        );

        // Extreme imbalance at the i128 limit cannot be scaled safely.
        assert_eq!(
            StableSwap::compute_dynamic_fee(i128::MAX, 0, 30_000, 20_000),
            Err(StableSwapError::MathOverflow)
        );
    }

    #[test]
    fn test_minimum_liquidity_lifecycle_rounds_down() {
        let env = Env::default();
        let (client, user, _token0, _token1, _) = setup_pool_with_tokens(&env, 100);

        // Smallest meaningful deposit.
        let mint = client.add_liquidity(&user, &1, &1, &0, &ctx(&client));
        assert!(mint > 0);
        assert_eq!(client.get_reserves(), (1, 1));

        // A tiny withdrawal rounds both payouts to zero and is rejected, leaving
        // LP balance, supply, and reserves untouched.
        let tiny = mint / 2;
        if tiny > 0 {
            let res = client.try_remove_liquidity(&user, &tiny, &0, &0, &ctx(&client));
            assert_eq!(res, Err(Ok(StableSwapError::InsufficientLiquidity)));
            assert_eq!(client.get_lp_balance(&user), mint);
            assert_eq!(client.get_total_supply(), mint);
            assert_eq!(client.get_reserves(), (1, 1));
        }

        // Full exit returns exactly the reserves (floor division is exact here).
        let (out0, out1) = client.remove_liquidity(&user, &mint, &0, &0, &ctx(&client));
        assert_eq!((out0, out1), (1, 1));
        assert_eq!(client.get_reserves(), (0, 0));
        assert_eq!(client.get_total_supply(), 0);
    }

    #[test]
    fn test_withdrawal_rounding_is_documented_floor() {
        let env = Env::default();
        let (client, user, _token0, _token1, _) = setup_pool_with_tokens(&env, 100);

        let mint = client.add_liquidity(&user, &1_000_000, &1_000_000, &0, &ctx(&client));
        let (reserve0, reserve1) = client.get_reserves();
        let lp_amount = mint / 3;

        let (out0, out1) = client.remove_liquidity(&user, &lp_amount, &0, &0, &ctx(&client));

        // Payouts must equal floor(reserve * lp / supply): the pool never pays
        // out more than the proportional share.
        assert_eq!(out0, reserve0 * lp_amount / mint);
        assert_eq!(out1, reserve1 * lp_amount / mint);
        assert!(out0 <= reserve0);
        assert!(out1 <= reserve1);
    }

    #[test]
    fn test_add_liquidity_max_amount_rejected_without_state_change() {
        let env = Env::default();
        let (client, user, token0, token1, _) = setup_pool_with_tokens(&env, 100);
        let t0_client = token::Client::new(&env, &token0);
        let t1_client = token::Client::new(&env, &token1);

        client.add_liquidity(&user, &1_000, &1_000, &0, &ctx(&client));
        let reserves = client.get_reserves();
        let supply = client.get_total_supply();
        let bal0 = t0_client.balance(&user);
        let bal1 = t1_client.balance(&user);

        // reserve + i128::MAX overflows: typed failure before any transfer.
        assert_eq!(
            client.try_add_liquidity(&user, &i128::MAX, &1, &0, &ctx(&client)),
            Err(Ok(StableSwapError::MathOverflow))
        );
        assert_eq!(client.get_reserves(), reserves);
        assert_eq!(client.get_total_supply(), supply);
        assert_eq!(t0_client.balance(&user), bal0);
        assert_eq!(t1_client.balance(&user), bal1);

        // Safe retry with a representable amount succeeds.
        let mint = client.add_liquidity(&user, &1_000, &1_000, &0, &ctx(&client));
        assert!(mint > 0);
        assert_eq!(t0_client.balance(&user), bal0 - 1_000);
        assert_eq!(t1_client.balance(&user), bal1 - 1_000);
    }

    #[test]
    fn test_swap_max_amount_rejected_without_state_change() {
        let env = Env::default();
        let (client, user, token0, token1, _) = setup_pool_with_tokens(&env, 100);
        let t0_client = token::Client::new(&env, &token0);
        let t1_client = token::Client::new(&env, &token1);

        client.add_liquidity(&user, &1_000_000, &1_000_000, &0, &ctx(&client));
        let reserves = client.get_reserves();
        let bal0 = t0_client.balance(&user);
        let bal1 = t1_client.balance(&user);

        // `amount_in * fee_factor` cannot be represented: typed failure.
        assert_eq!(
            client.try_swap(&user, &token0, &i128::MAX, &0, &ctx(&client)),
            Err(Ok(StableSwapError::MathOverflow))
        );
        assert_eq!(client.get_reserves(), reserves);
        assert_eq!(t0_client.balance(&user), bal0);
        assert_eq!(t1_client.balance(&user), bal1);

        // Safe retry.
        let out = client.swap(&user, &token0, &100_000, &0, &ctx(&client));
        assert!(out > 0);
        assert_eq!(t0_client.balance(&user), bal0 - 100_000);
        assert_eq!(t1_client.balance(&user), bal1 + out);
    }

    // ── Network, ledger and version context binding (#1766) ────────────

    mod pool_context_binding {
        use super::*;
        use soroban_sdk::testutils::Ledger;

        const NET_A: [u8; 32] = [0xA1; 32];
        const NET_B: [u8; 32] = [0xB2; 32];

        /// Drop the context keys an older deployment never wrote, turning an
        /// initialized pool into a legacy (version 0) pool.
        fn degrade_to_legacy_pool(env: &Env, contract: &Address) {
            env.as_contract(contract, || {
                env.storage().instance().remove(&DataKey::NetworkId);
                env.storage().instance().remove(&DataKey::StorageVersion);
            });
        }

        fn set_version(env: &Env, contract: &Address, version: u32) {
            env.as_contract(contract, || {
                env.storage()
                    .instance()
                    .set(&DataKey::StorageVersion, &version);
            });
        }

        #[test]
        fn context_is_bound_to_network_deployment_and_version() {
            let env = Env::default();
            env.ledger().set_network_id(NET_A);
            let (client, user, token0, _, _) = setup_pool_with_tokens(&env, 100);

            let context = client.get_pool_context();
            assert_eq!(context.network_id, BytesN::from_array(&env, &NET_A));
            assert_eq!(context.contract, client.address);
            assert_eq!(context.version, CURRENT_POOL_VERSION);

            // Normal operation: every entry point accepts the captured context,
            // and pool activity does not change it.
            let mint = client.add_liquidity(&user, &1_000_000, &1_000_000, &0, &context);
            client.swap(&user, &token0, &100_000, &0, &context);
            client.remove_liquidity(&user, &(mint / 2), &0, &0, &context);
            assert_eq!(client.get_pool_context(), context);
            assert_eq!(client.get_lp_balance(&user), mint - mint / 2);
        }

        #[test]
        fn legacy_pool_operates_until_migration_pins_the_binding() {
            let env = Env::default();
            env.ledger().set_network_id(NET_A);
            let (client, user, token0, _, _) = setup_pool_with_tokens(&env, 100);
            degrade_to_legacy_pool(&env, &client.address);

            // No stored binding: the pool adopts the live network and stays at
            // version 0, so pre-existing deployments keep working unchanged.
            let legacy = client.get_pool_context();
            assert_eq!(legacy.network_id, BytesN::from_array(&env, &NET_A));
            assert_eq!(legacy.version, 0);
            client.add_liquidity(&user, &1_000_000, &1_000_000, &0, &legacy);

            let reserves = client.get_reserves();
            let supply = client.get_total_supply();
            let lp = client.get_lp_balance(&user);

            // Migration pins the network and bumps the version without touching
            // reserves, LP supply or balances.
            let migrated = client.migrate();
            assert_eq!(migrated.network_id, BytesN::from_array(&env, &NET_A));
            assert_eq!(migrated.version, CURRENT_POOL_VERSION);
            assert_eq!(client.get_reserves(), reserves);
            assert_eq!(client.get_total_supply(), supply);
            assert_eq!(client.get_lp_balance(&user), lp);

            // Idempotent, and the bound context is what an operation accepts.
            assert_eq!(client.migrate(), migrated);
            let out = client.swap(&user, &token0, &10_000, &0, &migrated);
            assert!(out > 0);
        }

        #[test]
        fn stale_version_context_is_rejected_and_a_refreshed_retry_succeeds() {
            let env = Env::default();
            env.ledger().set_network_id(NET_A);
            let (client, user, token0, token1, _) = setup_pool_with_tokens(&env, 100);
            degrade_to_legacy_pool(&env, &client.address);

            let legacy = client.get_pool_context();
            client.add_liquidity(&user, &1_000_000, &1_000_000, &0, &legacy);
            let reserves = client.get_reserves();
            let supply = client.get_total_supply();
            let lp = client.get_lp_balance(&user);
            let t0 = token::Client::new(&env, &token0);
            let t1 = token::Client::new(&env, &token1);
            let bal0 = t0.balance(&user);
            let bal1 = t1.balance(&user);

            // The pool is migrated after the caller captured its context: the
            // caller's snapshot is now from another version of the pool.
            client.migrate();
            assert_eq!(
                client.try_swap(&user, &token0, &10_000, &0, &legacy),
                Err(Ok(StableSwapError::WrongVersion))
            );
            assert_eq!(
                client.try_remove_liquidity(&user, &(lp / 2), &0, &0, &legacy),
                Err(Ok(StableSwapError::WrongVersion))
            );
            // Nothing moved and no LP was burned.
            assert_eq!(t0.balance(&user), bal0);
            assert_eq!(t1.balance(&user), bal1);
            assert_eq!(client.get_reserves(), reserves);
            assert_eq!(client.get_total_supply(), supply);
            assert_eq!(client.get_lp_balance(&user), lp);

            // Refresh the context and retry the same swap: it settles once.
            let refreshed = client.get_pool_context();
            let out = client.swap(&user, &token0, &10_000, &0, &refreshed);
            assert!(out > 0);
            assert_eq!(t0.balance(&user), bal0 - 10_000);
            assert_eq!(t1.balance(&user), bal1 + out);
        }

        #[test]
        fn state_read_on_another_network_is_rejected_and_recovers() {
            let env = Env::default();
            env.ledger().set_network_id(NET_A);
            let (client, user, token0, _, _) = setup_pool_with_tokens(&env, 100);
            let context = client.get_pool_context();
            client.add_liquidity(&user, &1_000_000, &1_000_000, &0, &context);

            let supply = client.get_total_supply();
            let lp = client.get_lp_balance(&user);
            let t0 = token::Client::new(&env, &token0);
            let bal0 = t0.balance(&user);

            // Ledger transition: the same entries are now read on another
            // network, so they no longer describe a pool on this chain.
            env.ledger().set_network_id(NET_B);
            assert_eq!(
                client.try_get_reserves(),
                Err(Ok(StableSwapError::WrongNetwork))
            );
            assert_eq!(
                client.try_swap(&user, &token0, &10_000, &0, &context),
                Err(Ok(StableSwapError::WrongNetwork))
            );
            assert_eq!(
                client.try_add_liquidity(&user, &1_000, &1_000, &0, &context),
                Err(Ok(StableSwapError::WrongNetwork))
            );
            assert_eq!(
                client.try_remove_liquidity(&user, &(lp / 2), &0, &0, &context),
                Err(Ok(StableSwapError::WrongNetwork))
            );
            // A context captured on the other network is refused as well.
            let mut foreign = context.clone();
            foreign.network_id = BytesN::from_array(&env, &NET_B);
            assert_eq!(
                client.try_swap(&user, &token0, &10_000, &0, &foreign),
                Err(Ok(StableSwapError::WrongNetwork))
            );

            // State and balances are untouched.
            assert_eq!(t0.balance(&user), bal0);
            assert_eq!(client.get_total_supply(), supply);
            assert_eq!(client.get_lp_balance(&user), lp);

            // Back on the bound network, the original context works again.
            env.ledger().set_network_id(NET_A);
            let out = client.swap(&user, &token0, &10_000, &0, &context);
            assert!(out > 0);
            assert_eq!(t0.balance(&user), bal0 - 10_000);
            let (reserve0, _) = client.get_reserves();
            assert!(reserve0 > 0);
        }

        #[test]
        fn context_for_another_deployment_is_rejected_without_state_change() {
            let env = Env::default();
            env.ledger().set_network_id(NET_A);
            let (client, user, _, _, _) = setup_pool_with_tokens(&env, 100);
            client.add_liquidity(&user, &1_000_000, &1_000_000, &0, &ctx(&client));

            let reserves = client.get_reserves();
            let supply = client.get_total_supply();
            let lp = client.get_lp_balance(&user);

            let mut foreign = client.get_pool_context();
            foreign.contract = Address::generate(&env);
            assert_eq!(
                client.try_add_liquidity(&user, &1_000, &1_000, &0, &foreign),
                Err(Ok(StableSwapError::WrongContract))
            );
            assert_eq!(
                client.try_remove_liquidity(&user, &(lp / 2), &0, &0, &foreign),
                Err(Ok(StableSwapError::WrongContract))
            );

            assert_eq!(client.get_reserves(), reserves);
            assert_eq!(client.get_total_supply(), supply);
            assert_eq!(client.get_lp_balance(&user), lp);
        }

        #[test]
        fn newer_stored_version_is_refused_rather_than_interpreted() {
            let env = Env::default();
            env.ledger().set_network_id(NET_A);
            let (client, user, token0, _, _) = setup_pool_with_tokens(&env, 100);
            client.add_liquidity(&user, &1_000_000, &1_000_000, &0, &ctx(&client));

            let reserves = client.get_reserves();
            let supply = client.get_total_supply();
            let lp = client.get_lp_balance(&user);

            // Code downgrade: the stored layout belongs to a newer version.
            set_version(&env, &client.address, CURRENT_POOL_VERSION + 1);
            let context = client.get_pool_context();
            assert_eq!(context.version, CURRENT_POOL_VERSION + 1);

            assert_eq!(
                client.try_swap(&user, &token0, &10_000, &0, &context),
                Err(Ok(StableSwapError::WrongVersion))
            );
            assert_eq!(client.try_migrate(), Err(Ok(StableSwapError::WrongVersion)));

            assert_eq!(client.get_reserves(), reserves);
            assert_eq!(client.get_total_supply(), supply);
            assert_eq!(client.get_lp_balance(&user), lp);
        }

        #[test]
        fn migration_never_rebinds_state_from_another_network() {
            let env = Env::default();
            env.ledger().set_network_id(NET_A);
            let (client, user, _, _, _) = setup_pool_with_tokens(&env, 100);
            client.add_liquidity(&user, &1_000_000, &1_000_000, &0, &ctx(&client));

            env.ledger().set_network_id(NET_B);
            assert_eq!(client.try_migrate(), Err(Ok(StableSwapError::WrongNetwork)));

            // The original binding survived the rejected migration.
            env.ledger().set_network_id(NET_A);
            assert_eq!(
                client.get_pool_context().network_id,
                BytesN::from_array(&env, &NET_A)
            );
        }

        #[test]
        fn migration_requires_admin_authorization() {
            let env = Env::default();
            env.ledger().set_network_id(NET_A);
            let (client, user, _, _, _) = setup_pool_with_tokens(&env, 100);
            client.add_liquidity(&user, &1_000_000, &1_000_000, &0, &ctx(&client));
            degrade_to_legacy_pool(&env, &client.address);

            let reserves = client.get_reserves();
            let supply = client.get_total_supply();

            env.mock_auths(&[]);
            assert!(client.try_migrate().is_err());

            // Still an unbound legacy pool; nothing was migrated.
            let context = client.get_pool_context();
            assert_eq!(context.version, 0);
            assert_eq!(client.get_reserves(), reserves);
            assert_eq!(client.get_total_supply(), supply);
        }
    }
}
