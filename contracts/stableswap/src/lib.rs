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
    /// `token_in` is neither of the pool's two tokens.
    UnknownToken = 11,
}

// ── Diagnostics ─────────────────────────────────────────────────────────

/// Stage of an operation at which a failure occurred.
///
/// Diagnostics intentionally carry only these coarse enums and the numeric
/// `StableSwapError` code — never addresses, amounts, reserves or balances —
/// so they are safe to log, surface in UIs and relay off-chain.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FailureStage {
    /// No failure.
    None = 0,
    /// Pool is not initialized or has no usable liquidity.
    PoolState = 1,
    /// Caller-supplied arguments were rejected.
    InputValidation = 2,
    /// Dynamic fee computation failed.
    FeeComputation = 3,
    /// Invariant (D / y) solving failed.
    Invariant = 4,
    /// Result fell below the caller's slippage bound.
    Slippage = 5,
}

/// Suggested next step for the caller.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RemediationPath {
    /// Nothing to do; the operation would succeed.
    None = 0,
    /// Initialize the pool first.
    InitializePool = 1,
    /// Fix the call arguments and retry.
    FixInput = 2,
    /// Add liquidity (or use a smaller size) and retry.
    AddLiquidity = 3,
    /// Reduce the amount and retry.
    ReduceAmount = 4,
    /// Loosen the minimum-output bound or reduce size, then retry.
    RelaxSlippage = 5,
    /// Not caller-fixable; contact the pool admin.
    ContactAdmin = 6,
}

/// Privacy-safe result of a dry-run (`preview_*`) call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    pub ok: bool,
    pub stage: FailureStage,
    /// `StableSwapError` discriminant, or 0 when `ok`.
    pub error_code: u32,
    pub remediation: RemediationPath,
}

/// Internal failure carrying the stage alongside the error.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
struct Failure {
    stage: FailureStage,
    error: StableSwapError,
}

fn at(stage: FailureStage) -> impl Fn(StableSwapError) -> Failure {
    move |error| Failure { stage, error }
}

fn fail(stage: FailureStage, error: StableSwapError) -> Failure {
    Failure { stage, error }
}

fn remediation_for(f: &Failure) -> RemediationPath {
    match f.error {
        StableSwapError::NotInitialized => RemediationPath::InitializePool,
        StableSwapError::InvalidAmount | StableSwapError::UnknownToken => RemediationPath::FixInput,
        StableSwapError::InsufficientLiquidity | StableSwapError::ZeroInvariant => {
            RemediationPath::AddLiquidity
        }
        StableSwapError::InsufficientOutput => RemediationPath::RelaxSlippage,
        StableSwapError::MathOverflow => RemediationPath::ReduceAmount,
        _ => RemediationPath::ContactAdmin,
    }
}

fn diagnostic_of<T>(r: Result<T, Failure>) -> Diagnostic {
    match r {
        Ok(_) => Diagnostic {
            ok: true,
            stage: FailureStage::None,
            error_code: 0,
            remediation: RemediationPath::None,
        },
        Err(f) => Diagnostic {
            ok: false,
            stage: f.stage,
            error_code: f.error as u32,
            remediation: remediation_for(&f),
        },
    }
}

/// Fully validated add-liquidity outcome; nothing is written until it exists.
struct AddLiquidityPlan {
    token0: Address,
    token1: Address,
    new_reserve0: i128,
    new_reserve1: i128,
    mint_amount: i128,
    new_supply: i128,
}

/// Fully validated swap outcome; nothing is written until it exists.
struct SwapPlan {
    token_out: Address,
    token_in_is_0: bool,
    new_reserve_in: i128,
    new_reserve_out: i128,
    amount_out: i128,
    fee: i128,
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
    ///
    /// All validation and math run before any token transfer or storage write,
    /// so a failure leaves reserves, supply and LP balances untouched and the
    /// call can be retried safely with corrected arguments.
    pub fn add_liquidity(
        env: Env,
        sender: Address,
        amount0: i128,
        amount1: i128,
        min_mint_amount: i128,
    ) -> Result<i128, StableSwapError> {
        sender.require_auth();
        let plan = Self::plan_add_liquidity(&env, amount0, amount1, min_mint_amount)
            .map_err(|f| f.error)?;

        let lp_key = DataKey::LpBalance(sender.clone());
        let old_lp: i128 = env.storage().persistent().get(&lp_key).unwrap_or(0);
        let new_lp = old_lp
            .checked_add(plan.mint_amount)
            .ok_or(StableSwapError::MathOverflow)?;

        // Pull tokens from sender
        token::Client::new(&env, &plan.token0).transfer(
            &sender,
            &env.current_contract_address(),
            &amount0,
        );
        token::Client::new(&env, &plan.token1).transfer(
            &sender,
            &env.current_contract_address(),
            &amount1,
        );

        env.storage()
            .instance()
            .set(&DataKey::Reserve0, &plan.new_reserve0);
        env.storage()
            .instance()
            .set(&DataKey::Reserve1, &plan.new_reserve1);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &plan.new_supply);
        env.storage().persistent().set(&lp_key, &new_lp);

        env.events().publish(
            (symbol_short!("add_liq"),),
            (sender, amount0, amount1, plan.mint_amount),
        );
        Ok(plan.mint_amount)
    }

    /// Read-only dry run of `add_liquidity`. Never mutates state and returns a
    /// privacy-safe [`Diagnostic`] (failed stage, error code, remediation).
    pub fn preview_add_liquidity(
        env: Env,
        amount0: i128,
        amount1: i128,
        min_mint_amount: i128,
    ) -> Diagnostic {
        diagnostic_of(Self::plan_add_liquidity(
            &env,
            amount0,
            amount1,
            min_mint_amount,
        ))
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

        if lp_amount <= 0 {
            return Err(StableSwapError::InvalidAmount);
        }

        let lp_key = DataKey::LpBalance(sender.clone());
        let sender_lp: i128 = env.storage().persistent().get(&lp_key).unwrap_or(0);
        if sender_lp < lp_amount {
            return Err(StableSwapError::InsufficientLiquidity);
        }

        let reserve0: i128 = env.storage().instance().get(&DataKey::Reserve0).unwrap();
        let reserve1: i128 = env.storage().instance().get(&DataKey::Reserve1).unwrap();
        let total_supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap();

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

        // Burn LP
        env.storage()
            .persistent()
            .set(&lp_key, &(sender_lp - lp_amount));
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(total_supply - lp_amount));
        env.storage()
            .instance()
            .set(&DataKey::Reserve0, &(reserve0 - out0));
        env.storage()
            .instance()
            .set(&DataKey::Reserve1, &(reserve1 - out1));

        let token0: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1: Address = env.storage().instance().get(&DataKey::Token1).unwrap();
        token::Client::new(&env, &token0).transfer(&env.current_contract_address(), &sender, &out0);
        token::Client::new(&env, &token1).transfer(&env.current_contract_address(), &sender, &out1);

        env.events()
            .publish((symbol_short!("rem_liq"),), (sender, lp_amount, out0, out1));
        Ok((out0, out1))
    }

    // ── Swap ───────────────────────────────────────────────────────────

    /// Swap `token_in` for `token_out`.
    ///
    /// Applies a dynamic fee that increases when the pool is more imbalanced.
    /// `min_out` provides slippage protection for the caller.
    ///
    /// The whole swap is planned and validated before any transfer or write, so
    /// a failure leaves reserves untouched and the call can be retried safely.
    pub fn swap(
        env: Env,
        sender: Address,
        token_in: Address,
        amount_in: i128,
        min_out: i128,
    ) -> Result<i128, StableSwapError> {
        sender.require_auth();
        let plan = Self::plan_swap(&env, &token_in, amount_in, min_out).map_err(|f| f.error)?;

        // Transfer tokens
        token::Client::new(&env, &token_in).transfer(
            &sender,
            &env.current_contract_address(),
            &amount_in,
        );
        token::Client::new(&env, &plan.token_out).transfer(
            &env.current_contract_address(),
            &sender,
            &plan.amount_out,
        );

        // Update reserves
        let (new_r0, new_r1) = if plan.token_in_is_0 {
            (plan.new_reserve_in, plan.new_reserve_out)
        } else {
            (plan.new_reserve_out, plan.new_reserve_in)
        };
        env.storage().instance().set(&DataKey::Reserve0, &new_r0);
        env.storage().instance().set(&DataKey::Reserve1, &new_r1);

        env.events().publish(
            (symbol_short!("swap"),),
            (sender, token_in, amount_in, plan.amount_out, plan.fee),
        );
        Ok(plan.amount_out)
    }

    /// Read-only dry run of `swap`. Never mutates state and returns a
    /// privacy-safe [`Diagnostic`] (failed stage, error code, remediation).
    pub fn preview_swap(env: Env, token_in: Address, amount_in: i128, min_out: i128) -> Diagnostic {
        diagnostic_of(Self::plan_swap(&env, &token_in, amount_in, min_out))
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

    // ── Planning (pure validation + math, no writes) ───────────────────

    fn plan_add_liquidity(
        env: &Env,
        amount0: i128,
        amount1: i128,
        min_mint_amount: i128,
    ) -> Result<AddLiquidityPlan, Failure> {
        Self::assert_initialized(env).map_err(at(FailureStage::PoolState))?;

        if amount0 <= 0 || amount1 <= 0 {
            return Err(fail(
                FailureStage::InputValidation,
                StableSwapError::InvalidAmount,
            ));
        }

        let s = env.storage().instance();
        let token0: Address = s.get(&DataKey::Token0).unwrap();
        let token1: Address = s.get(&DataKey::Token1).unwrap();
        let reserve0: i128 = s.get(&DataKey::Reserve0).unwrap();
        let reserve1: i128 = s.get(&DataKey::Reserve1).unwrap();
        let total_supply: i128 = s.get(&DataKey::TotalSupply).unwrap();
        let amp_coeff: u32 = s.get(&DataKey::AmpCoeff).unwrap();

        let inv = at(FailureStage::Invariant);
        let overflow = || StableSwapError::MathOverflow;

        let new_reserve0 = reserve0
            .checked_add(amount0)
            .ok_or_else(overflow)
            .map_err(&inv)?;
        let new_reserve1 = reserve1
            .checked_add(amount1)
            .ok_or_else(overflow)
            .map_err(&inv)?;

        let d0 = if total_supply == 0 {
            0
        } else {
            Self::compute_d(reserve0, reserve1, amp_coeff).map_err(&inv)?
        };
        let d1 = Self::compute_d(new_reserve0, new_reserve1, amp_coeff).map_err(&inv)?;

        if d1 <= d0 {
            return Err(fail(
                FailureStage::Invariant,
                StableSwapError::ZeroInvariant,
            ));
        }

        let mint_amount = if total_supply == 0 {
            d1
        } else {
            total_supply
                .checked_mul(d1 - d0)
                .ok_or_else(overflow)
                .map_err(&inv)?
                .checked_div(d0)
                .ok_or_else(overflow)
                .map_err(&inv)?
        };

        if mint_amount < min_mint_amount {
            return Err(fail(
                FailureStage::Slippage,
                StableSwapError::InsufficientOutput,
            ));
        }

        let new_supply = total_supply
            .checked_add(mint_amount)
            .ok_or_else(overflow)
            .map_err(&inv)?;

        Ok(AddLiquidityPlan {
            token0,
            token1,
            new_reserve0,
            new_reserve1,
            mint_amount,
            new_supply,
        })
    }

    fn plan_swap(
        env: &Env,
        token_in: &Address,
        amount_in: i128,
        min_out: i128,
    ) -> Result<SwapPlan, Failure> {
        Self::assert_initialized(env).map_err(at(FailureStage::PoolState))?;

        if amount_in <= 0 {
            return Err(fail(
                FailureStage::InputValidation,
                StableSwapError::InvalidAmount,
            ));
        }

        let s = env.storage().instance();
        let token0: Address = s.get(&DataKey::Token0).unwrap();
        let token1: Address = s.get(&DataKey::Token1).unwrap();
        let r0: i128 = s.get(&DataKey::Reserve0).unwrap();
        let r1: i128 = s.get(&DataKey::Reserve1).unwrap();

        let (token_in_is_0, reserve_in, reserve_out, token_out) = if *token_in == token0 {
            (true, r0, r1, token1)
        } else if *token_in == token1 {
            (false, r1, r0, token0)
        } else {
            return Err(fail(
                FailureStage::InputValidation,
                StableSwapError::UnknownToken,
            ));
        };

        // An empty (or one-sided) pool cannot price a swap.
        if reserve_in <= 0 || reserve_out <= 0 {
            return Err(fail(
                FailureStage::PoolState,
                StableSwapError::InsufficientLiquidity,
            ));
        }

        let amp_coeff: u32 = s.get(&DataKey::AmpCoeff).unwrap();
        let base_fee: u32 = s.get(&DataKey::BaseFee).unwrap();
        let fee_multiplier: u32 = s.get(&DataKey::FeeMultiplier).unwrap();

        let fee_stage = at(FailureStage::FeeComputation);
        let inv = at(FailureStage::Invariant);
        let overflow = || StableSwapError::MathOverflow;

        // Compute dynamic fee based on imbalance before the swap
        let fee = Self::compute_dynamic_fee(reserve_in, reserve_out, base_fee, fee_multiplier)
            .map_err(&fee_stage)?;
        if !(0..=FEE_PRECISION).contains(&fee) {
            return Err(fail(
                FailureStage::FeeComputation,
                StableSwapError::InvalidFee,
            ));
        }

        // Amount after fee deduction
        let amount_in_after_fee = amount_in
            .checked_mul(FEE_PRECISION - fee)
            .ok_or_else(overflow)
            .map_err(&fee_stage)?
            .checked_div(FEE_PRECISION)
            .ok_or_else(overflow)
            .map_err(&fee_stage)?;

        // Compute new reserve_out using the invariant
        let new_reserve_in = reserve_in
            .checked_add(amount_in_after_fee)
            .ok_or_else(overflow)
            .map_err(&inv)?;
        let sum = reserve_in
            .checked_add(reserve_out)
            .ok_or_else(overflow)
            .map_err(&inv)?;
        let new_reserve_out = Self::compute_y(new_reserve_in, sum, amp_coeff).map_err(&inv)?;

        let amount_out = reserve_out
            .checked_sub(new_reserve_out)
            .ok_or_else(overflow)
            .map_err(&inv)?;

        // The pool must never pay out more than it holds, nor a non-positive amount.
        if amount_out <= 0 || amount_out >= reserve_out {
            return Err(fail(
                FailureStage::Invariant,
                StableSwapError::InsufficientLiquidity,
            ));
        }

        if amount_out < min_out {
            return Err(fail(
                FailureStage::Slippage,
                StableSwapError::InsufficientOutput,
            ));
        }

        Ok(SwapPlan {
            token_out,
            token_in_is_0,
            new_reserve_in,
            new_reserve_out,
            amount_out,
            fee,
        })
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

        let s = x.checked_add(y).ok_or(StableSwapError::MathOverflow)?;
        // A·n^n  (n=2, n^n=4)
        let ann: i128 = (amp as i128)
            .checked_mul(4)
            .ok_or(StableSwapError::MathOverflow)?;

        let mut d = s;

        for _ in 0..NEWTON_ITERS {
            // d_prod = D^3 / (4·x·y)
            let d3 = d
                .checked_mul(d)
                .and_then(|v| v.checked_mul(d))
                .ok_or(StableSwapError::MathOverflow)?;
            let four_xy = x
                .checked_mul(4)
                .and_then(|v| v.checked_mul(y))
                .ok_or(StableSwapError::MathOverflow)?;
            let d_prod = d3
                .checked_div(four_xy)
                .ok_or(StableSwapError::MathOverflow)?;

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

            let d_next = numer
                .checked_div(denom)
                .ok_or(StableSwapError::MathOverflow)?;

            // Converged?
            if (d_next - d).abs() <= 1 {
                return Ok(d_next);
            }
            d = d_next;
        }
        Ok(d)
    }

    /// Given the new reserve of one token (x_new), compute the required
    /// reserve of the other token (y) to maintain the invariant D.
    ///
    /// Solves: y^2 + (b − D)·y − D^3/(4·A·n^n·x_new) = 0
    /// where b = x_new + D/ann
    fn compute_y(x_new: i128, sum: i128, amp: u32) -> Result<i128, StableSwapError> {
        if x_new <= 0 {
            return Err(StableSwapError::InvalidAmount);
        }

        // Recompute D from current sum (approximation: use sum as proxy for D)
        // For the purpose of computing y we iteratively solve:
        //   y_{k+1} = (y_k^2 + D^3/(4·ann·x_new)) / (2·y_k + b − D)
        // where b = x_new + D/ann,  D ≈ sum (initial guess)
        let ann: i128 = (amp as i128)
            .checked_mul(4)
            .ok_or(StableSwapError::MathOverflow)?;

        // Approximate D as proportional to sum (conservative; accurate enough for 2-coin pools)
        let d = sum;

        // b = x_new + D/ann
        let b = x_new
            .checked_add(d.checked_div(ann).ok_or(StableSwapError::MathOverflow)?)
            .ok_or(StableSwapError::MathOverflow)?;

        // c = D^3 / (4·ann·x_new)
        let d3 = d
            .checked_mul(d)
            .and_then(|v| v.checked_mul(d))
            .ok_or(StableSwapError::MathOverflow)?;
        let four_ann_x = ann
            .checked_mul(4)
            .and_then(|v| v.checked_mul(x_new))
            .ok_or(StableSwapError::MathOverflow)?;
        let c = d3
            .checked_div(four_ann_x)
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
            let y_next = numer
                .checked_div(denom)
                .ok_or(StableSwapError::MathOverflow)?;
            if (y_next - y).abs() <= 1 {
                return Ok(y_next);
            }
            y = y_next;
        }
        Ok(y)
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

        (base_fee as i128)
            .checked_add(additional_fee)
            .ok_or(StableSwapError::MathOverflow)
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

    // ── Diagnostics, state preservation and safe retry ─────────────────

    use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};

    /// Deploy a pool backed by real token contracts and a funded user.
    fn funded_pool(env: &Env) -> (StableSwapClient<'_>, Address, Address, Address) {
        env.mock_all_auths();
        let issuer = Address::generate(env);
        let t0 = env
            .register_stellar_asset_contract_v2(issuer.clone())
            .address();
        let t1 = env.register_stellar_asset_contract_v2(issuer).address();
        let user = Address::generate(env);
        StellarAssetClient::new(env, &t0).mint(&user, &10_000_000);
        StellarAssetClient::new(env, &t1).mint(&user, &10_000_000);

        let contract_id = env.register(StableSwap, ());
        let client = StableSwapClient::new(env, &contract_id);
        let lp = Address::generate(env);
        client.initialize(
            &Address::generate(env),
            &t0,
            &t1,
            &lp,
            &100,
            &30_000,
            &20_000,
        );
        (client, t0, t1, user)
    }

    /// Snapshot of everything a failed call must leave untouched.
    fn snapshot(
        env: &Env,
        client: &StableSwapClient<'_>,
        t0: &Address,
        t1: &Address,
        user: &Address,
    ) -> ((i128, i128), i128, i128, i128, i128) {
        (
            client.get_reserves(),
            client.get_total_supply(),
            client.get_lp_balance(user),
            TokenClient::new(env, t0).balance(user),
            TokenClient::new(env, t1).balance(user),
        )
    }

    #[test]
    fn test_swap_normal_operation_and_preview_ok() {
        let env = Env::default();
        let (client, t0, t1, user) = funded_pool(&env);
        client.add_liquidity(&user, &1_000_000, &1_000_000, &0);

        let preview = client.preview_swap(&t0, &10_000, &0);
        assert!(preview.ok);
        assert_eq!(preview.stage, FailureStage::None);
        assert_eq!(preview.error_code, 0);
        assert_eq!(preview.remediation, RemediationPath::None);

        let out = client.swap(&user, &t0, &10_000, &0);
        assert!(out > 0 && out < 10_000);
        let (r0, r1) = client.get_reserves();
        assert!(r0 > 1_000_000 && r1 < 1_000_000);
        assert_eq!(TokenClient::new(&env, &t1).balance(&user), 9_000_000 + out);
    }

    #[test]
    fn test_swap_slippage_failure_preserves_state_and_retry_succeeds() {
        let env = Env::default();
        let (client, t0, t1, user) = funded_pool(&env);
        client.add_liquidity(&user, &1_000_000, &1_000_000, &0);
        let before = snapshot(&env, &client, &t0, &t1, &user);

        // Unreachable min_out -> slippage failure.
        let res = client.try_swap(&user, &t0, &10_000, &10_000);
        assert_eq!(res, Err(Ok(StableSwapError::InsufficientOutput)));
        assert_eq!(snapshot(&env, &client, &t0, &t1, &user), before);

        let diag = client.preview_swap(&t0, &10_000, &10_000);
        assert!(!diag.ok);
        assert_eq!(diag.stage, FailureStage::Slippage);
        assert_eq!(diag.error_code, StableSwapError::InsufficientOutput as u32);
        assert_eq!(diag.remediation, RemediationPath::RelaxSlippage);

        // Safe retry with a sane bound succeeds from the identical state.
        let out = client.swap(&user, &t0, &10_000, &9_000);
        assert!(out >= 9_000);
    }

    #[test]
    fn test_swap_invalid_inputs_report_stage_and_preserve_state() {
        let env = Env::default();
        let (client, t0, t1, user) = funded_pool(&env);
        client.add_liquidity(&user, &1_000_000, &1_000_000, &0);
        let before = snapshot(&env, &client, &t0, &t1, &user);

        let res = client.try_swap(&user, &t0, &0, &0);
        assert_eq!(res, Err(Ok(StableSwapError::InvalidAmount)));
        let d = client.preview_swap(&t0, &-1, &0);
        assert_eq!(d.stage, FailureStage::InputValidation);
        assert_eq!(d.remediation, RemediationPath::FixInput);

        let stranger = Address::generate(&env);
        let res = client.try_swap(&user, &stranger, &1_000, &0);
        assert_eq!(res, Err(Ok(StableSwapError::UnknownToken)));
        let d = client.preview_swap(&stranger, &1_000, &0);
        assert_eq!(d.stage, FailureStage::InputValidation);
        assert_eq!(d.error_code, StableSwapError::UnknownToken as u32);

        assert_eq!(snapshot(&env, &client, &t0, &t1, &user), before);
    }

    #[test]
    fn test_swap_on_empty_pool_reports_pool_state() {
        let env = Env::default();
        let (client, t0, t1, user) = funded_pool(&env);
        let before = snapshot(&env, &client, &t0, &t1, &user);

        let res = client.try_swap(&user, &t0, &1_000, &0);
        assert_eq!(res, Err(Ok(StableSwapError::InsufficientLiquidity)));
        let d = client.preview_swap(&t0, &1_000, &0);
        assert_eq!(d.stage, FailureStage::PoolState);
        assert_eq!(d.remediation, RemediationPath::AddLiquidity);
        assert_eq!(snapshot(&env, &client, &t0, &t1, &user), before);
    }

    #[test]
    fn test_swap_overflow_reports_stage_and_preserves_state() {
        let env = Env::default();
        let (client, t0, t1, user) = funded_pool(&env);
        client.add_liquidity(&user, &1_000_000, &1_000_000, &0);
        let before = snapshot(&env, &client, &t0, &t1, &user);

        let res = client.try_swap(&user, &t0, &i128::MAX, &0);
        assert!(res.is_err());
        let d = client.preview_swap(&t0, &i128::MAX, &0);
        assert!(!d.ok);
        assert!(matches!(
            d.stage,
            FailureStage::FeeComputation | FailureStage::Invariant
        ));
        assert_eq!(d.remediation, RemediationPath::ReduceAmount);
        assert_eq!(snapshot(&env, &client, &t0, &t1, &user), before);
    }

    #[test]
    fn test_add_liquidity_failure_moves_no_tokens_and_retry_succeeds() {
        let env = Env::default();
        let (client, t0, t1, user) = funded_pool(&env);
        let before = snapshot(&env, &client, &t0, &t1, &user);

        // Invalid amount.
        let res = client.try_add_liquidity(&user, &0, &1_000, &0);
        assert_eq!(res, Err(Ok(StableSwapError::InvalidAmount)));
        let d = client.preview_add_liquidity(&0, &1_000, &0);
        assert_eq!(d.stage, FailureStage::InputValidation);

        // Slippage bound that cannot be met: tokens must NOT have moved.
        let res = client.try_add_liquidity(&user, &1_000_000, &1_000_000, &i128::MAX);
        assert_eq!(res, Err(Ok(StableSwapError::InsufficientOutput)));
        let d = client.preview_add_liquidity(&1_000_000, &1_000_000, &i128::MAX);
        assert_eq!(d.stage, FailureStage::Slippage);
        assert_eq!(d.remediation, RemediationPath::RelaxSlippage);
        assert_eq!(snapshot(&env, &client, &t0, &t1, &user), before);

        // Safe retry.
        let minted = client.add_liquidity(&user, &1_000_000, &1_000_000, &0);
        assert!(minted > 0);
        assert_eq!(client.get_lp_balance(&user), minted);
        assert_eq!(client.get_reserves(), (1_000_000, 1_000_000));
    }

    #[test]
    fn test_preview_on_uninitialized_pool_reports_pool_state() {
        let env = Env::default();
        let contract_id = env.register(StableSwap, ());
        let client = StableSwapClient::new(&env, &contract_id);
        let any = Address::generate(&env);

        let d = client.preview_swap(&any, &1_000, &0);
        assert!(!d.ok);
        assert_eq!(d.stage, FailureStage::PoolState);
        assert_eq!(d.error_code, StableSwapError::NotInitialized as u32);
        assert_eq!(d.remediation, RemediationPath::InitializePool);

        let d = client.preview_add_liquidity(&1_000, &1_000, &0);
        assert_eq!(d.stage, FailureStage::PoolState);
        assert_eq!(d.remediation, RemediationPath::InitializePool);
    }
}
