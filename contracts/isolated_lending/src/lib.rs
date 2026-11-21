#![no_std]
//! Isolated lending markets: each pair is an independent pool of one
//! collateral token and one debt token.
//!
//! ## Rounding and numeric limits
//!
//! All share, value and interest arithmetic is integer arithmetic on
//! non-negative amounts, so every division rounds **down** unless stated:
//!
//! - `collateral_value` = `floor(collateral · price_bps / 10_000)`;
//! - the borrow limit = `floor(collateral_value · collateral_factor_bps / 10_000)`;
//! - the reserve requirement = `floor(total_supplied · reserve_bps / 10_000)`;
//! - accrued index growth and interest = `floor(...)`, and a borrower's debt is
//!   `floor(debt · index / debt_index)`;
//! - protocol fees = `floor(interest · fee_bps / 10_000)`;
//! - the liquidation close-factor cap rounds **up** (`ceil(debt · bps / 10_000)`
//!   capped at the debt itself) so a 100% close factor can always clear a
//!   position;
//! - collateral seized for a repayment = `floor(repaid · 10_000 / price_bps)`,
//!   so the liquidator never receives more value than it repaid;
//! - `get_available_liquidity` floors at zero rather than returning a negative
//!   number.
//!
//! Every arithmetic operation is checked. Amounts that cannot be represented
//! (zero, negative, or beyond `i128`), as well as zero-valued prices or
//! indices, fail with a typed error (`InvalidAmount`, `InvalidConfig`,
//! `MathOverflow`). A failing call returns before any token transfer or storage
//! write, so balances, reserves, debt and configuration are unchanged and the
//! same operation can be retried with corrected inputs.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, xdr::ToXdr, Address,
    Bytes, BytesN, Env, Symbol,
};

const BPS_DENOMINATOR: i128 = 10_000;
/// Domain separator for the configuration fingerprint (versioned).
const CONFIG_FINGERPRINT_DOMAIN: &[u8] = b"stellaryield_il_config_v1";
/// Fixed-point scale of the borrow index (1.0 = `INDEX_SCALE`).
const INDEX_SCALE: i128 = 1_000_000_000;
/// Interest rates are parts per billion of the index, per ledger.
const RATE_SCALE: i128 = 1_000_000_000;
/// Operation receipts are bumped when their TTL falls below ~1 day of ledgers…
const OPERATION_TTL_THRESHOLD: u32 = 17_280;
/// …to ~30 days, so a delayed retry is still recognised as a duplicate.
const OPERATION_TTL_EXTEND_TO: u32 = 518_400;

#[contracttype]
#[derive(Clone)]
pub enum FactoryDataKey {
    Admin,
    PairCount,
    PairById(u32),
    PairByTokens(Address, Address),
}

#[contracttype]
#[derive(Clone)]
pub struct PairConfig {
    pub pair_id: u32,
    pub collateral_token: Address,
    pub debt_token: Address,
    pub collateral_factor_bps: u32,
}

/// Borrow eligibility policy for oracle quotes.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OraclePolicyConfig {
    pub min_confidence_bps: u32,
    pub max_age_ledgers: u32,
}

/// Immutable snapshot of the admin-controlled configuration that shapes
/// execution for a market.
///
/// Only configuration is included: balances, totals and the oracle quote are
/// excluded, because they change continuously (and the quote has its own
/// freshness policy) and must not invalidate a caller's snapshot. Two markets
/// with identical configuration values produce identical snapshots, and any
/// admin configuration change produces a different snapshot.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigSnapshot {
    pub collateral_factor_bps: u32,
    pub reserve_bps: u32,
    pub close_factor_bps: u32,
    pub collateral_price_bps: u32,
    pub interest_rate_per_ledger: u32,
    pub protocol_fee_bps: u32,
    pub oracle: Option<Address>,
    /// Whether an oracle policy is configured. When false the two policy
    /// values below are zero and borrowing does not consult the oracle.
    pub oracle_policy_configured: bool,
    pub oracle_min_confidence_bps: u32,
    pub oracle_max_age_ledgers: u32,
}

/// Latest quote pushed by the configured oracle.
#[contracttype]
#[derive(Clone)]
pub struct OracleQuoteData {
    pub price_bps: u32,
    pub confidence_bps: u32,
    pub ledger: u32,
}

/// Health-factor components of a position, valued exactly as `liquidate`
/// values them: it is liquidatable once
/// `debt_value > collateral_value * threshold_bps / 10_000`.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HealthFactor {
    /// Debt including interest accrued up to `ledger`, in debt-token units.
    pub debt_value: i128,
    /// Collateral at the collateral price, in debt-token units.
    pub collateral_value: i128,
    /// Collateral factor in bps; the liquidation threshold.
    pub threshold_bps: u32,
    /// Ledger sequence the components were calculated at.
    pub ledger: u32,
    /// Fingerprint of the configuration these components were calculated
    /// under. Pass it to `borrow`, `withdraw_collateral` or `liquidate` so the
    /// operation fails as stale instead of executing under a configuration the
    /// caller never saw.
    pub config_fingerprint: BytesN<32>,
}

/// Record of an operation applied under a caller-chosen identity (#1754).
///
/// Stored once the operation's effect is committed and returned unchanged to
/// every later submission of the same request with the same id.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperationReceipt {
    pub operation_id: BytesN<32>,
    /// `supply`, `withdraw`, `post_col`, `borrow`, `wd_col`, `repay`,
    /// `repay_for` or `queue_wd`.
    pub kind: Symbol,
    /// Account that authorized the operation and scopes the id.
    pub account: Address,
    /// Account whose position changed: `account` itself, or the borrower for
    /// `repay_for`.
    pub beneficiary: Address,
    pub amount: i128,
    /// Ledger sequence at which the effect was applied.
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum PairDataKey {
    Initialized,
    Admin,
    CollateralToken,
    DebtToken,
    CollateralFactorBps,
    TotalSupplied,
    TotalDebt,
    Supply(Address),
    Collateral(Address),
    Debt(Address),
    /// Debt written off after collateral ran out (debt-token units).
    BadDebt,
    /// Price of one collateral unit in debt-token units, in bps (10_000 = par).
    CollateralPriceBps,
    /// Share of total supply kept out of borrowing, in bps.
    ReserveBps,
    /// Sum of all queued withdrawals.
    PendingWithdrawals,
    PendingWithdrawal(Address),
    /// Marks a (borrower, liquidation id) pair as already settled.
    Liquidation(Address, u64),
    /// Max share of a borrower's debt one liquidation may repay, in bps.
    CloseFactorBps,
    /// Global borrow index; debts are scaled by it (see `DebtIndex`).
    BorrowIndex,
    LastAccrualLedger,
    /// Interest per ledger in parts per billion of the borrow index.
    InterestRatePerLedger,
    /// Borrow index at the time a borrower's debt was last written.
    DebtIndex(Address),
    /// Share of accrued interest owed to the protocol, in bps.
    ProtocolFeeBps,
    /// Accrued protocol fees not yet claimed (debt-token units).
    ProtocolFees,
    Oracle,
    OraclePolicy,
    OracleQuote,
    /// Receipt of an operation applied under a caller-chosen identity,
    /// scoped to the authorizing account (#1754).
    Operation(Address, BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum IsolatedLendingError {
    Unauthorized = 1,
    PairAlreadyExists = 2,
    PairNotFound = 3,
    InvalidConfig = 4,
    NotInitialized = 5,
    InvalidAmount = 6,
    InsufficientLiquidity = 7,
    InsufficientCollateral = 8,
    PositionStillBacked = 9,
    MathOverflow = 10,
    AlreadyLiquidated = 11,
    OracleQuoteMissing = 12,
    OracleQuoteStale = 13,
    OracleConfidenceTooLow = 14,
    StaleConfig = 15,
    /// The operation id is all zeroes, which is reserved as "no id".
    InvalidOperationId = 16,
    /// The operation id was already used by this account for a different
    /// request (another kind, beneficiary or amount).
    OperationConflict = 17,
}

#[contract]
pub struct IsolatedLendingFactory;

#[contractimpl]
impl IsolatedLendingFactory {
    pub fn initialize_factory(env: Env, admin: Address) {
        if env.storage().instance().has(&FactoryDataKey::Admin) {
            return;
        }
        env.storage().instance().set(&FactoryDataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&FactoryDataKey::PairCount, &0_u32);
    }

    pub fn create_pair(
        env: Env,
        admin: Address,
        collateral_token: Address,
        debt_token: Address,
        collateral_factor_bps: u32,
    ) -> Result<PairConfig, IsolatedLendingError> {
        admin.require_auth();
        let factory_admin: Address = env
            .storage()
            .instance()
            .get(&FactoryDataKey::Admin)
            .ok_or(IsolatedLendingError::Unauthorized)?;
        if admin != factory_admin {
            return Err(IsolatedLendingError::Unauthorized);
        }
        if collateral_token == debt_token
            || collateral_factor_bps == 0
            || collateral_factor_bps > 10_000
        {
            return Err(IsolatedLendingError::InvalidConfig);
        }

        let pair_key = FactoryDataKey::PairByTokens(collateral_token.clone(), debt_token.clone());
        if env.storage().instance().has(&pair_key) {
            return Err(IsolatedLendingError::PairAlreadyExists);
        }

        let mut pair_count: u32 = env
            .storage()
            .instance()
            .get(&FactoryDataKey::PairCount)
            .unwrap_or(0);
        pair_count = pair_count
            .checked_add(1)
            .ok_or(IsolatedLendingError::MathOverflow)?;

        let config = PairConfig {
            pair_id: pair_count,
            collateral_token: collateral_token.clone(),
            debt_token: debt_token.clone(),
            collateral_factor_bps,
        };

        env.storage()
            .instance()
            .set(&FactoryDataKey::PairCount, &pair_count);
        env.storage()
            .instance()
            .set(&FactoryDataKey::PairById(pair_count), &config);
        env.storage().instance().set(&pair_key, &pair_count);
        env.events().publish(
            (symbol_short!("pair_new"),),
            (
                pair_count,
                collateral_token,
                debt_token,
                collateral_factor_bps,
            ),
        );
        Ok(config)
    }

    pub fn get_pair_by_id(env: Env, pair_id: u32) -> Result<PairConfig, IsolatedLendingError> {
        env.storage()
            .instance()
            .get(&FactoryDataKey::PairById(pair_id))
            .ok_or(IsolatedLendingError::PairNotFound)
    }

    pub fn get_pair_by_tokens(
        env: Env,
        collateral_token: Address,
        debt_token: Address,
    ) -> Result<PairConfig, IsolatedLendingError> {
        let pair_id: u32 = env
            .storage()
            .instance()
            .get(&FactoryDataKey::PairByTokens(collateral_token, debt_token))
            .ok_or(IsolatedLendingError::PairNotFound)?;
        Self::get_pair_by_id(env, pair_id)
    }
}

#[contract]
pub struct IsolatedLendingPair;

#[contractimpl]
impl IsolatedLendingPair {
    pub fn initialize(
        env: Env,
        admin: Address,
        collateral_token: Address,
        debt_token: Address,
        collateral_factor_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        if env.storage().instance().has(&PairDataKey::Initialized) {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        if collateral_token == debt_token
            || collateral_factor_bps == 0
            || collateral_factor_bps > 10_000
        {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::Initialized, &true);
        env.storage().instance().set(&PairDataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&PairDataKey::CollateralToken, &collateral_token);
        env.storage()
            .instance()
            .set(&PairDataKey::DebtToken, &debt_token);
        env.storage()
            .instance()
            .set(&PairDataKey::CollateralFactorBps, &collateral_factor_bps);
        env.storage()
            .instance()
            .set(&PairDataKey::TotalSupplied, &0_i128);
        env.storage()
            .instance()
            .set(&PairDataKey::TotalDebt, &0_i128);
        Ok(())
    }

    /// Body of `supply`; the caller has already required `user` auth.
    fn supply_impl(env: Env, user: Address, amount: i128) -> Result<(), IsolatedLendingError> {
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;
        // Compute every checked value before moving tokens or writing storage:
        // returning `Err` does not roll back changes the call already made.
        let key = PairDataKey::Supply(user.clone());
        let old_supply: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_supply = old_supply
            .checked_add(amount)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let total_supplied: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalSupplied)
            .unwrap_or(0);
        let new_total_supplied = total_supplied
            .checked_add(amount)
            .ok_or(IsolatedLendingError::MathOverflow)?;

        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        token::Client::new(&env, &debt_token).transfer(
            &user,
            &env.current_contract_address(),
            &amount,
        );
        env.storage().persistent().set(&key, &new_supply);
        env.storage()
            .instance()
            .set(&PairDataKey::TotalSupplied, &new_total_supplied);
        Ok(())
    }

    /// Body of `withdraw`; the caller has already required `user` auth.
    fn withdraw_impl(env: Env, user: Address, amount: i128) -> Result<(), IsolatedLendingError> {
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;

        Self::accrue(&env)?;

        let key = PairDataKey::Supply(user.clone());
        let old_supply: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if old_supply < amount {
            return Err(IsolatedLendingError::InsufficientLiquidity);
        }
        // Accrued protocol fees are owed to the protocol, not to suppliers.
        if Self::redeemable_cash(&env)? < amount {
            return Err(IsolatedLendingError::InsufficientLiquidity);
        }
        // Validate the total before any storage write or transfer so a failure
        // leaves the supplier's balance and the market totals intact.
        let total_supplied: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalSupplied)
            .unwrap_or(0);
        if total_supplied < amount {
            return Err(IsolatedLendingError::MathOverflow);
        }
        let new_total_supplied = total_supplied - amount;

        env.storage().persistent().set(&key, &(old_supply - amount));
        Self::consume_pending_withdrawal(&env, &user, amount);
        env.storage()
            .instance()
            .set(&PairDataKey::TotalSupplied, &new_total_supplied);

        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        token::Client::new(&env, &debt_token).transfer(
            &env.current_contract_address(),
            &user,
            &amount,
        );
        Ok(())
    }

    /// Body of `post_collateral`; the caller has already required `user` auth.
    fn post_collateral_impl(
        env: Env,
        user: Address,
        amount: i128,
    ) -> Result<(), IsolatedLendingError> {
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;
        // Checked before the transfer: an `Err` return would otherwise keep the
        // deposited tokens without crediting collateral.
        let key = PairDataKey::Collateral(user.clone());
        let old_collateral: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_collateral = old_collateral
            .checked_add(amount)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let collateral_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralToken)
            .unwrap();
        token::Client::new(&env, &collateral_token).transfer(
            &user,
            &env.current_contract_address(),
            &amount,
        );
        env.storage().persistent().set(&key, &new_collateral);
        Ok(())
    }

    /// Body of `borrow`; the caller has already required `user` auth.
    fn borrow_impl(
        env: Env,
        user: Address,
        amount: i128,
        expected_config_fingerprint: BytesN<32>,
    ) -> Result<(), IsolatedLendingError> {
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;
        Self::require_config(&env, &expected_config_fingerprint)?;
        Self::check_oracle(&env)?;
        let index = Self::accrue(&env)?;

        let collateral_factor_bps: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralFactorBps)
            .unwrap();
        let collateral: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::Collateral(user.clone()))
            .unwrap_or(0);
        let current_debt = Self::debt_at(&env, &user, index)?;

        let new_debt = current_debt
            .checked_add(amount)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let borrow_limit = collateral
            .checked_mul(collateral_factor_bps as i128)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?;

        if new_debt > borrow_limit {
            return Err(IsolatedLendingError::InsufficientCollateral);
        }

        let total_debt: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalDebt)
            .unwrap_or(0);
        if Self::spendable_liquidity(&env)? < amount {
            return Err(IsolatedLendingError::InsufficientLiquidity);
        }
        let new_total_debt = total_debt
            .checked_add(amount)
            .ok_or(IsolatedLendingError::MathOverflow)?;

        Self::store_debt(&env, &user, new_debt, index);
        env.storage()
            .instance()
            .set(&PairDataKey::TotalDebt, &new_total_debt);

        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        token::Client::new(&env, &debt_token).transfer(
            &env.current_contract_address(),
            &user,
            &amount,
        );
        Ok(())
    }

    pub fn supply(env: Env, user: Address, amount: i128) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        Self::supply_impl(env, user, amount)
    }

    pub fn withdraw(env: Env, user: Address, amount: i128) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        Self::withdraw_impl(env, user, amount)
    }

    pub fn post_collateral(
        env: Env,
        user: Address,
        amount: i128,
    ) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        Self::post_collateral_impl(env, user, amount)
    }

    /// Borrow against posted collateral.
    ///
    /// `expected_config_fingerprint` must equal `get_config_fingerprint`; a
    /// mismatch fails with `StaleConfig` before interest accrues or funds move.
    pub fn borrow(
        env: Env,
        user: Address,
        amount: i128,
        expected_config_fingerprint: BytesN<32>,
    ) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        Self::borrow_impl(env, user, amount, expected_config_fingerprint)
    }

    /// Withdraw posted collateral.
    ///
    /// `expected_config_fingerprint` must equal `get_config_fingerprint`; a
    /// mismatch fails with `StaleConfig` before interest accrues or funds move.
    pub fn withdraw_collateral(
        env: Env,
        user: Address,
        amount: i128,
        expected_config_fingerprint: BytesN<32>,
    ) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        Self::withdraw_collateral_impl(env, user, amount, expected_config_fingerprint)
    }

    /// Queue a withdrawal. Queued amounts are excluded from borrowable liquidity
    /// until the supplier calls `withdraw`.
    pub fn queue_withdrawal(
        env: Env,
        user: Address,
        amount: i128,
    ) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        Self::queue_withdrawal_impl(env, user, amount)
    }

    pub fn repay(env: Env, user: Address, amount: i128) -> Result<(), IsolatedLendingError> {
        user.require_auth();
        Self::repay_debt(&env, &user, &user, amount)
    }

    // ── Idempotent entry points (#1754) ─────────────────────────────
    //
    // Each `*_with_id` entry point applies the same operation as its plain
    // counterpart, but under a caller-chosen `operation_id`. The first
    // successful call applies the effect and stores an `OperationReceipt`
    // under `(account, operation_id)`. Re-submitting the same request with the
    // same id returns that receipt without moving tokens, accruing interest or
    // writing any state. Re-using an id for a different request fails with
    // `OperationConflict`. A call that fails does not consume its id.
    // See `docs/contracts/isolated-lending.md#operation-identity-and-safe-retries`.

    /// Idempotent `supply`. See the section comment above.
    pub fn supply_with_id(
        env: Env,
        user: Address,
        amount: i128,
        operation_id: BytesN<32>,
    ) -> Result<OperationReceipt, IsolatedLendingError> {
        user.require_auth();
        Self::run_once(
            &env,
            &user,
            &operation_id,
            symbol_short!("supply"),
            &user,
            amount,
            || Self::supply_impl(env.clone(), user.clone(), amount),
        )
    }

    /// Idempotent `withdraw`.
    pub fn withdraw_with_id(
        env: Env,
        user: Address,
        amount: i128,
        operation_id: BytesN<32>,
    ) -> Result<OperationReceipt, IsolatedLendingError> {
        user.require_auth();
        Self::run_once(
            &env,
            &user,
            &operation_id,
            symbol_short!("withdraw"),
            &user,
            amount,
            || Self::withdraw_impl(env.clone(), user.clone(), amount),
        )
    }

    /// Idempotent `post_collateral`.
    pub fn post_collateral_with_id(
        env: Env,
        user: Address,
        amount: i128,
        operation_id: BytesN<32>,
    ) -> Result<OperationReceipt, IsolatedLendingError> {
        user.require_auth();
        Self::run_once(
            &env,
            &user,
            &operation_id,
            symbol_short!("post_col"),
            &user,
            amount,
            || Self::post_collateral_impl(env.clone(), user.clone(), amount),
        )
    }

    /// Idempotent `borrow`.
    ///
    /// The configuration fingerprint is a precondition, not part of the
    /// operation's identity: a replay of an already-applied borrow returns its
    /// receipt even if the configuration changed after it was applied.
    pub fn borrow_with_id(
        env: Env,
        user: Address,
        amount: i128,
        expected_config_fingerprint: BytesN<32>,
        operation_id: BytesN<32>,
    ) -> Result<OperationReceipt, IsolatedLendingError> {
        user.require_auth();
        Self::run_once(
            &env,
            &user,
            &operation_id,
            symbol_short!("borrow"),
            &user,
            amount,
            || {
                Self::borrow_impl(
                    env.clone(),
                    user.clone(),
                    amount,
                    expected_config_fingerprint.clone(),
                )
            },
        )
    }

    /// Idempotent `withdraw_collateral`. The fingerprint is handled as in
    /// `borrow_with_id`.
    pub fn withdraw_collateral_with_id(
        env: Env,
        user: Address,
        amount: i128,
        expected_config_fingerprint: BytesN<32>,
        operation_id: BytesN<32>,
    ) -> Result<OperationReceipt, IsolatedLendingError> {
        user.require_auth();
        Self::run_once(
            &env,
            &user,
            &operation_id,
            symbol_short!("wd_col"),
            &user,
            amount,
            || {
                Self::withdraw_collateral_impl(
                    env.clone(),
                    user.clone(),
                    amount,
                    expected_config_fingerprint.clone(),
                )
            },
        )
    }

    /// Idempotent `repay`.
    pub fn repay_with_id(
        env: Env,
        user: Address,
        amount: i128,
        operation_id: BytesN<32>,
    ) -> Result<OperationReceipt, IsolatedLendingError> {
        user.require_auth();
        Self::run_once(
            &env,
            &user,
            &operation_id,
            symbol_short!("repay"),
            &user,
            amount,
            || Self::repay_debt(&env, &user, &user, amount),
        )
    }

    /// Idempotent `repay_for`. The identity is scoped to the `payer`, who
    /// authorizes and funds the repayment; the receipt records the borrower.
    pub fn repay_for_with_id(
        env: Env,
        payer: Address,
        borrower: Address,
        amount: i128,
        operation_id: BytesN<32>,
    ) -> Result<OperationReceipt, IsolatedLendingError> {
        payer.require_auth();
        Self::run_once(
            &env,
            &payer,
            &operation_id,
            symbol_short!("repay_for"),
            &borrower,
            amount,
            || Self::repay_debt(&env, &payer, &borrower, amount),
        )
    }

    /// Idempotent `queue_withdrawal`.
    pub fn queue_withdrawal_with_id(
        env: Env,
        user: Address,
        amount: i128,
        operation_id: BytesN<32>,
    ) -> Result<OperationReceipt, IsolatedLendingError> {
        user.require_auth();
        Self::run_once(
            &env,
            &user,
            &operation_id,
            symbol_short!("queue_wd"),
            &user,
            amount,
            || Self::queue_withdrawal_impl(env.clone(), user.clone(), amount),
        )
    }

    /// Receipt of the operation `account` applied under `operation_id`, or
    /// `None` if that id has not been consumed. Read-only: clients can call it
    /// to decide whether a timed-out submission landed before retrying.
    pub fn get_operation(
        env: Env,
        account: Address,
        operation_id: BytesN<32>,
    ) -> Option<OperationReceipt> {
        env.storage()
            .persistent()
            .get(&PairDataKey::Operation(account, operation_id))
    }

    /// Repay `borrower`'s debt from `payer`'s balance. Any account may repay
    /// on behalf of a borrower; only the borrower's debt and the market total
    /// change, the payer gains no claim on the position.
    pub fn repay_for(
        env: Env,
        payer: Address,
        borrower: Address,
        amount: i128,
    ) -> Result<(), IsolatedLendingError> {
        payer.require_auth();
        Self::repay_debt(&env, &payer, &borrower, amount)
    }

    /// Body of `withdraw_collateral`; the caller has already required `user` auth.
    fn withdraw_collateral_impl(
        env: Env,
        user: Address,
        amount: i128,
        expected_config_fingerprint: BytesN<32>,
    ) -> Result<(), IsolatedLendingError> {
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;
        Self::require_config(&env, &expected_config_fingerprint)?;

        let collateral_key = PairDataKey::Collateral(user.clone());
        let old_collateral: i128 = env.storage().persistent().get(&collateral_key).unwrap_or(0);
        if old_collateral < amount {
            return Err(IsolatedLendingError::InsufficientCollateral);
        }

        let index = Self::accrue(&env)?;
        let current_debt = Self::debt_at(&env, &user, index)?;
        let remaining_collateral = old_collateral - amount;
        let collateral_factor_bps: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralFactorBps)
            .unwrap();
        let borrow_limit = remaining_collateral
            .checked_mul(collateral_factor_bps as i128)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?;

        if current_debt > borrow_limit {
            return Err(IsolatedLendingError::PositionStillBacked);
        }

        env.storage()
            .persistent()
            .set(&collateral_key, &remaining_collateral);
        let collateral_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralToken)
            .unwrap();
        token::Client::new(&env, &collateral_token).transfer(
            &env.current_contract_address(),
            &user,
            &amount,
        );
        Ok(())
    }

    /// Body of `queue_withdrawal`; the caller has already required `user` auth.
    fn queue_withdrawal_impl(
        env: Env,
        user: Address,
        amount: i128,
    ) -> Result<(), IsolatedLendingError> {
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;

        let supply: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::Supply(user.clone()))
            .unwrap_or(0);
        let key = PairDataKey::PendingWithdrawal(user);
        let pending: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_pending = pending
            .checked_add(amount)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        if new_pending > supply {
            return Err(IsolatedLendingError::InsufficientLiquidity);
        }
        env.storage().persistent().set(&key, &new_pending);

        let total_pending: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::PendingWithdrawals)
            .unwrap_or(0);
        env.storage().instance().set(
            &PairDataKey::PendingWithdrawals,
            &total_pending
                .checked_add(amount)
                .ok_or(IsolatedLendingError::MathOverflow)?,
        );
        Ok(())
    }

    /// Set the share of total supply (bps) that cannot be borrowed. Admin only.
    pub fn set_reserve_bps(
        env: Env,
        admin: Address,
        reserve_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if reserve_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::ReserveBps, &reserve_bps);
        Self::publish_config_update(&env, &admin)?;
        Ok(())
    }

    /// Update the collateral factor. Admin only. Lowering it can make existing
    /// positions liquidatable.
    pub fn set_collateral_factor(
        env: Env,
        admin: Address,
        collateral_factor_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if collateral_factor_bps == 0 || collateral_factor_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::CollateralFactorBps, &collateral_factor_bps);
        Self::publish_config_update(&env, &admin)?;
        Ok(())
    }

    /// Set the collateral price in debt-token units (bps, 10_000 = par). Admin
    /// only. Used when valuing collateral for liquidation; defaults to par.
    pub fn set_collateral_price(
        env: Env,
        admin: Address,
        price_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if price_bps == 0 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::CollateralPriceBps, &price_bps);
        Self::publish_config_update(&env, &admin)?;
        Ok(())
    }

    /// Liquidate an unhealthy position. The liquidator repays up to
    /// `repay_amount` of the borrower's debt and receives collateral of equal
    /// value. `liquidation_id` identifies the liquidation: reusing it for the
    /// same borrower fails, so a retried call cannot seize collateral twice.
    /// A call that reverts (e.g. a rejected token transfer) does not consume the
    /// id. If the collateral runs out, the remaining debt is written off to bad debt.
    /// `expected_config_fingerprint` is validated before interest accrues, so a
    /// caller never liquidates on terms it did not preview. Returns the
    /// collateral seized.
    ///
    /// ## Market isolation (#1478)
    /// A pair is one market. Everything a liquidation touches belongs to that
    /// market alone: the borrower's position and the liquidation id are read
    /// from this pair's storage, the liquidator repays in this pair's debt
    /// token, and the seized collateral is paid out of this pair's own holdings
    /// of this pair's collateral token. Another market's debt, collateral,
    /// liquidity or bad debt can never be used to settle this one, even when
    /// markets share a token, because each market's balance is held by its own
    /// contract. Before paying out, the pair checks that it really holds the
    /// collateral it is about to seize, so a position that is not backed by
    /// this market's funds fails with `InsufficientCollateral` instead of
    /// reaching for anything else.
    pub fn liquidate(
        env: Env,
        liquidator: Address,
        borrower: Address,
        liquidation_id: u64,
        repay_amount: i128,
        expected_config_fingerprint: BytesN<32>,
    ) -> Result<i128, IsolatedLendingError> {
        liquidator.require_auth();
        if repay_amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(&env)?;
        Self::require_config(&env, &expected_config_fingerprint)?;
        let index = Self::accrue(&env)?;

        let liquidation_key = PairDataKey::Liquidation(borrower.clone(), liquidation_id);
        if env.storage().persistent().has(&liquidation_key) {
            return Err(IsolatedLendingError::AlreadyLiquidated);
        }

        let collateral_key = PairDataKey::Collateral(borrower.clone());
        let collateral: i128 = env.storage().persistent().get(&collateral_key).unwrap_or(0);
        let debt = Self::debt_at(&env, &borrower, index)?;
        let collateral_factor_bps: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralFactorBps)
            .unwrap();
        let price_bps = Self::collateral_price_bps(&env) as i128;

        let collateral_value = Self::collateral_value(collateral, price_bps)?;
        let borrow_limit = collateral_value
            .checked_mul(collateral_factor_bps as i128)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        if debt <= borrow_limit {
            return Err(IsolatedLendingError::PositionStillBacked);
        }

        // One liquidation may repay at most the close factor's share of the debt.
        // The share rounds up, but is capped at the debt so a rounding step can
        // never owe more than the borrower actually has.
        let close_factor_bps: i128 = env
            .storage()
            .instance()
            .get::<_, u32>(&PairDataKey::CloseFactorBps)
            .unwrap_or(10_000) as i128;
        let max_repay = debt
            .checked_mul(close_factor_bps)
            .and_then(|v| v.checked_add(BPS_DENOMINATOR - 1))
            .and_then(|v| v.checked_div(BPS_DENOMINATOR))
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let max_repay = if max_repay < debt { max_repay } else { debt };
        let mut repaid = if repay_amount < max_repay {
            repay_amount
        } else {
            max_repay
        };
        // Rounds down: the liquidator never receives more collateral value than
        // it repaid.
        let mut seized = repaid
            .checked_mul(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(price_bps)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        if seized > collateral {
            // Collateral cannot cover this repayment: take all of it and credit
            // only its value against the debt.
            seized = collateral;
            repaid = collateral_value;
        }
        if repaid <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        if repaid > debt {
            return Err(IsolatedLendingError::MathOverflow);
        }

        // Compute the resulting position and any written-off debt before tokens
        // move, so a boundary failure leaves the liquidation fully unapplied.
        let remaining_collateral = collateral
            .checked_sub(seized)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let mut remaining_debt = debt
            .checked_sub(repaid)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let mut total_debt_reduction = repaid;
        let mut new_bad_debt: Option<i128> = None;
        if remaining_collateral == 0 && remaining_debt > 0 {
            let bad_debt: i128 = env
                .storage()
                .instance()
                .get(&PairDataKey::BadDebt)
                .unwrap_or(0);
            new_bad_debt = Some(
                bad_debt
                    .checked_add(remaining_debt)
                    .ok_or(IsolatedLendingError::MathOverflow)?,
            );
            total_debt_reduction = debt;
            remaining_debt = 0;
        }

        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        let collateral_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::CollateralToken)
            .unwrap();
        // Isolation guard (#1478): only this market's own holdings can be paid out.
        if token::Client::new(&env, &collateral_token).balance(&env.current_contract_address())
            < seized
        {
            return Err(IsolatedLendingError::InsufficientCollateral);
        }

        token::Client::new(&env, &debt_token).transfer(
            &liquidator,
            &env.current_contract_address(),
            &repaid,
        );
        token::Client::new(&env, &collateral_token).transfer(
            &env.current_contract_address(),
            &liquidator,
            &seized,
        );

        if let Some(bad_debt) = new_bad_debt {
            env.storage()
                .instance()
                .set(&PairDataKey::BadDebt, &bad_debt);
        }
        env.storage()
            .persistent()
            .set(&collateral_key, &remaining_collateral);
        Self::store_debt(&env, &borrower, remaining_debt, index);
        Self::reduce_total_debt(&env, total_debt_reduction);
        env.storage().persistent().set(&liquidation_key, &true);
        Ok(seized)
    }

    /// Cap the share of a borrower's debt one liquidation may repay (bps,
    /// default 10_000 = the whole debt). Admin only.
    pub fn set_close_factor(
        env: Env,
        admin: Address,
        close_factor_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if close_factor_bps == 0 || close_factor_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::CloseFactorBps, &close_factor_bps);
        Self::publish_config_update(&env, &admin)?;
        Ok(())
    }

    /// Set the interest rate per ledger, in parts per billion of the borrow
    /// index. Interest up to this ledger accrues at the old rate. Admin only.
    pub fn set_interest_rate(
        env: Env,
        admin: Address,
        rate_per_ledger: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        Self::accrue(&env)?;
        env.storage()
            .instance()
            .set(&PairDataKey::InterestRatePerLedger, &rate_per_ledger);
        Self::publish_config_update(&env, &admin)?;
        Ok(())
    }

    /// Set the share of accrued interest (bps) owed to the protocol. Admin only.
    pub fn set_protocol_fee_bps(
        env: Env,
        admin: Address,
        fee_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if fee_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        Self::accrue(&env)?;
        env.storage()
            .instance()
            .set(&PairDataKey::ProtocolFeeBps, &fee_bps);
        Self::publish_config_update(&env, &admin)?;
        Ok(())
    }

    /// Pay accrued protocol fees to `to`, limited by the pair's token balance.
    /// Admin only. Returns the amount paid.
    pub fn claim_protocol_fees(
        env: Env,
        admin: Address,
        to: Address,
    ) -> Result<i128, IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        Self::accrue(&env)?;
        let fees: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::ProtocolFees)
            .unwrap_or(0);
        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        let token_client = token::Client::new(&env, &debt_token);
        let cash = token_client.balance(&env.current_contract_address());
        let paid = if fees < cash { fees } else { cash };
        if paid > 0 {
            env.storage()
                .instance()
                .set(&PairDataKey::ProtocolFees, &(fees - paid));
            token_client.transfer(&env.current_contract_address(), &to, &paid);
        }
        Ok(paid)
    }

    /// Configure the oracle allowed to push quotes. Admin only.
    pub fn set_oracle(
        env: Env,
        admin: Address,
        oracle: Address,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&PairDataKey::Oracle, &oracle);
        Self::publish_config_update(&env, &admin)?;
        Ok(())
    }

    /// Require borrows to be backed by an oracle quote with at least
    /// `min_confidence_bps` confidence that is at most `max_age_ledgers` old.
    /// Admin only. Until set, borrowing does not consult the oracle.
    pub fn set_oracle_policy(
        env: Env,
        admin: Address,
        min_confidence_bps: u32,
        max_age_ledgers: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_admin(&env, &admin)?;
        if min_confidence_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage().instance().set(
            &PairDataKey::OraclePolicy,
            &OraclePolicyConfig {
                min_confidence_bps,
                max_age_ledgers,
            },
        );
        Self::publish_config_update(&env, &admin)?;
        Ok(())
    }

    /// Record a quote observed at the current ledger. Only the configured oracle may call.
    pub fn push_oracle_quote(
        env: Env,
        oracle: Address,
        price_bps: u32,
        confidence_bps: u32,
    ) -> Result<(), IsolatedLendingError> {
        Self::require_init(&env)?;
        oracle.require_auth();
        let configured: Option<Address> = env.storage().instance().get(&PairDataKey::Oracle);
        if configured != Some(oracle) {
            return Err(IsolatedLendingError::Unauthorized);
        }
        if price_bps == 0 || confidence_bps > 10_000 {
            return Err(IsolatedLendingError::InvalidConfig);
        }
        env.storage().instance().set(
            &PairDataKey::OracleQuote,
            &OracleQuoteData {
                price_bps,
                confidence_bps,
                ledger: env.ledger().sequence(),
            },
        );
        Ok(())
    }

    /// Protocol fees accrued up to the current ledger and not yet claimed.
    pub fn get_protocol_fees(env: Env) -> Result<i128, IsolatedLendingError> {
        Self::require_init(&env)?;
        let (_, _, interest) = Self::pending_interest(&env)?;
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::ProtocolFeeBps)
            .unwrap_or(0);
        let fees: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::ProtocolFees)
            .unwrap_or(0);
        interest
            .checked_mul(fee_bps as i128)
            .and_then(|v| v.checked_div(BPS_DENOMINATOR))
            .and_then(|v| v.checked_add(fees))
            .ok_or(IsolatedLendingError::MathOverflow)
    }

    /// Liquidity available to borrow: supply minus debt, queued withdrawals
    /// and the reserve requirement.
    pub fn get_available_liquidity(env: Env) -> Result<i128, IsolatedLendingError> {
        Self::spendable_liquidity(&env)
    }

    /// Debt written off after liquidations left it uncovered by collateral.
    pub fn get_bad_debt(env: Env) -> Result<i128, IsolatedLendingError> {
        Self::require_init(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&PairDataKey::BadDebt)
            .unwrap_or(0))
    }

    /// Returns `(collateral, debt)` for a borrower.
    pub fn get_position(env: Env, user: Address) -> Result<(i128, i128), IsolatedLendingError> {
        Self::require_init(&env)?;
        let (_, index, _) = Self::pending_interest(&env)?;
        Ok((
            env.storage()
                .persistent()
                .get(&PairDataKey::Collateral(user.clone()))
                .unwrap_or(0),
            Self::debt_at(&env, &user, index)?,
        ))
    }

    /// Health-factor components of `user`'s position for client previews.
    /// Under an oracle policy, fails with the error `borrow` would raise when
    /// the quote is missing, stale or below the required confidence.
    pub fn get_health_factor(
        env: Env,
        user: Address,
    ) -> Result<HealthFactor, IsolatedLendingError> {
        Self::require_init(&env)?;
        Self::check_oracle(&env)?;
        let (_, index, _) = Self::pending_interest(&env)?;
        let collateral: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::Collateral(user.clone()))
            .unwrap_or(0);
        Ok(HealthFactor {
            debt_value: Self::debt_at(&env, &user, index)?,
            collateral_value: Self::collateral_value(
                collateral,
                Self::collateral_price_bps(&env) as i128,
            )?,
            threshold_bps: env
                .storage()
                .instance()
                .get(&PairDataKey::CollateralFactorBps)
                .unwrap(),
            ledger: env.ledger().sequence(),
            config_fingerprint: Self::config_fingerprint(&env)?,
        })
    }

    /// Current admin-controlled configuration of this market.
    pub fn get_config_snapshot(env: Env) -> Result<ConfigSnapshot, IsolatedLendingError> {
        Self::require_init(&env)?;
        Ok(Self::config_snapshot(&env))
    }

    /// SHA-256 fingerprint of `get_config_snapshot`.
    ///
    /// Clients capture this before previewing an operation and pass it to
    /// `borrow`, `withdraw_collateral` or `liquidate`. If any configuration
    /// changes in between, the fingerprint no longer matches and the operation
    /// fails with `StaleConfig` before accruing interest or moving funds, so
    /// the caller can refresh and retry under terms it has actually seen.
    pub fn get_config_fingerprint(env: Env) -> Result<BytesN<32>, IsolatedLendingError> {
        Self::require_init(&env)?;
        Self::config_fingerprint(&env)
    }

    pub fn get_totals(env: Env) -> Result<(i128, i128), IsolatedLendingError> {
        Self::require_init(&env)?;
        Ok((
            env.storage()
                .instance()
                .get(&PairDataKey::TotalSupplied)
                .unwrap_or(0),
            Self::total_debt_now(&env)?,
        ))
    }

    fn require_admin(env: &Env, admin: &Address) -> Result<(), IsolatedLendingError> {
        Self::require_init(env)?;
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&PairDataKey::Admin).unwrap();
        if *admin != stored {
            return Err(IsolatedLendingError::Unauthorized);
        }
        Ok(())
    }

    fn collateral_price_bps(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&PairDataKey::CollateralPriceBps)
            .unwrap_or(10_000)
    }

    /// Read the configuration that execution depends on, applying the same
    /// defaults the execution paths use.
    fn config_snapshot(env: &Env) -> ConfigSnapshot {
        let policy: Option<OraclePolicyConfig> =
            env.storage().instance().get(&PairDataKey::OraclePolicy);
        ConfigSnapshot {
            collateral_factor_bps: env
                .storage()
                .instance()
                .get(&PairDataKey::CollateralFactorBps)
                .unwrap_or(0),
            reserve_bps: env
                .storage()
                .instance()
                .get(&PairDataKey::ReserveBps)
                .unwrap_or(0),
            close_factor_bps: env
                .storage()
                .instance()
                .get(&PairDataKey::CloseFactorBps)
                .unwrap_or(10_000),
            collateral_price_bps: Self::collateral_price_bps(env),
            interest_rate_per_ledger: env
                .storage()
                .instance()
                .get(&PairDataKey::InterestRatePerLedger)
                .unwrap_or(0),
            protocol_fee_bps: env
                .storage()
                .instance()
                .get(&PairDataKey::ProtocolFeeBps)
                .unwrap_or(0),
            oracle: env.storage().instance().get(&PairDataKey::Oracle),
            oracle_policy_configured: policy.is_some(),
            oracle_min_confidence_bps: policy.as_ref().map(|p| p.min_confidence_bps).unwrap_or(0),
            oracle_max_age_ledgers: policy.as_ref().map(|p| p.max_age_ledgers).unwrap_or(0),
        }
    }

    /// Deterministic SHA-256 fingerprint of the current configuration.
    fn config_fingerprint(env: &Env) -> Result<BytesN<32>, IsolatedLendingError> {
        let mut preimage = Bytes::from_slice(env, CONFIG_FINGERPRINT_DOMAIN);
        preimage.append(&Self::config_snapshot(env).to_xdr(env));
        Ok(env.crypto().sha256(&preimage).to_bytes())
    }

    /// Reject an operation whose caller observed a different configuration.
    fn require_config(env: &Env, expected: &BytesN<32>) -> Result<(), IsolatedLendingError> {
        if Self::config_fingerprint(env)? != *expected {
            return Err(IsolatedLendingError::StaleConfig);
        }
        Ok(())
    }

    /// Announce the new configuration fingerprint after an admin change.
    fn publish_config_update(env: &Env, admin: &Address) -> Result<(), IsolatedLendingError> {
        env.events().publish(
            (symbol_short!("config"),),
            (admin.clone(), Self::config_fingerprint(env)?),
        );
        Ok(())
    }

    /// `collateral` valued in debt-token units at `price_bps`.
    fn collateral_value(collateral: i128, price_bps: i128) -> Result<i128, IsolatedLendingError> {
        collateral
            .checked_mul(price_bps)
            .and_then(|v| v.checked_div(BPS_DENOMINATOR))
            .ok_or(IsolatedLendingError::MathOverflow)
    }

    fn spendable_liquidity(env: &Env) -> Result<i128, IsolatedLendingError> {
        Self::require_init(env)?;
        let total_supplied: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalSupplied)
            .unwrap_or(0);
        let total_debt = Self::total_debt_now(env)?;
        let pending: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::PendingWithdrawals)
            .unwrap_or(0);
        let reserve_bps: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::ReserveBps)
            .unwrap_or(0);
        let reserve = total_supplied
            .checked_mul(reserve_bps as i128)
            .ok_or(IsolatedLendingError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let available = total_supplied
            .checked_sub(total_debt)
            .and_then(|v| v.checked_sub(pending))
            .and_then(|v| v.checked_sub(reserve))
            .ok_or(IsolatedLendingError::MathOverflow)?;
        Ok(if available < 0 { 0 } else { available })
    }

    fn consume_pending_withdrawal(env: &Env, user: &Address, amount: i128) {
        let key = PairDataKey::PendingWithdrawal(user.clone());
        let pending: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if pending == 0 {
            return;
        }
        let consumed = if pending < amount { pending } else { amount };
        env.storage().persistent().set(&key, &(pending - consumed));
        let total: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::PendingWithdrawals)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&PairDataKey::PendingWithdrawals, &(total - consumed));
    }

    fn repay_debt(
        env: &Env,
        payer: &Address,
        borrower: &Address,
        amount: i128,
    ) -> Result<(), IsolatedLendingError> {
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(env)?;
        let index = Self::accrue(env)?;

        let old_debt = Self::debt_at(env, borrower, index)?;
        if old_debt < amount {
            return Err(IsolatedLendingError::InvalidAmount);
        }

        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        token::Client::new(env, &debt_token).transfer(
            payer,
            &env.current_contract_address(),
            &amount,
        );

        Self::store_debt(env, borrower, old_debt - amount, index);
        Self::reduce_total_debt(env, amount);
        Ok(())
    }

    /// Interest accrued since the last touch, as `(old_index, new_index, interest)`.
    /// Simple interest on the index for the elapsed ledgers; nothing accrues
    /// within the same ledger, so repeated touches are idempotent.
    fn pending_interest(env: &Env) -> Result<(i128, i128, i128), IsolatedLendingError> {
        let now = env.ledger().sequence();
        let index: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::BorrowIndex)
            .unwrap_or(INDEX_SCALE);
        let last: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::LastAccrualLedger)
            .unwrap_or(now);
        let rate: u32 = env
            .storage()
            .instance()
            .get(&PairDataKey::InterestRatePerLedger)
            .unwrap_or(0);
        let elapsed = now.saturating_sub(last) as i128;
        let growth = index
            .checked_mul(rate as i128)
            .and_then(|v| v.checked_mul(elapsed))
            .and_then(|v| v.checked_div(RATE_SCALE))
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let new_index = index
            .checked_add(growth)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let total_debt: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalDebt)
            .unwrap_or(0);
        let index_growth = new_index
            .checked_sub(index)
            .ok_or(IsolatedLendingError::MathOverflow)?;
        let interest = total_debt
            .checked_mul(index_growth)
            .and_then(|v| v.checked_div(index))
            .ok_or(IsolatedLendingError::MathOverflow)?;
        Ok((index, new_index, interest))
    }

    /// Apply pending interest to the market totals and protocol fees, and
    /// return the current borrow index.
    fn accrue(env: &Env) -> Result<i128, IsolatedLendingError> {
        let (index, new_index, interest) = Self::pending_interest(env)?;
        if new_index != index {
            // Compute all checked values before persisting any of them. A
            // partial accrual followed by `Err` would inflate totals without
            // moving the index, and the next touch would double-count interest.
            let total_debt: i128 = env
                .storage()
                .instance()
                .get(&PairDataKey::TotalDebt)
                .unwrap_or(0);
            let new_total_debt = total_debt
                .checked_add(interest)
                .ok_or(IsolatedLendingError::MathOverflow)?;
            let fee_bps: u32 = env
                .storage()
                .instance()
                .get(&PairDataKey::ProtocolFeeBps)
                .unwrap_or(0);
            let fee = interest
                .checked_mul(fee_bps as i128)
                .and_then(|v| v.checked_div(BPS_DENOMINATOR))
                .ok_or(IsolatedLendingError::MathOverflow)?;
            let fees: i128 = env
                .storage()
                .instance()
                .get(&PairDataKey::ProtocolFees)
                .unwrap_or(0);
            let new_fees = fees
                .checked_add(fee)
                .ok_or(IsolatedLendingError::MathOverflow)?;

            env.storage()
                .instance()
                .set(&PairDataKey::TotalDebt, &new_total_debt);
            env.storage()
                .instance()
                .set(&PairDataKey::ProtocolFees, &new_fees);
            env.storage()
                .instance()
                .set(&PairDataKey::BorrowIndex, &new_index);
        }
        env.storage()
            .instance()
            .set(&PairDataKey::LastAccrualLedger, &env.ledger().sequence());
        Ok(new_index)
    }

    fn total_debt_now(env: &Env) -> Result<i128, IsolatedLendingError> {
        let (_, _, interest) = Self::pending_interest(env)?;
        let total_debt: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalDebt)
            .unwrap_or(0);
        total_debt
            .checked_add(interest)
            .ok_or(IsolatedLendingError::MathOverflow)
    }

    /// A borrower's debt grown to `index`.
    fn debt_at(env: &Env, user: &Address, index: i128) -> Result<i128, IsolatedLendingError> {
        let debt: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::Debt(user.clone()))
            .unwrap_or(0);
        if debt == 0 {
            return Ok(0);
        }
        let snapshot: i128 = env
            .storage()
            .persistent()
            .get(&PairDataKey::DebtIndex(user.clone()))
            .unwrap_or(INDEX_SCALE);
        debt.checked_mul(index)
            .and_then(|v| v.checked_div(snapshot))
            .ok_or(IsolatedLendingError::MathOverflow)
    }

    fn store_debt(env: &Env, user: &Address, debt: i128, index: i128) {
        env.storage()
            .persistent()
            .set(&PairDataKey::Debt(user.clone()), &debt);
        env.storage()
            .persistent()
            .set(&PairDataKey::DebtIndex(user.clone()), &index);
    }

    /// Per-borrower rounding can leave the total a few units below the sum of
    /// debts, so the total floors at zero instead of reverting.
    fn reduce_total_debt(env: &Env, amount: i128) {
        let total_debt: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::TotalDebt)
            .unwrap_or(0);
        let remaining = if total_debt > amount {
            total_debt - amount
        } else {
            0
        };
        env.storage()
            .instance()
            .set(&PairDataKey::TotalDebt, &remaining);
    }

    /// Debt-token balance held by the pair, less fees owed to the protocol.
    fn redeemable_cash(env: &Env) -> Result<i128, IsolatedLendingError> {
        let debt_token: Address = env
            .storage()
            .instance()
            .get(&PairDataKey::DebtToken)
            .unwrap();
        let cash = token::Client::new(env, &debt_token).balance(&env.current_contract_address());
        let fees: i128 = env
            .storage()
            .instance()
            .get(&PairDataKey::ProtocolFees)
            .unwrap_or(0);
        cash.checked_sub(fees)
            .ok_or(IsolatedLendingError::MathOverflow)
    }

    /// Borrowing is allowed only against a fresh, confident oracle quote when
    /// an oracle policy is configured.
    fn check_oracle(env: &Env) -> Result<(), IsolatedLendingError> {
        let policy: Option<OraclePolicyConfig> =
            env.storage().instance().get(&PairDataKey::OraclePolicy);
        let Some(policy) = policy else {
            return Ok(());
        };
        let quote: OracleQuoteData = env
            .storage()
            .instance()
            .get(&PairDataKey::OracleQuote)
            .ok_or(IsolatedLendingError::OracleQuoteMissing)?;
        if env.ledger().sequence().saturating_sub(quote.ledger) > policy.max_age_ledgers {
            return Err(IsolatedLendingError::OracleQuoteStale);
        }
        if quote.confidence_bps < policy.min_confidence_bps {
            return Err(IsolatedLendingError::OracleConfidenceTooLow);
        }
        Ok(())
    }

    /// Apply `apply` at most once per `(account, operation_id)`.
    ///
    /// Order matters for atomicity:
    /// 1. validate the amount and the id, and require initialization;
    /// 2. if a receipt exists, return it when it describes the same request
    ///    (no transfer, accrual or write), otherwise fail with
    ///    `OperationConflict`;
    /// 3. run the operation, which validates everything before moving tokens
    ///    or writing state and returns `Err` without side effects;
    /// 4. only after it succeeded, persist the receipt and emit `("op",)`.
    ///
    /// The receipt is therefore never written for an operation whose effect
    /// was not applied, and a failed call leaves the id unconsumed. Soroban
    /// also reverts every storage write and transfer of an invocation that
    /// returns an error, so step 4 can never survive a failure of step 3.
    #[allow(clippy::too_many_arguments)]
    fn run_once<F>(
        env: &Env,
        account: &Address,
        operation_id: &BytesN<32>,
        kind: Symbol,
        beneficiary: &Address,
        amount: i128,
        apply: F,
    ) -> Result<OperationReceipt, IsolatedLendingError>
    where
        F: FnOnce() -> Result<(), IsolatedLendingError>,
    {
        if amount <= 0 {
            return Err(IsolatedLendingError::InvalidAmount);
        }
        Self::require_init(env)?;
        if operation_id.to_array() == [0u8; 32] {
            return Err(IsolatedLendingError::InvalidOperationId);
        }

        let key = PairDataKey::Operation(account.clone(), operation_id.clone());
        if let Some(receipt) = env.storage().persistent().get::<_, OperationReceipt>(&key) {
            if receipt.kind == kind
                && receipt.beneficiary == *beneficiary
                && receipt.amount == amount
            {
                env.events().publish(
                    (symbol_short!("op_replay"),),
                    (account.clone(), kind, operation_id.clone()),
                );
                return Ok(receipt);
            }
            return Err(IsolatedLendingError::OperationConflict);
        }

        apply()?;

        let receipt = OperationReceipt {
            operation_id: operation_id.clone(),
            kind: kind.clone(),
            account: account.clone(),
            beneficiary: beneficiary.clone(),
            amount,
            ledger: env.ledger().sequence(),
        };
        env.storage().persistent().set(&key, &receipt);
        env.storage().persistent().extend_ttl(
            &key,
            OPERATION_TTL_THRESHOLD,
            OPERATION_TTL_EXTEND_TO,
        );
        env.events().publish(
            (symbol_short!("op"),),
            (
                account.clone(),
                kind,
                operation_id.clone(),
                beneficiary.clone(),
                amount,
            ),
        );
        Ok(receipt)
    }

    fn require_init(env: &Env) -> Result<(), IsolatedLendingError> {
        if !env.storage().instance().has(&PairDataKey::Initialized) {
            return Err(IsolatedLendingError::NotInitialized);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{storage::Persistent as _, Address as _, Ledger as _};
    use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};

    struct Setup {
        env: Env,
        admin: Address,
        pair: IsolatedLendingPairClient<'static>,
        collateral_token: Address,
        debt_token: Address,
        lender: Address,
        borrower: Address,
    }

    impl Setup {
        /// Fingerprint a client would have captured before previewing an
        /// operation on this market, right now.
        fn fp(&self) -> BytesN<32> {
            self.pair.get_config_fingerprint()
        }
    }

    fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
        StellarAssetClient::new(env, token).mint(to, &amount);
    }

    fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
        TokenClient::new(env, token).balance(who)
    }

    /// Pair with 80% collateral factor; the lender supplied 1_000, the borrower
    /// posted 100 collateral and borrowed 80.
    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let collateral_token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let debt_token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let pair_id = env.register(IsolatedLendingPair, ());
        let pair = IsolatedLendingPairClient::new(&env, &pair_id);
        pair.initialize(&admin, &collateral_token, &debt_token, &8_000);

        let lender = Address::generate(&env);
        let borrower = Address::generate(&env);
        mint(&env, &debt_token, &lender, 1_000);
        mint(&env, &collateral_token, &borrower, 100);
        pair.supply(&lender, &1_000);
        pair.post_collateral(&borrower, &100);
        pair.borrow(&borrower, &80, &pair.get_config_fingerprint());

        Setup {
            env,
            admin,
            pair,
            collateral_token,
            debt_token,
            lender,
            borrower,
        }
    }

    // ── Repay on behalf ─────────────────────────────────────────────

    #[test]
    fn third_party_partial_repay_only_changes_borrower_debt() {
        let s = setup();
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 30);
        let borrower_balance = balance(&s.env, &s.debt_token, &s.borrower);

        s.pair.repay_for(&payer, &s.borrower, &30);

        assert_eq!(s.pair.get_position(&s.borrower), (100, 50));
        assert_eq!(s.pair.get_totals(), (1_000, 50));
        assert_eq!(balance(&s.env, &s.debt_token, &payer), 0);
        assert_eq!(
            balance(&s.env, &s.debt_token, &s.borrower),
            borrower_balance
        );
        assert_eq!(s.pair.get_position(&payer), (0, 0));
    }

    #[test]
    fn third_party_full_repay_clears_debt() {
        let s = setup();
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 80);

        s.pair.repay_for(&payer, &s.borrower, &80);

        assert_eq!(s.pair.get_position(&s.borrower), (100, 0));
        assert_eq!(s.pair.get_totals(), (1_000, 0));
    }

    #[test]
    fn third_party_repay_above_debt_is_rejected() {
        let s = setup();
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 100);

        let res = s.pair.try_repay_for(&payer, &s.borrower, &81);
        assert_eq!(res, Err(Ok(IsolatedLendingError::InvalidAmount)));
        assert_eq!(s.pair.get_position(&s.borrower), (100, 80));
    }

    // ── Borrow liquidity ────────────────────────────────────────────

    #[test]
    fn borrow_at_the_liquidity_limit_succeeds() {
        let s = setup();
        // 1_000 supplied, 80 borrowed -> 920 available.
        assert_eq!(s.pair.get_available_liquidity(), 920);
        mint(&s.env, &s.collateral_token, &s.borrower, 2_000);
        s.pair.post_collateral(&s.borrower, &2_000);

        s.pair.borrow(&s.borrower, &920, &s.fp());

        assert_eq!(s.pair.get_available_liquidity(), 0);
        let res = s.pair.try_borrow(&s.borrower, &1, &s.fp());
        assert_eq!(res, Err(Ok(IsolatedLendingError::InsufficientLiquidity)));
    }

    #[test]
    fn queued_withdrawals_reduce_borrowable_liquidity() {
        let s = setup();
        mint(&s.env, &s.collateral_token, &s.borrower, 2_000);
        s.pair.post_collateral(&s.borrower, &2_000);

        s.pair.queue_withdrawal(&s.lender, &900);
        assert_eq!(s.pair.get_available_liquidity(), 20);

        let res = s.pair.try_borrow(&s.borrower, &21, &s.fp());
        assert_eq!(res, Err(Ok(IsolatedLendingError::InsufficientLiquidity)));
        s.pair.borrow(&s.borrower, &20, &s.fp());
    }

    #[test]
    fn withdrawing_clears_the_queued_amount() {
        let s = setup();
        s.pair.queue_withdrawal(&s.lender, &500);
        assert_eq!(s.pair.get_available_liquidity(), 420);

        s.pair.withdraw(&s.lender, &500);

        // 500 supplied, 80 borrowed, nothing queued.
        assert_eq!(s.pair.get_available_liquidity(), 420);
    }

    #[test]
    fn queued_withdrawal_cannot_exceed_supply() {
        let s = setup();
        let res = s.pair.try_queue_withdrawal(&s.lender, &1_001);
        assert_eq!(res, Err(Ok(IsolatedLendingError::InsufficientLiquidity)));
    }

    #[test]
    fn reserve_requirement_reduces_borrowable_liquidity() {
        let s = setup();
        s.pair.set_reserve_bps(&s.admin, &1_000);
        // 1_000 - 80 debt - 100 reserve.
        assert_eq!(s.pair.get_available_liquidity(), 820);

        let outsider = Address::generate(&s.env);
        let res = s.pair.try_set_reserve_bps(&outsider, &500);
        assert_eq!(res, Err(Ok(IsolatedLendingError::Unauthorized)));
    }

    // ── Liquidation ─────────────────────────────────────────────────

    #[test]
    fn healthy_position_cannot_be_liquidated() {
        let s = setup();
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        let res = s
            .pair
            .try_liquidate(&liquidator, &s.borrower, &1, &80, &s.fp());
        assert_eq!(res, Err(Ok(IsolatedLendingError::PositionStillBacked)));
    }

    #[test]
    fn fully_covered_liquidation_records_no_bad_debt() {
        let s = setup();
        s.pair.set_collateral_factor(&s.admin, &4_000);
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        let seized = s.pair.liquidate(&liquidator, &s.borrower, &1, &80, &s.fp());

        assert_eq!(seized, 80);
        assert_eq!(s.pair.get_position(&s.borrower), (20, 0));
        assert_eq!(s.pair.get_totals(), (1_000, 0));
        assert_eq!(s.pair.get_bad_debt(), 0);
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 80);
        assert_eq!(balance(&s.env, &s.debt_token, &liquidator), 0);
    }

    #[test]
    fn repeated_liquidation_id_cannot_seize_twice() {
        let s = setup();
        s.pair.set_collateral_factor(&s.admin, &4_000);
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        s.pair.liquidate(&liquidator, &s.borrower, &7, &40, &s.fp());
        let after_first = s.pair.get_position(&s.borrower);
        let res = s
            .pair
            .try_liquidate(&liquidator, &s.borrower, &7, &40, &s.fp());

        assert_eq!(res, Err(Ok(IsolatedLendingError::AlreadyLiquidated)));
        assert_eq!(s.pair.get_position(&s.borrower), after_first);
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 40);
    }

    #[test]
    fn rejected_settlement_does_not_consume_the_liquidation_id() {
        let s = setup();
        s.pair.set_collateral_factor(&s.admin, &4_000);
        let liquidator = Address::generate(&s.env);

        // No debt tokens yet, so the repayment transfer is rejected.
        assert!(s
            .pair
            .try_liquidate(&liquidator, &s.borrower, &3, &40, &s.fp())
            .is_err());
        assert_eq!(s.pair.get_position(&s.borrower), (100, 80));

        mint(&s.env, &s.debt_token, &liquidator, 40);
        assert_eq!(
            s.pair.liquidate(&liquidator, &s.borrower, &3, &40, &s.fp()),
            40
        );
        assert_eq!(s.pair.get_position(&s.borrower), (60, 40));
    }

    #[test]
    fn undercollateralized_liquidation_records_bad_debt() {
        let s = setup();
        // Collateral worth 50 against 80 of debt.
        s.pair.set_collateral_price(&s.admin, &5_000);
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        let seized = s.pair.liquidate(&liquidator, &s.borrower, &1, &80, &s.fp());

        assert_eq!(seized, 100);
        assert_eq!(s.pair.get_position(&s.borrower), (0, 0));
        // The liquidator paid the collateral's value; the other 30 is bad debt.
        assert_eq!(balance(&s.env, &s.debt_token, &liquidator), 30);
        assert_eq!(s.pair.get_bad_debt(), 30);
        assert_eq!(s.pair.get_totals(), (1_000, 0));
        assert_eq!(balance(&s.env, &s.debt_token, &s.lender), 0);
    }

    fn set_ledger(env: &Env, sequence: u32) {
        env.ledger().with_mut(|l| l.sequence_number = sequence);
    }

    /// 12.5% per ledger: the setup's 80 of debt grows by 10 each ledger.
    const RATE: u32 = 125_000_000;

    // ── Liquidation close factor ────────────────────────────────────

    fn unhealthy_with_close_factor(s: &Setup) -> Address {
        s.pair.set_collateral_factor(&s.admin, &4_000);
        s.pair.set_close_factor(&s.admin, &5_000);
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);
        liquidator
    }

    #[test]
    fn liquidation_below_the_close_factor_repays_what_was_asked() {
        let s = setup();
        let liquidator = unhealthy_with_close_factor(&s);

        assert_eq!(
            s.pair.liquidate(&liquidator, &s.borrower, &1, &20, &s.fp()),
            20
        );
        assert_eq!(s.pair.get_position(&s.borrower), (80, 60));
    }

    #[test]
    fn liquidation_at_the_close_factor_is_allowed() {
        let s = setup();
        let liquidator = unhealthy_with_close_factor(&s);

        assert_eq!(
            s.pair.liquidate(&liquidator, &s.borrower, &1, &40, &s.fp()),
            40
        );
        assert_eq!(s.pair.get_position(&s.borrower), (60, 40));
    }

    #[test]
    fn liquidation_above_the_close_factor_is_capped() {
        let s = setup();
        let liquidator = unhealthy_with_close_factor(&s);

        // Asked for 80 of 80, but only half the debt may be repaid at once.
        assert_eq!(
            s.pair.liquidate(&liquidator, &s.borrower, &1, &80, &s.fp()),
            40
        );
        assert_eq!(s.pair.get_position(&s.borrower), (60, 40));
        assert_eq!(balance(&s.env, &s.debt_token, &liquidator), 40);
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 40);
    }

    #[test]
    fn close_factor_must_be_a_valid_share_set_by_the_admin() {
        let s = setup();
        assert_eq!(
            s.pair.try_set_close_factor(&s.admin, &0),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );
        assert_eq!(
            s.pair.try_set_close_factor(&s.admin, &10_001),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );
        let outsider = Address::generate(&s.env);
        assert_eq!(
            s.pair.try_set_close_factor(&outsider, &5_000),
            Err(Ok(IsolatedLendingError::Unauthorized))
        );
    }

    // ── Interest accrual ────────────────────────────────────────────

    #[test]
    fn interest_does_not_accrue_within_the_same_ledger() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);

        assert_eq!(s.pair.get_position(&s.borrower), (100, 80));
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 1);
        s.pair.repay_for(&payer, &s.borrower, &1);
        assert_eq!(s.pair.get_position(&s.borrower), (100, 79));
        assert_eq!(s.pair.get_totals(), (1_000, 79));
    }

    #[test]
    fn interest_accrues_for_one_ledger() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);

        set_ledger(&s.env, 1);

        assert_eq!(s.pair.get_position(&s.borrower), (100, 90));
        assert_eq!(s.pair.get_totals(), (1_000, 90));
    }

    #[test]
    fn interest_accrues_over_a_long_gap_in_one_step() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);

        set_ledger(&s.env, 100);

        // 80 + 80 * 12.5% * 100 ledgers.
        assert_eq!(s.pair.get_position(&s.borrower), (100, 1_080));
        assert_eq!(s.pair.get_totals(), (1_000, 1_080));
    }

    #[test]
    fn touching_a_position_twice_in_a_ledger_accrues_once() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 20);

        set_ledger(&s.env, 1);
        s.pair.repay_for(&payer, &s.borrower, &10);
        s.pair.repay_for(&payer, &s.borrower, &10);

        // 80 + 10 interest - 20 repaid.
        assert_eq!(s.pair.get_position(&s.borrower), (100, 70));
        assert_eq!(s.pair.get_totals(), (1_000, 70));
    }

    #[test]
    fn rate_change_settles_interest_at_the_old_rate() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);

        set_ledger(&s.env, 1);
        s.pair.set_interest_rate(&s.admin, &0);
        set_ledger(&s.env, 50);

        assert_eq!(s.pair.get_position(&s.borrower), (100, 90));
    }

    // ── Protocol fees ───────────────────────────────────────────────

    #[test]
    fn protocol_fees_are_a_share_of_accrued_interest() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        s.pair.set_protocol_fee_bps(&s.admin, &5_000);

        set_ledger(&s.env, 1);

        // 10 of interest, half owed to the protocol.
        assert_eq!(s.pair.get_protocol_fees(), 5);
    }

    #[test]
    fn suppliers_cannot_withdraw_funds_owed_to_the_protocol() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        s.pair.set_protocol_fee_bps(&s.admin, &5_000);
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 10);

        set_ledger(&s.env, 1);
        s.pair.repay_for(&payer, &s.borrower, &10);

        // 920 + 10 repaid = 930 in the pair, 5 of it owed to the protocol.
        assert_eq!(
            s.pair.try_withdraw(&s.lender, &926),
            Err(Ok(IsolatedLendingError::InsufficientLiquidity))
        );
        s.pair.withdraw(&s.lender, &925);

        let treasury = Address::generate(&s.env);
        assert_eq!(s.pair.claim_protocol_fees(&s.admin, &treasury), 5);
        assert_eq!(balance(&s.env, &s.debt_token, &treasury), 5);
        assert_eq!(s.pair.get_protocol_fees(), 0);
    }

    #[test]
    fn full_redemption_after_interest_leaves_the_protocol_fees() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        s.pair.set_protocol_fee_bps(&s.admin, &5_000);
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 90);

        set_ledger(&s.env, 1);
        s.pair.repay_for(&payer, &s.borrower, &90);
        assert_eq!(s.pair.get_position(&s.borrower), (100, 0));

        // The lender redeems the whole deposit; the interest stays in the pair.
        s.pair.withdraw(&s.lender, &1_000);
        assert_eq!(balance(&s.env, &s.debt_token, &s.lender), 1_000);

        let treasury = Address::generate(&s.env);
        assert_eq!(s.pair.claim_protocol_fees(&s.admin, &treasury), 5);
        assert_eq!(balance(&s.env, &s.debt_token, &treasury), 5);
    }

    #[test]
    fn protocol_fee_share_must_be_valid_and_set_by_the_admin() {
        let s = setup();
        assert_eq!(
            s.pair.try_set_protocol_fee_bps(&s.admin, &10_001),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );
        let outsider = Address::generate(&s.env);
        assert_eq!(
            s.pair.try_claim_protocol_fees(&outsider, &outsider),
            Err(Ok(IsolatedLendingError::Unauthorized))
        );
    }

    // ── Oracle policy ───────────────────────────────────────────────

    /// Gives the borrower enough collateral to borrow 10 more and applies a
    /// policy of at least 80% confidence on quotes no older than 10 ledgers.
    fn with_oracle_policy(s: &Setup) -> Address {
        mint(&s.env, &s.collateral_token, &s.borrower, 100);
        s.pair.post_collateral(&s.borrower, &100);
        let oracle = Address::generate(&s.env);
        s.pair.set_oracle(&s.admin, &oracle);
        s.pair.set_oracle_policy(&s.admin, &8_000, &10);
        oracle
    }

    #[test]
    fn borrow_with_a_fresh_confident_quote_is_accepted() {
        let s = setup();
        let oracle = with_oracle_policy(&s);

        s.pair.push_oracle_quote(&oracle, &10_000, &9_000);
        set_ledger(&s.env, 10);

        s.pair.borrow(&s.borrower, &10, &s.fp());
        assert_eq!(s.pair.get_position(&s.borrower), (200, 90));
    }

    #[test]
    fn borrow_with_a_low_confidence_quote_is_rejected() {
        let s = setup();
        let oracle = with_oracle_policy(&s);

        s.pair.push_oracle_quote(&oracle, &10_000, &7_999);

        assert_eq!(
            s.pair.try_borrow(&s.borrower, &10, &s.fp()),
            Err(Ok(IsolatedLendingError::OracleConfidenceTooLow))
        );
    }

    #[test]
    fn borrow_with_a_stale_quote_is_rejected() {
        let s = setup();
        let oracle = with_oracle_policy(&s);

        s.pair.push_oracle_quote(&oracle, &10_000, &9_000);
        set_ledger(&s.env, 11);

        assert_eq!(
            s.pair.try_borrow(&s.borrower, &10, &s.fp()),
            Err(Ok(IsolatedLendingError::OracleQuoteStale))
        );
    }

    #[test]
    fn borrow_without_a_quote_is_rejected_once_a_policy_is_set() {
        let s = setup();
        with_oracle_policy(&s);

        assert_eq!(
            s.pair.try_borrow(&s.borrower, &10, &s.fp()),
            Err(Ok(IsolatedLendingError::OracleQuoteMissing))
        );
    }

    #[test]
    fn only_the_configured_oracle_can_push_quotes() {
        let s = setup();
        with_oracle_policy(&s);
        let impostor = Address::generate(&s.env);

        assert_eq!(
            s.pair.try_push_oracle_quote(&impostor, &10_000, &9_000),
            Err(Ok(IsolatedLendingError::Unauthorized))
        );
    }

    // ── Market isolation during liquidation (#1478) ─────────────────

    /// Opens an independent market on the shared `env`: the lender supplies
    /// 1_000 of `debt_token`, the borrower posts 100 of `collateral_token` and
    /// borrows 80, at an 80% collateral factor.
    fn open_market(
        env: &Env,
        admin: &Address,
        collateral_token: &Address,
        debt_token: &Address,
        lender: &Address,
        borrower: &Address,
    ) -> IsolatedLendingPairClient<'static> {
        let pair_id = env.register(IsolatedLendingPair, ());
        let pair = IsolatedLendingPairClient::new(env, &pair_id);
        pair.initialize(admin, collateral_token, debt_token, &8_000);
        mint(env, debt_token, lender, 1_000);
        mint(env, collateral_token, borrower, 100);
        pair.supply(lender, &1_000);
        pair.post_collateral(borrower, &100);
        pair.borrow(borrower, &80, &pair.get_config_fingerprint());
        pair
    }

    struct TwoMarkets {
        env: Env,
        admin: Address,
        borrower: Address,
        lender: Address,
        col_a: Address,
        debt_a: Address,
        col_b: Address,
        debt_b: Address,
        market_a: IsolatedLendingPairClient<'static>,
        market_b: IsolatedLendingPairClient<'static>,
    }

    fn new_token(env: &Env) -> Address {
        env.register_stellar_asset_contract_v2(Address::generate(env))
            .address()
    }

    /// Two simultaneous markets with entirely separate tokens, and the same
    /// borrower and lender active in both.
    fn two_markets() -> TwoMarkets {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let borrower = Address::generate(&env);
        let lender = Address::generate(&env);
        let (col_a, debt_a, col_b, debt_b) = (
            new_token(&env),
            new_token(&env),
            new_token(&env),
            new_token(&env),
        );
        let market_a = open_market(&env, &admin, &col_a, &debt_a, &lender, &borrower);
        let market_b = open_market(&env, &admin, &col_b, &debt_b, &lender, &borrower);
        TwoMarkets {
            env,
            admin,
            borrower,
            lender,
            col_a,
            debt_a,
            col_b,
            debt_b,
            market_a,
            market_b,
        }
    }

    #[test]
    fn two_markets_hold_independent_positions() {
        let m = two_markets();
        assert_eq!(m.market_a.get_position(&m.borrower), (100, 80));
        assert_eq!(m.market_b.get_position(&m.borrower), (100, 80));
        assert_eq!(m.market_a.get_totals(), (1_000, 80));
        assert_eq!(m.market_b.get_totals(), (1_000, 80));
    }

    #[test]
    fn liquidating_one_market_leaves_the_other_untouched() {
        let m = two_markets();
        m.market_a.set_collateral_factor(&m.admin, &4_000);
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_a, &liquidator, 80);

        let b_before = (
            m.market_b.get_position(&m.borrower),
            m.market_b.get_totals(),
            m.market_b.get_bad_debt(),
            balance(&m.env, &m.col_b, &m.market_b.address),
            balance(&m.env, &m.debt_b, &m.market_b.address),
        );

        assert_eq!(
            m.market_a.liquidate(
                &liquidator,
                &m.borrower,
                &1,
                &80,
                &m.market_a.get_config_fingerprint()
            ),
            80
        );

        assert_eq!(m.market_a.get_position(&m.borrower), (20, 0));
        let b_after = (
            m.market_b.get_position(&m.borrower),
            m.market_b.get_totals(),
            m.market_b.get_bad_debt(),
            balance(&m.env, &m.col_b, &m.market_b.address),
            balance(&m.env, &m.debt_b, &m.market_b.address),
        );
        assert_eq!(b_before, b_after);
        // B's debt is still owed in full and B's lender can still be repaid.
        assert_eq!(m.market_b.get_position(&m.borrower), (100, 80));
    }

    #[test]
    fn a_liquidator_paying_the_other_markets_debt_token_cannot_liquidate() {
        let m = two_markets();
        m.market_a.set_collateral_factor(&m.admin, &4_000);
        // Holds plenty of market B's debt token, none of market A's.
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_b, &liquidator, 1_000);

        let res = m.market_a.try_liquidate(
            &liquidator,
            &m.borrower,
            &1,
            &80,
            &m.market_a.get_config_fingerprint(),
        );

        assert!(res.is_err());
        assert_eq!(m.market_a.get_position(&m.borrower), (100, 80));
        assert_eq!(m.market_b.get_position(&m.borrower), (100, 80));
        assert_eq!(balance(&m.env, &m.debt_b, &liquidator), 1_000);
        assert_eq!(balance(&m.env, &m.col_a, &liquidator), 0);
    }

    #[test]
    fn a_position_unhealthy_only_in_another_market_cannot_be_liquidated_here() {
        let m = two_markets();
        // Only market B turns unhealthy for the shared borrower.
        m.market_b.set_collateral_factor(&m.admin, &4_000);
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_a, &liquidator, 80);
        mint(&m.env, &m.debt_b, &liquidator, 80);

        assert_eq!(
            m.market_a.try_liquidate(
                &liquidator,
                &m.borrower,
                &1,
                &80,
                &m.market_a.get_config_fingerprint()
            ),
            Err(Ok(IsolatedLendingError::PositionStillBacked))
        );
        assert_eq!(m.market_a.get_position(&m.borrower), (100, 80));

        // The unhealthy market can still be liquidated on its own terms.
        assert_eq!(
            m.market_b.liquidate(
                &liquidator,
                &m.borrower,
                &1,
                &80,
                &m.market_b.get_config_fingerprint()
            ),
            80
        );
        assert_eq!(m.market_a.get_position(&m.borrower), (100, 80));
    }

    #[test]
    fn a_borrower_with_no_position_in_a_market_cannot_be_liquidated_there() {
        let m = two_markets();
        m.market_a.set_collateral_factor(&m.admin, &4_000);
        let stranger = Address::generate(&m.env);
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_a, &liquidator, 80);

        // No collateral and no debt: nothing to take.
        assert!(m
            .market_a
            .try_liquidate(
                &liquidator,
                &stranger,
                &1,
                &80,
                &m.market_a.get_config_fingerprint()
            )
            .is_err());
        assert_eq!(balance(&m.env, &m.debt_a, &liquidator), 80);
    }

    #[test]
    fn liquidation_ids_are_scoped_to_their_market() {
        let m = two_markets();
        m.market_a.set_collateral_factor(&m.admin, &4_000);
        m.market_b.set_collateral_factor(&m.admin, &4_000);
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_a, &liquidator, 80);
        mint(&m.env, &m.debt_b, &liquidator, 80);

        // Id 7 is consumed in market A only.
        m.market_a.liquidate(
            &liquidator,
            &m.borrower,
            &7,
            &40,
            &m.market_a.get_config_fingerprint(),
        );
        assert_eq!(
            m.market_a.try_liquidate(
                &liquidator,
                &m.borrower,
                &7,
                &40,
                &m.market_a.get_config_fingerprint()
            ),
            Err(Ok(IsolatedLendingError::AlreadyLiquidated))
        );
        // The same id in market B is a different liquidation.
        assert_eq!(
            m.market_b.liquidate(
                &liquidator,
                &m.borrower,
                &7,
                &40,
                &m.market_b.get_config_fingerprint()
            ),
            40
        );
        assert_eq!(m.market_b.get_position(&m.borrower), (60, 40));
    }

    #[test]
    fn bad_debt_is_recorded_only_in_the_market_that_incurred_it() {
        let m = two_markets();
        // Collateral in A is worth 50 against 80 of debt.
        m.market_a.set_collateral_price(&m.admin, &5_000);
        let liquidator = Address::generate(&m.env);
        mint(&m.env, &m.debt_a, &liquidator, 80);

        m.market_a.liquidate(
            &liquidator,
            &m.borrower,
            &1,
            &80,
            &m.market_a.get_config_fingerprint(),
        );

        assert_eq!(m.market_a.get_bad_debt(), 30);
        assert_eq!(m.market_b.get_bad_debt(), 0);
        assert_eq!(m.market_b.get_totals(), (1_000, 80));
    }

    #[test]
    fn markets_sharing_a_debt_token_do_not_share_liquidity() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let borrower = Address::generate(&env);
        let lender_a = Address::generate(&env);
        let lender_b = Address::generate(&env);
        let shared_debt = new_token(&env);
        let col_a = new_token(&env);
        let col_b = new_token(&env);
        let market_a = open_market(&env, &admin, &col_a, &shared_debt, &lender_a, &borrower);
        let market_b = open_market(&env, &admin, &col_b, &shared_debt, &lender_b, &borrower);

        market_a.set_collateral_factor(&admin, &4_000);
        let liquidator = Address::generate(&env);
        mint(&env, &shared_debt, &liquidator, 80);
        market_a.liquidate(
            &liquidator,
            &borrower,
            &1,
            &80,
            &market_a.get_config_fingerprint(),
        );

        // The liquidator's repayment stays with market A.
        assert_eq!(balance(&env, &shared_debt, &market_a.address), 920 + 80);
        assert_eq!(balance(&env, &shared_debt, &market_b.address), 920);
        // Market B's lender can still withdraw only what market B holds.
        assert_eq!(market_b.get_available_liquidity(), 920);
        assert_eq!(market_b.get_totals(), (1_000, 80));
        assert_eq!(market_b.get_position(&borrower), (100, 80));
    }

    #[test]
    fn markets_sharing_a_collateral_token_pay_out_only_their_own_holdings() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let borrower = Address::generate(&env);
        let lender = Address::generate(&env);
        let shared_collateral = new_token(&env);
        let debt_a = new_token(&env);
        let debt_b = new_token(&env);
        let market_a = open_market(
            &env,
            &admin,
            &shared_collateral,
            &debt_a,
            &lender,
            &borrower,
        );
        let market_b = open_market(
            &env,
            &admin,
            &shared_collateral,
            &debt_b,
            &lender,
            &borrower,
        );
        assert_eq!(balance(&env, &shared_collateral, &market_a.address), 100);
        assert_eq!(balance(&env, &shared_collateral, &market_b.address), 100);

        // Market A's collateral is nearly worthless: a full liquidation seizes
        // every unit market A holds, and nothing from market B.
        market_a.set_collateral_price(&admin, &1_000);
        let liquidator = Address::generate(&env);
        mint(&env, &debt_a, &liquidator, 80);
        let seized = market_a.liquidate(
            &liquidator,
            &borrower,
            &1,
            &80,
            &market_a.get_config_fingerprint(),
        );

        assert_eq!(seized, 100);
        assert_eq!(balance(&env, &shared_collateral, &market_a.address), 0);
        assert_eq!(balance(&env, &shared_collateral, &market_b.address), 100);
        assert_eq!(balance(&env, &shared_collateral, &liquidator), 100);
        assert_eq!(market_b.get_position(&borrower), (100, 80));
    }

    #[test]
    fn a_market_cannot_pay_out_collateral_it_does_not_hold() {
        let s = setup();
        // Corrupt the books: the pair believes the borrower posted far more
        // collateral than the contract actually holds (100).
        s.env.as_contract(&s.pair.address, || {
            s.env
                .storage()
                .persistent()
                .set(&PairDataKey::Collateral(s.borrower.clone()), &1_000_i128);
        });
        s.pair.set_collateral_price(&s.admin, &900); // limit 72 < debt 80
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        // 80 / 0.09 = 888 collateral would be seized; the pair holds 100.
        assert_eq!(
            s.pair
                .try_liquidate(&liquidator, &s.borrower, &1, &80, &s.fp()),
            Err(Ok(IsolatedLendingError::InsufficientCollateral))
        );
        // Rejected cleanly: no tokens moved and the liquidation id is still free.
        assert_eq!(balance(&s.env, &s.debt_token, &liquidator), 80);
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 0);
        assert_eq!(balance(&s.env, &s.collateral_token, &s.pair.address), 100);
        s.env.as_contract(&s.pair.address, || {
            assert!(!s
                .env
                .storage()
                .persistent()
                .has(&PairDataKey::Liquidation(s.borrower.clone(), 1)));
        });
    }

    #[test]
    fn factory_pairs_for_different_token_pairs_are_distinct_markets() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let factory_id = env.register(IsolatedLendingFactory, ());
        let factory = IsolatedLendingFactoryClient::new(&env, &factory_id);
        factory.initialize_factory(&admin);
        let (a, b, c) = (new_token(&env), new_token(&env), new_token(&env));

        let ab = factory.create_pair(&admin, &a, &b, &8_000);
        let ac = factory.create_pair(&admin, &a, &c, &8_000);
        let ba = factory.create_pair(&admin, &b, &a, &8_000);

        // Same tokens in a different role, or a different counterpart, is a different market.
        assert_ne!(ab.pair_id, ac.pair_id);
        assert_ne!(ab.pair_id, ba.pair_id);
        assert!(matches!(
            factory.try_create_pair(&admin, &a, &b, &8_000),
            Err(Ok(IsolatedLendingError::PairAlreadyExists))
        ));
    }

    // ── Health-factor components (#1487) ────────────────────────────

    #[test]
    fn health_factor_tracks_collateral_price_movement() {
        let s = setup();
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        // 80 <= 100 * 80%: backed, and liquidation agrees.
        assert_eq!(
            s.pair.get_health_factor(&s.borrower),
            HealthFactor {
                debt_value: 80,
                collateral_value: 100,
                threshold_bps: 8_000,
                ledger: s.env.ledger().sequence(),
                config_fingerprint: s.fp(),
            }
        );
        assert_eq!(
            s.pair
                .try_liquidate(&liquidator, &s.borrower, &1, &80, &s.fp()),
            Err(Ok(IsolatedLendingError::PositionStillBacked))
        );

        // A 10% price drop: 80 > 90 * 80% = 72, and liquidation agrees.
        s.pair.set_collateral_price(&s.admin, &9_000);
        let health = s.pair.get_health_factor(&s.borrower);
        assert_eq!((health.debt_value, health.collateral_value), (80, 90));
        assert_eq!(
            s.pair.liquidate(&liquidator, &s.borrower, &1, &80, &s.fp()),
            88
        );
    }

    #[test]
    fn health_factor_reports_debt_accrued_to_the_calculation_ledger() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        set_ledger(&s.env, 2);

        let health = s.pair.get_health_factor(&s.borrower);
        assert_eq!((health.debt_value, health.ledger), (100, 2));
        assert_eq!(s.pair.get_position(&s.borrower).1, health.debt_value);
    }

    #[test]
    fn health_factor_with_empty_debt() {
        let s = setup();
        s.pair.repay(&s.borrower, &80);

        let health = s.pair.get_health_factor(&s.borrower);
        assert_eq!((health.debt_value, health.collateral_value), (0, 100));

        let stranger = Address::generate(&s.env);
        assert_eq!(
            s.pair.get_health_factor(&stranger),
            HealthFactor {
                debt_value: 0,
                collateral_value: 0,
                threshold_bps: 8_000,
                ledger: s.env.ledger().sequence(),
                config_fingerprint: s.fp(),
            }
        );
    }

    #[test]
    fn health_factor_rejects_an_invalid_oracle_state() {
        let s = setup();
        let oracle = with_oracle_policy(&s);
        assert_eq!(
            s.pair.try_get_health_factor(&s.borrower),
            Err(Ok(IsolatedLendingError::OracleQuoteMissing))
        );

        s.pair.push_oracle_quote(&oracle, &10_000, &7_999);
        assert_eq!(
            s.pair.try_get_health_factor(&s.borrower),
            Err(Ok(IsolatedLendingError::OracleConfidenceTooLow))
        );

        s.pair.push_oracle_quote(&oracle, &10_000, &9_000);
        assert_eq!(s.pair.get_health_factor(&s.borrower).collateral_value, 200);

        set_ledger(&s.env, 11);
        assert_eq!(
            s.pair.try_get_health_factor(&s.borrower),
            Err(Ok(IsolatedLendingError::OracleQuoteStale))
        );
    }

    // ── Configuration fingerprints (#1752) ──────────────────────────

    #[test]
    fn config_fingerprint_is_deterministic_across_reads_ledgers_and_balances() {
        let s = setup();
        let first = s.pair.get_config_fingerprint();

        // Balances, totals and ledger movement are not configuration.
        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 10);
        set_ledger(&s.env, 5);
        s.pair.repay_for(&payer, &s.borrower, &10);
        s.pair.get_health_factor(&s.borrower);
        assert!(s.pair.get_available_liquidity() > 0);

        assert_eq!(s.pair.get_config_fingerprint(), first);
        // The snapshot is an immutable value that repeats deterministically.
        assert_eq!(s.pair.get_config_snapshot(), s.pair.get_config_snapshot());
    }

    #[test]
    fn config_fingerprint_changes_for_every_admin_config_update() {
        let s = setup();
        let mut previous = s.pair.get_config_fingerprint();

        s.pair.set_reserve_bps(&s.admin, &500);
        let next = s.pair.get_config_fingerprint();
        assert_ne!(next, previous);
        previous = next;

        s.pair.set_collateral_factor(&s.admin, &7_000);
        let next = s.pair.get_config_fingerprint();
        assert_ne!(next, previous);
        previous = next;

        s.pair.set_collateral_price(&s.admin, &9_500);
        let next = s.pair.get_config_fingerprint();
        assert_ne!(next, previous);
        previous = next;

        s.pair.set_close_factor(&s.admin, &5_000);
        let next = s.pair.get_config_fingerprint();
        assert_ne!(next, previous);
        previous = next;

        s.pair.set_interest_rate(&s.admin, &RATE);
        let next = s.pair.get_config_fingerprint();
        assert_ne!(next, previous);
        previous = next;

        s.pair.set_protocol_fee_bps(&s.admin, &1_000);
        let next = s.pair.get_config_fingerprint();
        assert_ne!(next, previous);
        previous = next;

        let oracle = Address::generate(&s.env);
        s.pair.set_oracle(&s.admin, &oracle);
        let next = s.pair.get_config_fingerprint();
        assert_ne!(next, previous);
        previous = next;

        s.pair.set_oracle_policy(&s.admin, &8_000, &10);
        let next = s.pair.get_config_fingerprint();
        assert_ne!(next, previous);
        previous = next;

        // Re-writing the same values does not fabricate a new configuration.
        s.pair.set_oracle_policy(&s.admin, &8_000, &10);
        assert_eq!(s.pair.get_config_fingerprint(), previous);
    }

    #[test]
    fn borrow_with_current_fingerprint_succeeds() {
        let s = setup();
        mint(&s.env, &s.collateral_token, &s.borrower, 100);
        s.pair.post_collateral(&s.borrower, &100);

        // 200 of collateral at an 80% factor covers 160 of total debt.
        s.pair.borrow(&s.borrower, &80, &s.fp());

        assert_eq!(s.pair.get_position(&s.borrower), (200, 160));
        // The setup already borrowed 80; this call added another 80.
        assert_eq!(balance(&s.env, &s.debt_token, &s.borrower), 160);
    }

    #[test]
    fn borrow_with_stale_fingerprint_is_rejected_without_state_change() {
        let s = setup();
        mint(&s.env, &s.collateral_token, &s.borrower, 100);
        s.pair.post_collateral(&s.borrower, &100);
        let stale = s.fp();

        // The admin changes configuration after the client captured its snapshot.
        s.pair.set_reserve_bps(&s.admin, &100);

        let position = s.pair.get_position(&s.borrower);
        let totals = s.pair.get_totals();
        let borrower_balance = balance(&s.env, &s.debt_token, &s.borrower);
        let pair_balance = balance(&s.env, &s.debt_token, &s.pair.address);

        assert_eq!(
            s.pair.try_borrow(&s.borrower, &50, &stale),
            Err(Ok(IsolatedLendingError::StaleConfig))
        );

        assert_eq!(s.pair.get_position(&s.borrower), position);
        assert_eq!(s.pair.get_totals(), totals);
        assert_eq!(
            balance(&s.env, &s.debt_token, &s.borrower),
            borrower_balance
        );
        assert_eq!(
            balance(&s.env, &s.debt_token, &s.pair.address),
            pair_balance
        );
    }

    #[test]
    fn borrow_retry_with_refreshed_fingerprint_succeeds() {
        let s = setup();
        mint(&s.env, &s.collateral_token, &s.borrower, 100);
        s.pair.post_collateral(&s.borrower, &100);
        let stale = s.fp();
        s.pair.set_reserve_bps(&s.admin, &100);

        assert_eq!(
            s.pair.try_borrow(&s.borrower, &10, &stale),
            Err(Ok(IsolatedLendingError::StaleConfig))
        );

        // Refresh, then retry the same logical operation.
        let current = s.fp();
        assert_ne!(current, stale);
        s.pair.borrow(&s.borrower, &10, &current);
        assert_eq!(s.pair.get_position(&s.borrower), (200, 90));
    }

    #[test]
    fn withdraw_collateral_with_stale_fingerprint_preserves_collateral() {
        let s = setup();
        mint(&s.env, &s.collateral_token, &s.borrower, 10);
        s.pair.post_collateral(&s.borrower, &10);
        let stale = s.fp();
        s.pair.set_reserve_bps(&s.admin, &100);

        assert_eq!(
            s.pair.try_withdraw_collateral(&s.borrower, &10, &stale),
            Err(Ok(IsolatedLendingError::StaleConfig))
        );
        assert_eq!(s.pair.get_position(&s.borrower), (110, 80));
        assert_eq!(balance(&s.env, &s.collateral_token, &s.borrower), 0);

        s.pair.withdraw_collateral(&s.borrower, &10, &s.fp());
        assert_eq!(s.pair.get_position(&s.borrower), (100, 80));
        assert_eq!(balance(&s.env, &s.collateral_token, &s.borrower), 10);
    }

    #[test]
    fn liquidation_with_stale_fingerprint_keeps_the_id_usable() {
        let s = setup();
        // Unhealthy: 80 of debt against 100 of collateral at a 40% factor.
        s.pair.set_collateral_factor(&s.admin, &4_000);
        let stale = s.fp();
        // The collateral price changes after the client captured its snapshot.
        s.pair.set_collateral_price(&s.admin, &9_000);
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);

        let position = s.pair.get_position(&s.borrower);
        assert_eq!(
            s.pair
                .try_liquidate(&liquidator, &s.borrower, &5, &40, &stale),
            Err(Ok(IsolatedLendingError::StaleConfig))
        );
        assert_eq!(s.pair.get_position(&s.borrower), position);
        assert_eq!(balance(&s.env, &s.debt_token, &liquidator), 80);
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 0);

        // Refresh and retry with the same liquidation id: the rejected attempt
        // consumed neither funds nor the id.
        assert_eq!(
            s.pair.liquidate(&liquidator, &s.borrower, &5, &40, &s.fp()),
            44
        );
        assert_eq!(s.pair.get_position(&s.borrower), (56, 40));
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 44);
    }

    #[test]
    fn stale_fingerprint_is_rejected_before_interest_accrues() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        let stale = s.fp();
        s.pair.set_reserve_bps(&s.admin, &100);

        // Read stored accrual markers: views compute pending interest without
        // writing, so they cannot prove that nothing was persisted.
        let read_accrual = || {
            s.env.as_contract(&s.pair.address, || {
                (
                    s.env
                        .storage()
                        .instance()
                        .get::<_, i128>(&PairDataKey::BorrowIndex),
                    s.env
                        .storage()
                        .instance()
                        .get::<_, u32>(&PairDataKey::LastAccrualLedger),
                    s.env
                        .storage()
                        .instance()
                        .get::<_, i128>(&PairDataKey::TotalDebt),
                )
            })
        };

        set_ledger(&s.env, 3);
        let before = read_accrual();
        assert_eq!(
            s.pair.try_borrow(&s.borrower, &1, &stale),
            Err(Ok(IsolatedLendingError::StaleConfig))
        );
        assert_eq!(read_accrual(), before);
    }

    #[test]
    fn health_factor_exposes_the_fingerprint_it_was_computed_under() {
        let s = setup();
        let health = s.pair.get_health_factor(&s.borrower);
        assert_eq!(health.config_fingerprint, s.fp());

        s.pair.set_collateral_factor(&s.admin, &7_000);
        let refreshed = s.pair.get_health_factor(&s.borrower);
        assert_ne!(refreshed.config_fingerprint, health.config_fingerprint);
        assert_eq!(refreshed.threshold_bps, 7_000);
    }

    // ── Boundary-value calculations (#1756) ─────────────────────────

    fn set_persistent(env: &Env, contract: &Address, key: PairDataKey, value: i128) {
        env.as_contract(contract, || {
            env.storage().persistent().set(&key, &value);
        });
    }

    fn set_instance(env: &Env, contract: &Address, key: PairDataKey, value: i128) {
        env.as_contract(contract, || {
            env.storage().instance().set(&key, &value);
        });
    }

    fn instance_i128(env: &Env, contract: &Address, key: PairDataKey) -> Option<i128> {
        env.as_contract(contract, || env.storage().instance().get(&key))
    }

    #[test]
    fn supply_overflow_is_rejected_before_the_transfer() {
        let s = setup();
        let user = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &user, 10);
        // A corrupted balance at the i128 maximum cannot absorb even one unit.
        set_persistent(
            &s.env,
            &s.pair.address,
            PairDataKey::Supply(user.clone()),
            i128::MAX,
        );

        let user_balance = balance(&s.env, &s.debt_token, &user);
        let pair_balance = balance(&s.env, &s.debt_token, &s.pair.address);
        assert_eq!(
            s.pair.try_supply(&user, &1),
            Err(Ok(IsolatedLendingError::MathOverflow))
        );

        // No tokens moved and the market total is unchanged.
        assert_eq!(balance(&s.env, &s.debt_token, &user), user_balance);
        assert_eq!(
            balance(&s.env, &s.debt_token, &s.pair.address),
            pair_balance
        );
        assert_eq!(s.pair.get_totals(), (1_000, 80));
    }

    #[test]
    fn post_collateral_overflow_is_rejected_before_the_transfer() {
        let s = setup();
        let user = Address::generate(&s.env);
        mint(&s.env, &s.collateral_token, &user, 1);
        set_persistent(
            &s.env,
            &s.pair.address,
            PairDataKey::Collateral(user.clone()),
            i128::MAX,
        );

        let user_balance = balance(&s.env, &s.collateral_token, &user);
        assert_eq!(
            s.pair.try_post_collateral(&user, &1),
            Err(Ok(IsolatedLendingError::MathOverflow))
        );
        assert_eq!(balance(&s.env, &s.collateral_token, &user), user_balance);
        assert_eq!(s.pair.get_position(&s.borrower), (100, 80));
    }

    #[test]
    fn withdraw_total_underflow_preserves_supplier_and_balances() {
        let s = setup();
        // Corrupt the market total so the withdrawal cannot be recorded.
        set_instance(&s.env, &s.pair.address, PairDataKey::TotalSupplied, 0);
        let before = balance(&s.env, &s.debt_token, &s.lender);
        assert_eq!(
            instance_i128(&s.env, &s.pair.address, PairDataKey::TotalSupplied),
            Some(0)
        );
        assert_eq!(s.pair.get_totals().0, 0);

        assert_eq!(
            s.pair.try_withdraw(&s.lender, &10),
            Err(Ok(IsolatedLendingError::MathOverflow))
        );

        assert_eq!(balance(&s.env, &s.debt_token, &s.lender), before);
        assert_eq!(
            s.env.as_contract(&s.pair.address, || s
                .env
                .storage()
                .persistent()
                .get::<_, i128>(&PairDataKey::Supply(s.lender.clone()))),
            Some(1_000)
        );
    }

    #[test]
    fn borrow_over_the_limit_preserves_state_and_safe_retry_succeeds() {
        let s = setup();
        let position = s.pair.get_position(&s.borrower);
        let totals = s.pair.get_totals();
        let borrower_balance = balance(&s.env, &s.debt_token, &s.borrower);
        let pair_balance = balance(&s.env, &s.debt_token, &s.pair.address);

        // 80 of debt against a 100 * 80% = 80 limit: one more unit is rejected.
        assert_eq!(
            s.pair.try_borrow(&s.borrower, &1, &s.fp()),
            Err(Ok(IsolatedLendingError::InsufficientCollateral))
        );
        assert_eq!(s.pair.get_position(&s.borrower), position);
        assert_eq!(s.pair.get_totals(), totals);
        assert_eq!(
            balance(&s.env, &s.debt_token, &s.borrower),
            borrower_balance
        );
        assert_eq!(
            balance(&s.env, &s.debt_token, &s.pair.address),
            pair_balance
        );

        // Releasing debt restores headroom; the same logical operation can retry.
        s.pair.repay(&s.borrower, &10);
        s.pair.borrow(&s.borrower, &10, &s.fp());
        assert_eq!(s.pair.get_position(&s.borrower), (100, 80));
    }

    #[test]
    fn zero_amounts_are_typed_and_do_not_change_state() {
        let s = setup();
        let position = s.pair.get_position(&s.borrower);
        let totals = s.pair.get_totals();

        assert_eq!(
            s.pair.try_supply(&s.lender, &0),
            Err(Ok(IsolatedLendingError::InvalidAmount))
        );
        assert_eq!(
            s.pair.try_withdraw(&s.lender, &0),
            Err(Ok(IsolatedLendingError::InvalidAmount))
        );
        assert_eq!(
            s.pair.try_post_collateral(&s.borrower, &0),
            Err(Ok(IsolatedLendingError::InvalidAmount))
        );
        assert_eq!(
            s.pair.try_withdraw_collateral(&s.borrower, &0, &s.fp()),
            Err(Ok(IsolatedLendingError::InvalidAmount))
        );
        assert_eq!(
            s.pair.try_borrow(&s.borrower, &0, &s.fp()),
            Err(Ok(IsolatedLendingError::InvalidAmount))
        );
        assert_eq!(
            s.pair.try_repay(&s.borrower, &0),
            Err(Ok(IsolatedLendingError::InvalidAmount))
        );
        assert_eq!(
            s.pair.try_queue_withdrawal(&s.lender, &0),
            Err(Ok(IsolatedLendingError::InvalidAmount))
        );
        let liquidator = Address::generate(&s.env);
        assert_eq!(
            s.pair
                .try_liquidate(&liquidator, &s.borrower, &1, &0, &s.fp()),
            Err(Ok(IsolatedLendingError::InvalidAmount))
        );

        assert_eq!(s.pair.get_position(&s.borrower), position);
        assert_eq!(s.pair.get_totals(), totals);
    }

    #[test]
    fn minimum_position_lifecycle() {
        let s = setup();
        // A one-unit collateral position is rounded to a zero borrow limit at 80%.
        let user = Address::generate(&s.env);
        mint(&s.env, &s.collateral_token, &user, 1);
        s.pair.post_collateral(&user, &1);
        assert_eq!(
            s.pair.try_borrow(&user, &1, &s.fp()),
            Err(Ok(IsolatedLendingError::InsufficientCollateral))
        );

        // At a 100% factor the same single unit backs the smallest nonzero debt.
        s.pair.set_collateral_factor(&s.admin, &10_000);
        s.pair.borrow(&user, &1, &s.fp());
        assert_eq!(s.pair.get_position(&user), (1, 1));

        s.pair.repay(&user, &1);
        assert_eq!(s.pair.get_position(&user), (1, 0));
        s.pair.withdraw_collateral(&user, &1, &s.fp());
        assert_eq!(s.pair.get_position(&user), (0, 0));
    }

    #[test]
    fn rounding_floors_the_borrow_limit_and_collateral_value() {
        let s = setup();
        s.pair.set_collateral_factor(&s.admin, &9_999);
        let user = Address::generate(&s.env);
        mint(&s.env, &s.collateral_token, &user, 3);
        s.pair.post_collateral(&user, &3);

        // floor(3 * 9_999 / 10_000) = 2, so only two units can be borrowed.
        s.pair.borrow(&user, &2, &s.fp());
        assert_eq!(
            s.pair.try_borrow(&user, &1, &s.fp()),
            Err(Ok(IsolatedLendingError::InsufficientCollateral))
        );

        // Collateral value also floors: 100 at 3_333 bps is worth 33, and one
        // unit is worth nothing.
        s.pair.set_collateral_price(&s.admin, &3_333);
        let tiny = Address::generate(&s.env);
        mint(&s.env, &s.collateral_token, &tiny, 1);
        s.pair.post_collateral(&tiny, &1);
        assert_eq!(s.pair.get_health_factor(&tiny).collateral_value, 0);
        assert_eq!(s.pair.get_health_factor(&s.borrower).collateral_value, 33);
    }

    #[test]
    fn rounding_floors_reserve_and_protocol_fee_shares() {
        let s = setup();
        // One bp of 1_000 floors to zero, so borrowable liquidity is unchanged.
        s.pair.set_reserve_bps(&s.admin, &1);
        assert_eq!(s.pair.get_available_liquidity(), 920);

        // floor(10 interest * 3_333 bps / 10_000) = 3.
        s.pair.set_interest_rate(&s.admin, &RATE);
        s.pair.set_protocol_fee_bps(&s.admin, &3_333);
        set_ledger(&s.env, 1);
        assert_eq!(s.pair.get_protocol_fees(), 3);
    }

    #[test]
    fn available_liquidity_floors_at_zero() {
        let s = setup();
        // Queued withdrawals beyond the supply cannot make liquidity negative.
        set_instance(
            &s.env,
            &s.pair.address,
            PairDataKey::PendingWithdrawals,
            2_000,
        );
        assert_eq!(s.pair.get_available_liquidity(), 0);
    }

    #[test]
    fn interest_overflow_is_typed_and_leaves_accrual_markers_untouched() {
        let s = setup();
        s.pair.set_interest_rate(&s.admin, &RATE);
        // A corrupted index cannot be grown by 12.5% per ledger.
        set_instance(
            &s.env,
            &s.pair.address,
            PairDataKey::BorrowIndex,
            i128::MAX / 2,
        );
        set_ledger(&s.env, 10);

        let index_before = instance_i128(&s.env, &s.pair.address, PairDataKey::BorrowIndex);
        let debt_before = instance_i128(&s.env, &s.pair.address, PairDataKey::TotalDebt);

        assert_eq!(
            s.pair.try_borrow(&s.borrower, &1, &s.fp()),
            Err(Ok(IsolatedLendingError::MathOverflow))
        );

        assert_eq!(
            instance_i128(&s.env, &s.pair.address, PairDataKey::BorrowIndex),
            index_before
        );
        assert_eq!(
            instance_i128(&s.env, &s.pair.address, PairDataKey::TotalDebt),
            debt_before
        );
        // Reads surface the same typed failure instead of panicking.
        assert_eq!(
            s.pair.try_get_position(&s.borrower),
            Err(Ok(IsolatedLendingError::MathOverflow))
        );
    }

    #[test]
    fn liquidation_seizure_overflow_leaves_position_and_id_untouched() {
        let s = setup();
        // Debt far above the borrow limit and a repayment large enough that
        // scaling it by 10_000 overflows.
        let huge = i128::MAX / 2;
        set_persistent(
            &s.env,
            &s.pair.address,
            PairDataKey::Debt(s.borrower.clone()),
            huge,
        );
        set_persistent(
            &s.env,
            &s.pair.address,
            PairDataKey::DebtIndex(s.borrower.clone()),
            INDEX_SCALE,
        );
        s.pair.set_collateral_factor(&s.admin, &4_000);
        s.pair.set_collateral_price(&s.admin, &1);
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 10);

        assert_eq!(
            s.pair
                .try_liquidate(&liquidator, &s.borrower, &9, &(i128::MAX / 4), &s.fp()),
            Err(Ok(IsolatedLendingError::MathOverflow))
        );

        // The stored position is untouched (the view itself cannot scale a
        // debt this large, and reports the same typed error).
        assert_eq!(
            s.env.as_contract(&s.pair.address, || s
                .env
                .storage()
                .persistent()
                .get::<_, i128>(&PairDataKey::Debt(s.borrower.clone()))),
            Some(huge)
        );
        assert_eq!(
            s.pair.try_get_position(&s.borrower),
            Err(Ok(IsolatedLendingError::MathOverflow))
        );
        assert_eq!(balance(&s.env, &s.debt_token, &liquidator), 10);
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 0);
        assert!(s.env.as_contract(&s.pair.address, || !s
            .env
            .storage()
            .persistent()
            .has(&PairDataKey::Liquidation(s.borrower.clone(), 9))));
    }

    #[test]
    fn bad_debt_overflow_is_rejected_before_transfers() {
        let s = setup();
        // Collateral worth 50 against 80 of debt; the write-off would overflow.
        s.pair.set_collateral_price(&s.admin, &5_000);
        set_instance(
            &s.env,
            &s.pair.address,
            PairDataKey::BadDebt,
            i128::MAX - 10,
        );
        let liquidator = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &liquidator, 80);
        let pair_collateral = balance(&s.env, &s.collateral_token, &s.pair.address);

        assert_eq!(
            s.pair
                .try_liquidate(&liquidator, &s.borrower, &2, &80, &s.fp()),
            Err(Ok(IsolatedLendingError::MathOverflow))
        );

        // Nothing moved, the position is unchanged and the id can be retried
        // once the corruption that caused the overflow is gone.
        assert_eq!(s.pair.get_position(&s.borrower), (100, 80));
        assert_eq!(balance(&s.env, &s.debt_token, &liquidator), 80);
        assert_eq!(balance(&s.env, &s.collateral_token, &liquidator), 0);
        assert_eq!(
            balance(&s.env, &s.collateral_token, &s.pair.address),
            pair_collateral
        );
        assert!(s.env.as_contract(&s.pair.address, || !s
            .env
            .storage()
            .persistent()
            .has(&PairDataKey::Liquidation(s.borrower.clone(), 2))));
    }

    #[test]
    fn zero_configuration_values_are_rejected() {
        let s = setup();
        assert_eq!(
            s.pair.try_set_collateral_price(&s.admin, &0),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );
        assert_eq!(
            s.pair.try_set_collateral_factor(&s.admin, &0),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );
        assert_eq!(
            s.pair.try_set_close_factor(&s.admin, &0),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );
        assert_eq!(
            s.pair.try_set_reserve_bps(&s.admin, &10_001),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );
        assert_eq!(
            s.pair.try_set_oracle_policy(&s.admin, &10_001, &10),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );

        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let pair_id = env.register(IsolatedLendingPair, ());
        let pair = IsolatedLendingPairClient::new(&env, &pair_id);
        let (col, debt) = (new_token(&env), new_token(&env));
        assert_eq!(
            pair.try_initialize(&admin, &col, &debt, &0),
            Err(Ok(IsolatedLendingError::InvalidConfig))
        );
        assert_eq!(
            pair.try_get_totals(),
            Err(Ok(IsolatedLendingError::NotInitialized))
        );
    }

    // ── Operation identity and duplicate submissions (#1754) ─────────

    fn op_id(env: &Env, seed: u8) -> BytesN<32> {
        let mut bytes = [0u8; 32];
        bytes[0] = seed;
        bytes[31] = 0xA5;
        BytesN::from_array(env, &bytes)
    }

    /// Every balance and piece of market state a lending operation can touch.
    #[derive(Debug, PartialEq, Eq)]
    struct MarketState {
        totals: (i128, i128),
        liquidity: i128,
        pair_debt_cash: i128,
        pair_collateral_cash: i128,
        lender_position: (i128, i128),
        borrower_position: (i128, i128),
        lender_cash: i128,
        borrower_debt_cash: i128,
        borrower_collateral_cash: i128,
        pending: i128,
        lender_supply: i128,
    }

    fn market_state(s: &Setup) -> MarketState {
        let pair = s.pair.address.clone();
        let (pending, lender_supply) = s.env.as_contract(&pair, || {
            let pending: i128 = s
                .env
                .storage()
                .instance()
                .get(&PairDataKey::PendingWithdrawals)
                .unwrap_or(0);
            let supply: i128 = s
                .env
                .storage()
                .persistent()
                .get(&PairDataKey::Supply(s.lender.clone()))
                .unwrap_or(0);
            (pending, supply)
        });
        MarketState {
            totals: s.pair.get_totals(),
            liquidity: s.pair.get_available_liquidity(),
            pair_debt_cash: balance(&s.env, &s.debt_token, &pair),
            pair_collateral_cash: balance(&s.env, &s.collateral_token, &pair),
            lender_position: s.pair.get_position(&s.lender),
            borrower_position: s.pair.get_position(&s.borrower),
            lender_cash: balance(&s.env, &s.debt_token, &s.lender),
            borrower_debt_cash: balance(&s.env, &s.debt_token, &s.borrower),
            borrower_collateral_cash: balance(&s.env, &s.collateral_token, &s.borrower),
            pending,
            lender_supply,
        }
    }

    #[test]
    fn supply_with_id_applies_once_and_records_a_receipt() {
        let s = setup();
        mint(&s.env, &s.debt_token, &s.lender, 500);
        let id = op_id(&s.env, 1);
        assert_eq!(s.pair.get_operation(&s.lender, &id), None);

        let receipt = s.pair.supply_with_id(&s.lender, &500, &id);

        assert_eq!(receipt.operation_id, id);
        assert_eq!(receipt.kind, symbol_short!("supply"));
        assert_eq!(receipt.account, s.lender);
        assert_eq!(receipt.beneficiary, s.lender);
        assert_eq!(receipt.amount, 500);
        assert_eq!(receipt.ledger, s.env.ledger().sequence());
        assert_eq!(s.pair.get_operation(&s.lender, &id), Some(receipt));
        assert_eq!(s.pair.get_totals(), (1_500, 80));
        assert_eq!(balance(&s.env, &s.debt_token, &s.lender), 0);
        assert_eq!(balance(&s.env, &s.debt_token, &s.pair.address), 1_500 - 80);
    }

    #[test]
    fn duplicate_supply_returns_the_receipt_without_moving_funds() {
        let s = setup();
        mint(&s.env, &s.debt_token, &s.lender, 1_000);
        let id = op_id(&s.env, 2);
        let first = s.pair.supply_with_id(&s.lender, &400, &id);
        let after_first = market_state(&s);

        // Same request, same id, several times and in a later ledger.
        s.env.ledger().with_mut(|l| l.sequence_number += 10);
        for _ in 0..3 {
            assert_eq!(s.pair.supply_with_id(&s.lender, &400, &id), first);
        }

        assert_eq!(market_state(&s), after_first);
        assert_eq!(after_first.lender_supply, 1_400);
        assert_eq!(after_first.lender_cash, 600);
    }

    #[test]
    fn distinct_ids_are_independent_operations() {
        let s = setup();
        mint(&s.env, &s.debt_token, &s.lender, 300);

        s.pair.supply_with_id(&s.lender, &100, &op_id(&s.env, 3));
        s.pair.supply_with_id(&s.lender, &100, &op_id(&s.env, 4));
        // Same amount, same account, new id: a legitimate second deposit.
        s.pair.supply_with_id(&s.lender, &100, &op_id(&s.env, 5));

        assert_eq!(s.pair.get_totals(), (1_300, 80));
        assert_eq!(balance(&s.env, &s.debt_token, &s.lender), 0);
    }

    #[test]
    fn ids_are_scoped_to_the_authorizing_account() {
        let s = setup();
        let other = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &s.lender, 100);
        mint(&s.env, &s.debt_token, &other, 100);
        let id = op_id(&s.env, 6);

        s.pair.supply_with_id(&s.lender, &100, &id);
        // Another account cannot consume, replay or collide with the lender's id.
        let receipt = s.pair.supply_with_id(&other, &100, &id);

        assert_eq!(receipt.account, other);
        assert_eq!(s.pair.get_totals(), (1_200, 80));
        assert_eq!(s.pair.get_position(&other), (0, 0));
        assert_eq!(balance(&s.env, &s.debt_token, &other), 0);
    }

    #[test]
    fn reusing_an_id_for_a_different_request_is_a_conflict() {
        let s = setup();
        mint(&s.env, &s.debt_token, &s.lender, 500);
        let id = op_id(&s.env, 7);
        s.pair.supply_with_id(&s.lender, &200, &id);
        let before = market_state(&s);

        // Different amount.
        assert_eq!(
            s.pair.try_supply_with_id(&s.lender, &201, &id),
            Err(Ok(IsolatedLendingError::OperationConflict))
        );
        // Different kind.
        assert_eq!(
            s.pair.try_withdraw_with_id(&s.lender, &200, &id),
            Err(Ok(IsolatedLendingError::OperationConflict))
        );
        assert_eq!(
            s.pair.try_queue_withdrawal_with_id(&s.lender, &200, &id),
            Err(Ok(IsolatedLendingError::OperationConflict))
        );

        assert_eq!(market_state(&s), before);
        assert_eq!(s.pair.get_operation(&s.lender, &id).unwrap().amount, 200);
    }

    #[test]
    fn invalid_operation_input_is_rejected_without_state_change() {
        let s = setup();
        mint(&s.env, &s.debt_token, &s.lender, 500);
        let before = market_state(&s);
        let zero = BytesN::from_array(&s.env, &[0u8; 32]);

        assert_eq!(
            s.pair.try_supply_with_id(&s.lender, &100, &zero),
            Err(Ok(IsolatedLendingError::InvalidOperationId))
        );
        assert_eq!(
            s.pair.try_supply_with_id(&s.lender, &0, &op_id(&s.env, 8)),
            Err(Ok(IsolatedLendingError::InvalidAmount))
        );
        assert_eq!(
            s.pair.try_supply_with_id(&s.lender, &-5, &op_id(&s.env, 8)),
            Err(Ok(IsolatedLendingError::InvalidAmount))
        );

        assert_eq!(market_state(&s), before);
        assert_eq!(s.pair.get_operation(&s.lender, &zero), None);
        assert_eq!(s.pair.get_operation(&s.lender, &op_id(&s.env, 8)), None);
    }

    #[test]
    fn uninitialized_pair_rejects_idempotent_calls() {
        let env = Env::default();
        env.mock_all_auths();
        let pair = IsolatedLendingPairClient::new(&env, &env.register(IsolatedLendingPair, ()));
        let user = Address::generate(&env);
        assert_eq!(
            pair.try_supply_with_id(&user, &1, &op_id(&env, 1)),
            Err(Ok(IsolatedLendingError::NotInitialized))
        );
    }

    #[test]
    fn failed_execution_leaves_state_and_the_id_untouched() {
        let s = setup();
        let id = op_id(&s.env, 9);
        let before = market_state(&s);

        // Borrow limit is 80 and the borrower already owes 80.
        assert_eq!(
            s.pair.try_borrow_with_id(&s.borrower, &1, &s.fp(), &id),
            Err(Ok(IsolatedLendingError::InsufficientCollateral))
        );
        // Withdrawing more than redeemable cash fails late, after validation
        // of the amount and supply.
        assert_eq!(
            s.pair
                .try_withdraw_with_id(&s.lender, &1_000, &op_id(&s.env, 10)),
            Err(Ok(IsolatedLendingError::InsufficientLiquidity))
        );

        assert_eq!(market_state(&s), before);
        assert_eq!(s.pair.get_operation(&s.borrower, &id), None);
        assert_eq!(s.pair.get_operation(&s.lender, &op_id(&s.env, 10)), None);

        // The failed id was not consumed: the corrected request can use it.
        mint(&s.env, &s.collateral_token, &s.borrower, 10);
        s.pair.post_collateral(&s.borrower, &10);
        let receipt = s.pair.borrow_with_id(&s.borrower, &8, &s.fp(), &id);
        assert_eq!(receipt.amount, 8);
        assert_eq!(s.pair.get_position(&s.borrower), (110, 88));
    }

    #[test]
    fn stale_fingerprint_does_not_consume_the_id() {
        let s = setup();
        mint(&s.env, &s.collateral_token, &s.borrower, 50);
        s.pair.post_collateral(&s.borrower, &50);
        let stale = s.fp();
        s.pair.set_reserve_bps(&s.admin, &100);
        let id = op_id(&s.env, 11);
        let before = market_state(&s);

        assert_eq!(
            s.pair.try_borrow_with_id(&s.borrower, &10, &stale, &id),
            Err(Ok(IsolatedLendingError::StaleConfig))
        );
        assert_eq!(market_state(&s), before);
        assert_eq!(s.pair.get_operation(&s.borrower, &id), None);

        s.pair.borrow_with_id(&s.borrower, &10, &s.fp(), &id);
        assert_eq!(s.pair.get_position(&s.borrower), (150, 90));
    }

    #[test]
    fn duplicate_borrow_cannot_double_debit_even_after_config_and_ledger_change() {
        let s = setup();
        mint(&s.env, &s.collateral_token, &s.borrower, 100);
        s.pair.post_collateral(&s.borrower, &100);
        let fp = s.fp();
        let id = op_id(&s.env, 12);
        let first = s.pair.borrow_with_id(&s.borrower, &40, &fp, &id);
        assert_eq!(s.pair.get_position(&s.borrower), (200, 120));
        assert_eq!(balance(&s.env, &s.debt_token, &s.borrower), 120);

        // The admin changes configuration and time passes before the wallet
        // retries with the fingerprint it originally used.
        s.pair.set_interest_rate(&s.admin, &1_000);
        s.env.ledger().with_mut(|l| l.sequence_number += 50);
        let accrual_marker = |s: &Setup| {
            s.env.as_contract(&s.pair.address, || {
                s.env
                    .storage()
                    .instance()
                    .get::<_, u32>(&PairDataKey::LastAccrualLedger)
            })
        };
        let marker_before = accrual_marker(&s);
        let before = market_state(&s);

        assert_eq!(s.pair.borrow_with_id(&s.borrower, &40, &fp, &id), first);

        // No funds moved, no debt was added, and the replay did not even
        // advance interest accrual.
        assert_eq!(market_state(&s), before);
        assert_eq!(accrual_marker(&s), marker_before);
        assert_eq!(balance(&s.env, &s.debt_token, &s.borrower), 120);
        // A *new* borrow with the old fingerprint is still rejected.
        assert_eq!(
            s.pair
                .try_borrow_with_id(&s.borrower, &1, &fp, &op_id(&s.env, 13)),
            Err(Ok(IsolatedLendingError::StaleConfig))
        );
    }

    #[test]
    fn duplicate_withdraw_is_replayed_even_when_a_fresh_one_would_fail() {
        let s = setup();
        let id = op_id(&s.env, 14);
        let first = s.pair.withdraw_with_id(&s.lender, &900, &id);
        assert_eq!(balance(&s.env, &s.debt_token, &s.lender), 900);
        let before = market_state(&s);

        // Only 20 units of cash remain, so re-executing would fail; the
        // replay deterministically returns the original receipt instead.
        assert_eq!(s.pair.withdraw_with_id(&s.lender, &900, &id), first);
        assert_eq!(market_state(&s), before);
        assert_eq!(before.lender_supply, 100);
        assert_eq!(before.pair_debt_cash, 20);
    }

    #[test]
    fn duplicate_collateral_operations_apply_once() {
        let s = setup();
        mint(&s.env, &s.collateral_token, &s.borrower, 60);
        let post = op_id(&s.env, 15);
        s.pair.post_collateral_with_id(&s.borrower, &60, &post);
        s.pair.post_collateral_with_id(&s.borrower, &60, &post);
        assert_eq!(s.pair.get_position(&s.borrower), (160, 80));
        assert_eq!(balance(&s.env, &s.collateral_token, &s.borrower), 0);

        let wd = op_id(&s.env, 16);
        let fp = s.fp();
        s.pair
            .withdraw_collateral_with_id(&s.borrower, &50, &fp, &wd);
        s.pair
            .withdraw_collateral_with_id(&s.borrower, &50, &fp, &wd);
        assert_eq!(s.pair.get_position(&s.borrower), (110, 80));
        assert_eq!(balance(&s.env, &s.collateral_token, &s.borrower), 50);
        assert_eq!(balance(&s.env, &s.collateral_token, &s.pair.address), 110);
    }

    #[test]
    fn duplicate_repayments_apply_once() {
        let s = setup();
        let id = op_id(&s.env, 17);
        let receipt = s.pair.repay_with_id(&s.borrower, &30, &id);
        assert_eq!(receipt.kind, symbol_short!("repay"));
        s.pair.repay_with_id(&s.borrower, &30, &id);
        assert_eq!(s.pair.get_position(&s.borrower), (100, 50));
        assert_eq!(s.pair.get_totals(), (1_000, 50));
        assert_eq!(balance(&s.env, &s.debt_token, &s.borrower), 50);

        let payer = Address::generate(&s.env);
        mint(&s.env, &s.debt_token, &payer, 100);
        let pid = op_id(&s.env, 18);
        let receipt = s.pair.repay_for_with_id(&payer, &s.borrower, &20, &pid);
        assert_eq!(receipt.account, payer);
        assert_eq!(receipt.beneficiary, s.borrower);
        s.pair.repay_for_with_id(&payer, &s.borrower, &20, &pid);
        assert_eq!(s.pair.get_position(&s.borrower), (100, 30));
        assert_eq!(balance(&s.env, &s.debt_token, &payer), 80);
        assert_eq!(s.pair.get_position(&payer), (0, 0));

        // Same payer id for a different borrower is a conflict, not a repayment.
        let other = Address::generate(&s.env);
        assert_eq!(
            s.pair.try_repay_for_with_id(&payer, &other, &20, &pid),
            Err(Ok(IsolatedLendingError::OperationConflict))
        );
        assert_eq!(balance(&s.env, &s.debt_token, &payer), 80);
    }

    #[test]
    fn duplicate_queue_withdrawal_does_not_double_reserve_liquidity() {
        let s = setup();
        let id = op_id(&s.env, 19);
        s.pair.queue_withdrawal_with_id(&s.lender, &300, &id);
        let after_first = market_state(&s);
        s.pair.queue_withdrawal_with_id(&s.lender, &300, &id);

        assert_eq!(market_state(&s), after_first);
        assert_eq!(after_first.pending, 300);
        assert_eq!(after_first.liquidity, 1_000 - 80 - 300);
    }

    #[test]
    fn plain_entry_points_remain_compatible_and_consume_no_ids() {
        let s = setup();
        mint(&s.env, &s.debt_token, &s.lender, 200);
        let id = op_id(&s.env, 20);
        s.pair.supply(&s.lender, &100);
        s.pair.supply(&s.lender, &100);
        // Plain calls keep their accumulate-on-every-call semantics.
        assert_eq!(s.pair.get_totals(), (1_200, 80));
        assert_eq!(s.pair.get_operation(&s.lender, &id), None);
        s.pair.repay(&s.borrower, &10);
        s.pair.repay(&s.borrower, &10);
        assert_eq!(s.pair.get_position(&s.borrower), (100, 60));
    }

    #[test]
    fn receipts_outlive_a_long_retry_window() {
        let s = setup();
        mint(&s.env, &s.debt_token, &s.lender, 100);
        let id = op_id(&s.env, 21);
        s.pair.supply_with_id(&s.lender, &100, &id);
        let ttl = s.env.as_contract(&s.pair.address, || {
            s.env
                .storage()
                .persistent()
                .get_ttl(&PairDataKey::Operation(s.lender.clone(), id.clone()))
        });
        assert!(ttl >= OPERATION_TTL_EXTEND_TO);
    }
}
