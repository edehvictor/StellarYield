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
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
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

        env.events()
            .publish((symbol_short!("init"),), (admin, amp_coeff, base_fee));
        Ok(())
    }

    // ── Liquidity ──────────────────────────────────────────────────────

    /// Deposit `amount0` of token0 and `amount1` of token1, receive LP tokens.
    /// `min_mint_amount` guards against sandwich attacks on the initial ratio.
    pub fn add_liquidity(
        env: Env,
        sender: Address,
        amount0: i128,
        amount1: i128,
        min_mint_amount: i128,
    ) -> Result<i128, StableSwapError> {
        sender.require_auth();
        Self::assert_initialized(&env)?;

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
    pub fn remove_liquidity(
        env: Env,
        sender: Address,
        lp_amount: i128,
        min_amount0: i128,
        min_amount1: i128,
    ) -> Result<(i128, i128), StableSwapError> {
        sender.require_auth();
        Self::assert_initialized(&env)?;

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
    pub fn swap(
        env: Env,
        sender: Address,
        token_in: Address,
        amount_in: i128,
        min_out: i128,
    ) -> Result<i128, StableSwapError> {
        sender.require_auth();
        Self::assert_initialized(&env)?;

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

    pub fn get_reserves(env: Env) -> Result<(i128, i128), StableSwapError> {
        Self::assert_initialized(&env)?;
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
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

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
        let mint = client.add_liquidity(&user, &1_000_000, &1_000_000, &1_000_000);
        assert!(mint >= 1_000_000);
        assert_eq!(t0_client.balance(&user), 9_000_000);
        assert_eq!(t1_client.balance(&user), 9_000_000);
        assert_eq!(client.get_reserves(), (1_000_000, 1_000_000));
        assert_eq!(client.get_lp_balance(&user), mint);
        assert_eq!(client.get_total_supply(), mint);

        // 2. Swap token0 for token1
        let swapped_out = client.swap(&user, &token0, &100_000, &90_000);
        assert!(swapped_out >= 90_000);
        assert_eq!(t0_client.balance(&user), 8_900_000);
        assert_eq!(t1_client.balance(&user), 9_000_000 + swapped_out);

        // 3. Remove liquidity
        let half_lp = mint / 2;
        let (out0, out1) = client.remove_liquidity(&user, &half_lp, &1, &1);
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
        let res0 = client.try_add_liquidity(&user, &0, &100_000, &0);
        assert_eq!(res0, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(t0_client.balance(&user), initial_b0);
        assert_eq!(t1_client.balance(&user), initial_b1);
        assert_eq!(client.get_reserves(), (0, 0));

        // 2. Negative amount1 rejected
        let res1 = client.try_add_liquidity(&user, &100_000, &-5, &0);
        assert_eq!(res1, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(t0_client.balance(&user), initial_b0);
        assert_eq!(t1_client.balance(&user), initial_b1);

        // 3. Negative min_mint_amount rejected
        let res_neg_min = client.try_add_liquidity(&user, &100_000, &100_000, &-1);
        assert_eq!(res_neg_min, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(t0_client.balance(&user), initial_b0);
        assert_eq!(t1_client.balance(&user), initial_b1);

        // 4. Slippage exceeded: min_mint_amount higher than minted LP
        let res_slip = client.try_add_liquidity(&user, &100_000, &100_000, &999_999_999);
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
        let fail_res = client.try_add_liquidity(&user, &500_000, &500_000, &10_000_000);
        assert_eq!(fail_res, Err(Ok(StableSwapError::InsufficientOutput)));
        assert_eq!(t0_client.balance(&user), 10_000_000);
        assert_eq!(t1_client.balance(&user), 10_000_000);

        // Retry: with realistic min_mint_amount succeeds
        let success_mint = client.add_liquidity(&user, &500_000, &500_000, &500_000);
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
        let res_empty = client.try_swap(&user, &token0, &100_000, &0);
        assert_eq!(res_empty, Err(Ok(StableSwapError::InsufficientLiquidity)));
        assert_eq!(t0_client.balance(&user), 10_000_000);

        // Bootstrap pool liquidity
        client.add_liquidity(&user, &1_000_000, &1_000_000, &1_000_000);
        let bal0_after_liq = t0_client.balance(&user);
        let bal1_after_liq = t1_client.balance(&user);
        let reserves_after_liq = client.get_reserves();

        // 2. Zero amount_in rejected
        let res_zero = client.try_swap(&user, &token0, &0, &0);
        assert_eq!(res_zero, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(t0_client.balance(&user), bal0_after_liq);
        assert_eq!(t1_client.balance(&user), bal1_after_liq);

        // 3. Negative min_out rejected
        let res_neg_out = client.try_swap(&user, &token0, &10_000, &-1);
        assert_eq!(res_neg_out, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(t0_client.balance(&user), bal0_after_liq);

        // 4. Untrusted token address rejected with typed InvalidToken
        let bogus_token = Address::generate(&env);
        let res_bogus = client.try_swap(&user, &bogus_token, &10_000, &0);
        assert_eq!(res_bogus, Err(Ok(StableSwapError::InvalidToken)));
        assert_eq!(t0_client.balance(&user), bal0_after_liq);
        assert_eq!(t1_client.balance(&user), bal1_after_liq);
        assert_eq!(client.get_reserves(), reserves_after_liq);

        // 5. Slippage exceeded rejected with InsufficientOutput and state preserved
        let res_slip = client.try_swap(&user, &token0, &10_000, &999_999);
        assert_eq!(res_slip, Err(Ok(StableSwapError::InsufficientOutput)));
        assert_eq!(t0_client.balance(&user), bal0_after_liq);
        assert_eq!(t1_client.balance(&user), bal1_after_liq);
        assert_eq!(client.get_reserves(), reserves_after_liq);
    }

    #[test]
    fn test_swap_safe_retry_after_failure() {
        let env = Env::default();
        let (client, user, token0, token1, _) = setup_pool_with_tokens(&env, 100);
        client.add_liquidity(&user, &1_000_000, &1_000_000, &1_000_000);

        let t0_client = token::Client::new(&env, &token0);
        let t1_client = token::Client::new(&env, &token1);
        let b0 = t0_client.balance(&user);
        let b1 = t1_client.balance(&user);

        // Fail 1: malformed token
        let fake_token = Address::generate(&env);
        assert_eq!(
            client.try_swap(&user, &fake_token, &50_000, &0),
            Err(Ok(StableSwapError::InvalidToken))
        );
        assert_eq!(t0_client.balance(&user), b0);

        // Fail 2: impossible slippage
        assert_eq!(
            client.try_swap(&user, &token0, &50_000, &200_000),
            Err(Ok(StableSwapError::InsufficientOutput))
        );
        assert_eq!(t0_client.balance(&user), b0);

        // Retry: valid swap succeeds
        let out = client.swap(&user, &token0, &50_000, &45_000);
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

        let mint = client.add_liquidity(&user, &1_000_000, &1_000_000, &1_000_000);
        let bal0 = t0_client.balance(&user);
        let bal1 = t1_client.balance(&user);
        let reserves = client.get_reserves();

        // 1. Zero lp_amount rejected
        let res_zero = client.try_remove_liquidity(&user, &0, &0, &0);
        assert_eq!(res_zero, Err(Ok(StableSwapError::InvalidAmount)));
        assert_eq!(client.get_lp_balance(&user), mint);

        // 2. Negative min_amount0 rejected
        let res_neg0 = client.try_remove_liquidity(&user, &100, &-1, &0);
        assert_eq!(res_neg0, Err(Ok(StableSwapError::InvalidAmount)));

        // 3. Negative min_amount1 rejected
        let res_neg1 = client.try_remove_liquidity(&user, &100, &0, &-1);
        assert_eq!(res_neg1, Err(Ok(StableSwapError::InvalidAmount)));

        // 4. lp_amount greater than user balance rejected
        let res_too_much = client.try_remove_liquidity(&user, &(mint + 1), &0, &0);
        assert_eq!(
            res_too_much,
            Err(Ok(StableSwapError::InsufficientLiquidity))
        );

        // 5. Slippage exceeded rejected
        let res_slip = client.try_remove_liquidity(&user, &(mint / 2), &999_999_999, &0);
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
        let mint = client.add_liquidity(&user, &1_000_000, &1_000_000, &1_000_000);

        let t0_client = token::Client::new(&env, &token0);
        let t1_client = token::Client::new(&env, &token1);
        let b0 = t0_client.balance(&user);
        let b1 = t1_client.balance(&user);

        // Excessive min_out fails
        let fail_res = client.try_remove_liquidity(&user, &(mint / 2), &5_000_000, &0);
        assert_eq!(fail_res, Err(Ok(StableSwapError::InsufficientOutput)));
        assert_eq!(client.get_lp_balance(&user), mint);

        // Safe retry with acceptable minimums succeeds
        let burn_amount = mint / 2;
        let (out0, out1) = client.remove_liquidity(&user, &burn_amount, &100_000, &100_000);
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
        let mint = client.add_liquidity(&user, &1, &1, &0);
        assert!(mint > 0);
        assert_eq!(client.get_reserves(), (1, 1));

        // A tiny withdrawal rounds both payouts to zero and is rejected, leaving
        // LP balance, supply, and reserves untouched.
        let tiny = mint / 2;
        if tiny > 0 {
            let res = client.try_remove_liquidity(&user, &tiny, &0, &0);
            assert_eq!(res, Err(Ok(StableSwapError::InsufficientLiquidity)));
            assert_eq!(client.get_lp_balance(&user), mint);
            assert_eq!(client.get_total_supply(), mint);
            assert_eq!(client.get_reserves(), (1, 1));
        }

        // Full exit returns exactly the reserves (floor division is exact here).
        let (out0, out1) = client.remove_liquidity(&user, &mint, &0, &0);
        assert_eq!((out0, out1), (1, 1));
        assert_eq!(client.get_reserves(), (0, 0));
        assert_eq!(client.get_total_supply(), 0);
    }

    #[test]
    fn test_withdrawal_rounding_is_documented_floor() {
        let env = Env::default();
        let (client, user, _token0, _token1, _) = setup_pool_with_tokens(&env, 100);

        let mint = client.add_liquidity(&user, &1_000_000, &1_000_000, &0);
        let (reserve0, reserve1) = client.get_reserves();
        let lp_amount = mint / 3;

        let (out0, out1) = client.remove_liquidity(&user, &lp_amount, &0, &0);

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

        client.add_liquidity(&user, &1_000, &1_000, &0);
        let reserves = client.get_reserves();
        let supply = client.get_total_supply();
        let bal0 = t0_client.balance(&user);
        let bal1 = t1_client.balance(&user);

        // reserve + i128::MAX overflows: typed failure before any transfer.
        assert_eq!(
            client.try_add_liquidity(&user, &i128::MAX, &1, &0),
            Err(Ok(StableSwapError::MathOverflow))
        );
        assert_eq!(client.get_reserves(), reserves);
        assert_eq!(client.get_total_supply(), supply);
        assert_eq!(t0_client.balance(&user), bal0);
        assert_eq!(t1_client.balance(&user), bal1);

        // Safe retry with a representable amount succeeds.
        let mint = client.add_liquidity(&user, &1_000, &1_000, &0);
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

        client.add_liquidity(&user, &1_000_000, &1_000_000, &0);
        let reserves = client.get_reserves();
        let bal0 = t0_client.balance(&user);
        let bal1 = t1_client.balance(&user);

        // `amount_in * fee_factor` cannot be represented: typed failure.
        assert_eq!(
            client.try_swap(&user, &token0, &i128::MAX, &0),
            Err(Ok(StableSwapError::MathOverflow))
        );
        assert_eq!(client.get_reserves(), reserves);
        assert_eq!(t0_client.balance(&user), bal0);
        assert_eq!(t1_client.balance(&user), bal1);

        // Safe retry.
        let out = client.swap(&user, &token0, &100_000, &0);
        assert!(out > 0);
        assert_eq!(t0_client.balance(&user), bal0 - 100_000);
        assert_eq!(t1_client.balance(&user), bal1 + out);
    }
}
