#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    xdr::ToXdr, Address, Bytes, BytesN, Env, String,
};

/// Domain separator for the configuration fingerprint (versioned).
const CONFIG_FINGERPRINT_DOMAIN: &[u8] = b"stellaryield_options_config_v1";

mod events;
mod math;
mod storage;
#[cfg(test)]
mod tests;

use events::{
    emit_cancelled, emit_config_updated, emit_created, emit_exercised, emit_expired, emit_filled,
};
use math::black_scholes_call;
use storage::{
    clear_oracle_max_age, has_admin, read_admin, read_cancelled, read_exercised_amount,
    read_free_collateral, read_option, read_option_counter, read_oracle, read_oracle_max_age,
    read_reserved_collateral, read_settlement_sequence, read_storage_version, release_reserved,
    write_admin, write_cancelled, write_exercised_amount, write_free_collateral, write_option,
    write_option_counter, write_oracle, write_oracle_max_age, write_reserved_collateral,
    write_settlement_sequence, write_storage_version, OptionData, OptionType,
    CURRENT_STORAGE_VERSION,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum OptionsError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidOption = 4,
    NotExpired = 5,
    AlreadyExercised = 6,
    AlreadyExpired = 7,
    ZeroAmount = 8,
    InvalidPrice = 9,
    /// Exercise attempted before the option's opening_time.
    TooEarly = 10,
    /// Exercise attempted after the option's expiration_time.
    ExerciseWindowClosed = 11,
    /// opening_time must be strictly before expiration_time.
    InvalidExerciseWindow = 12,
    /// Withdrawal exceeds the owner's free (unreserved) collateral.
    InsufficientFreeCollateral = 13,
    /// Partial exercise amount exceeds the collateral still backing the option.
    ExceedsCollateral = 14,
    /// Collateral accounting overflowed.
    MathOverflow = 15,
    /// The oracle has no observation for an asset the option depends on.
    OracleObservationMissing = 16,
    /// The oracle's latest observation is older than the configured maximum age.
    StaleOracleObservation = 17,
    /// The oracle guard max age must be greater than zero.
    InvalidMaxAge = 18,
    /// Cancellation was attempted after the option's expiration time.
    CancellationWindowClosed = 19,
    /// The option has already been cancelled.
    AlreadyCancelled = 20,
    /// The configuration changed since the caller captured its fingerprint.
    /// Refresh with `get_config_fingerprint` and retry settlement.
    StaleConfig = 21,
    /// The option's settlement progress no longer matches what the caller
    /// expected, so a retried settlement was refused instead of paying twice.
    SettlementStateChanged = 22,
    /// The option changed after the caller read it; retry with its new sequence.
    ConcurrentModification = 23,
    /// A token callback attempted to re-enter settlement for the same option.
    ReentrantSettlement = 24,
}

/// Price source consulted when the oracle guard is enabled. `get_price`
/// returns the latest `(price, observed_at)` for an asset, or `None` when the
/// oracle has no observation for it.
#[contractclient(name = "OracleClient")]
#[allow(dead_code)]
pub trait OracleInterface {
    fn get_price(env: Env, asset: Address) -> Option<(i128, u64)>;
}

/// Immutable snapshot of the admin-controlled configuration that shapes
/// settlement.
///
/// Only configuration is included: option records, balances and oracle quotes
/// change continuously and must not invalidate a caller's snapshot. Two
/// deployments with identical configuration produce identical snapshots, and
/// any admin change produces a different one.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigSnapshot {
    pub admin: Address,
    pub oracle: Address,
    /// Oracle freshness guard in seconds, or `None` when the guard is off.
    pub oracle_max_age: Option<u64>,
    /// Active storage layout version.
    pub storage_version: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollateralHealth {
    /// Collateral currently locked behind this position.
    pub reserved: i128,
    /// Outstanding obligation still backed by the position.
    pub remaining_obligation: i128,
    /// Whether the position is still open (active).
    pub active: bool,
    /// Whether the position has been exercised.
    pub exercised: bool,
    /// Whether the position has expired.
    pub expired: bool,
}

/// Where an option sits in its settlement lifecycle.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettlementStatus {
    /// Open with nothing exercised yet.
    Open,
    /// Open with part of the collateral already paid out.
    PartiallyExercised,
    /// Fully exercised; nothing remains to settle.
    Exercised,
    /// Expired; the unexercised collateral was returned to the minter.
    Expired,
    /// Cancelled; the unexercised collateral was returned to the minter.
    Cancelled,
}

/// Persisted settlement progress of an option. After an operation fails or its
/// outcome is unknown, `exercised_amount` is the exact point to resume from
/// (pass it as `expected_exercised` to `exercise_partial_checked`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementState {
    pub status: SettlementStatus,
    /// Collateral already paid out to exercisers.
    pub exercised_amount: i128,
    /// Collateral still backing the option (zero once it is closed).
    pub remaining_amount: i128,
}

/// Stage of the settlement pipeline where a failure was diagnosed. The stage
/// identifies *where* in the settlement flow an error occurred so callers and
/// off-chain monitors can determine the correct remediation without inspecting
/// private data (addresses, amounts, or asset identifiers).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum SettlementStage {
    /// Configuration fingerprint or oracle guard check.
    ConfigValidation = 1,
    /// Cancelled / exercised / expired or authorization check.
    StatusCheck = 2,
    /// Settlement sequence or reentrancy guard.
    ConcurrencyCheck = 3,
    /// Opening / expiration time-window check.
    TimeWindowCheck = 4,
    /// Amount, collateral, or arithmetic validation.
    AmountValidation = 5,
    /// State commit before the token transfer.
    StateCommit = 6,
    /// Token transfer leg.
    Transfer = 7,
    /// Post-transfer finalization.
    Finalize = 8,
}

/// Privacy-safe diagnostic for a settlement failure (#1751).
///
/// Contains no addresses, amounts, or asset identifiers — only the option id,
/// the stage that most likely failed, the error code, and a generic
/// remediation hint the caller can follow to retry safely. Callers obtain this
/// from [`OptionsContract::get_settlement_diagnostic`] after a settlement call
/// returns an error.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementDiagnostic {
    pub option_id: u32,
    pub stage: SettlementStage,
    /// Numeric [`OptionsError`] code (the `u32` discriminant).
    pub error_code: u32,
    /// Generic, privacy-safe remediation guidance.
    pub remediation: String,
}

#[contract]
pub struct OptionsContract;

#[contractimpl]
impl OptionsContract {
    pub fn initialize(env: Env, admin: Address, oracle: Address) -> Result<(), OptionsError> {
        if has_admin(&env) {
            return Err(OptionsError::AlreadyInitialized);
        }
        write_admin(&env, &admin);
        write_oracle(&env, &oracle);
        Ok(())
    }

    /// Marks the current storage layout version. Existing option records stay
    /// under the same persistent keys and remain readable without rewriting.
    pub fn migrate(env: Env) -> Result<(), OptionsError> {
        if !has_admin(&env) {
            return Err(OptionsError::NotInitialized);
        }
        let admin = read_admin(&env);
        admin.require_auth();

        if read_storage_version(&env) < CURRENT_STORAGE_VERSION {
            write_storage_version(&env, CURRENT_STORAGE_VERSION);
            publish_config_update(&env, &admin);
        }
        Ok(())
    }

    /// Enables the oracle guard: `mint` then requires a fresh observation from
    /// the configured oracle for every asset the option depends on. Admin only.
    /// Until set, `mint` does not consult the oracle.
    pub fn set_oracle_max_age(env: Env, max_age: u64) -> Result<(), OptionsError> {
        if !has_admin(&env) {
            return Err(OptionsError::NotInitialized);
        }
        read_admin(&env).require_auth();
        if max_age == 0 {
            return Err(OptionsError::InvalidMaxAge);
        }
        let admin = read_admin(&env);
        write_oracle_max_age(&env, max_age);
        publish_config_update(&env, &admin);
        Ok(())
    }

    /// Disables the oracle guard. Admin only.
    pub fn clear_oracle_max_age(env: Env) -> Result<(), OptionsError> {
        if !has_admin(&env) {
            return Err(OptionsError::NotInitialized);
        }
        let admin = read_admin(&env);
        admin.require_auth();
        clear_oracle_max_age(&env);
        publish_config_update(&env, &admin);
        Ok(())
    }

    /// Maximum accepted observation age, or `None` when the guard is off.
    pub fn get_oracle_max_age(env: Env) -> Option<u64> {
        read_oracle_max_age(&env)
    }

    /// Current admin-controlled configuration that settlement depends on.
    pub fn get_config_snapshot(env: Env) -> Result<ConfigSnapshot, OptionsError> {
        if !has_admin(&env) {
            return Err(OptionsError::NotInitialized);
        }
        Ok(config_snapshot(&env))
    }

    /// SHA-256 fingerprint of [`Self::get_config_snapshot`].
    ///
    /// Callers capture this before preparing a settlement and pass it to
    /// `exercise` or `exercise_partial`. If any configuration changes in
    /// between, the fingerprint no longer matches and settlement fails with
    /// `StaleConfig` before any collateral moves, so the caller can refresh and
    /// retry under terms it has actually seen.
    pub fn get_config_fingerprint(env: Env) -> Result<BytesN<32>, OptionsError> {
        if !has_admin(&env) {
            return Err(OptionsError::NotInitialized);
        }
        Ok(config_fingerprint(&env))
    }

    pub fn mint(
        env: Env,
        minter: Address,
        option_type: OptionType,
        underlying_asset: Address,
        quote_asset: Address,
        strike_price: i128,
        opening_time: u64,
        expiration_time: u64,
        collateral_amount: i128,
    ) -> Result<u32, OptionsError> {
        minter.require_auth();
        if !has_admin(&env) {
            return Err(OptionsError::NotInitialized);
        }
        if collateral_amount <= 0 {
            return Err(OptionsError::ZeroAmount);
        }
        // opening_time must be strictly before expiration_time
        if opening_time >= expiration_time {
            return Err(OptionsError::InvalidExerciseWindow);
        }

        let collateral_asset = match option_type {
            OptionType::Call => underlying_asset.clone(),
            OptionType::Put => quote_asset.clone(),
        };

        // Price the option and its collateral only from fresh oracle data.
        if let Some(max_age) = read_oracle_max_age(&env) {
            require_fresh_observation(&env, &underlying_asset, max_age)?;
            if collateral_asset != underlying_asset {
                require_fresh_observation(&env, &collateral_asset, max_age)?;
            }
        }

        // Back the position with the minter's free (deposited) collateral first and
        // pull only the shortfall from their wallet. Either way the full amount is
        // reserved, so it can no longer be withdrawn while the option is open.
        let free = read_free_collateral(&env, &minter, &collateral_asset);
        let from_free = free.min(collateral_amount);
        let shortfall = collateral_amount - from_free;
        if shortfall > 0 {
            let client = token::Client::new(&env, &collateral_asset);
            client.transfer(&minter, &env.current_contract_address(), &shortfall);
        }
        if from_free > 0 {
            write_free_collateral(&env, &minter, &collateral_asset, free - from_free);
        }
        let reserved = read_reserved_collateral(&env, &minter, &collateral_asset);
        let new_reserved = reserved
            .checked_add(collateral_amount)
            .ok_or(OptionsError::MathOverflow)?;
        write_reserved_collateral(&env, &minter, &collateral_asset, new_reserved);

        let mut counter = read_option_counter(&env);
        counter += 1;

        let option_data = OptionData {
            minter: minter.clone(),
            option_type,
            underlying_asset,
            quote_asset,
            strike_price,
            opening_time,
            expiration_time,
            collateral_amount,
            exercised: false,
            expired: false,
        };

        write_option(&env, counter, &option_data);
        write_option_counter(&env, counter);
        write_settlement_sequence(&env, counter, 1);

        emit_created(&env, counter, &option_data);

        Ok(counter)
    }

    /// Exercises the whole option with a configuration fingerprint.
    pub fn exercise(
        env: Env,
        exerciser: Address,
        option_id: u32,
        expected_config_fingerprint: BytesN<32>,
    ) -> Result<(), OptionsError> {
        let expected_sequence = read_settlement_sequence(&env, option_id);
        Self::exercise_with_sequence(
            env,
            exerciser,
            option_id,
            expected_sequence,
            expected_config_fingerprint,
        )
    }

    /// Exercises with both configuration and optimistic-concurrency checks.
    pub fn exercise_with_sequence(
        env: Env,
        exerciser: Address,
        option_id: u32,
        expected_sequence: u64,
        expected_config_fingerprint: BytesN<32>,
    ) -> Result<(), OptionsError> {
        exerciser.require_auth();
        let option = read_option(&env, option_id);
        Self::settle(
            &env,
            exerciser,
            option_id,
            expected_sequence,
            option,
            None,
            &expected_config_fingerprint,
        )
    }

    /// Exercises `amount` of the option's collateral, validating configuration
    /// and the settlement sequence before any collateral moves.
    pub fn exercise_partial(
        env: Env,
        exerciser: Address,
        option_id: u32,
        amount: i128,
        expected_config_fingerprint: BytesN<32>,
    ) -> Result<(), OptionsError> {
        let expected_sequence = read_settlement_sequence(&env, option_id);
        Self::exercise_partial_with_sequence(
            env,
            exerciser,
            option_id,
            amount,
            expected_sequence,
            expected_config_fingerprint,
        )
    }

    pub fn exercise_partial_with_sequence(
        env: Env,
        exerciser: Address,
        option_id: u32,
        amount: i128,
        expected_sequence: u64,
        expected_config_fingerprint: BytesN<32>,
    ) -> Result<(), OptionsError> {
        exerciser.require_auth();
        let option = read_option(&env, option_id);
        Self::settle(
            &env,
            exerciser,
            option_id,
            expected_sequence,
            option,
            Some(amount),
            &expected_config_fingerprint,
        )
    }

    /// Retry-safe partial exercise. A stale sequence, configuration, or
    /// exercised amount refuses the retry before it can pay out twice.
    pub fn exercise_partial_checked(
        env: Env,
        exerciser: Address,
        option_id: u32,
        amount: i128,
        expected_exercised: i128,
        expected_sequence: u64,
        expected_config_fingerprint: BytesN<32>,
    ) -> Result<(), OptionsError> {
        exerciser.require_auth();
        let option = read_option(&env, option_id);
        if read_exercised_amount(&env, option_id) != expected_exercised {
            return Err(OptionsError::SettlementStateChanged);
        }
        Self::settle(
            &env,
            exerciser,
            option_id,
            expected_sequence,
            option,
            Some(amount),
            &expected_config_fingerprint,
        )
    }

    /// Settlement progress of an option, without mutating any state.
    pub fn get_settlement_state(env: Env, option_id: u32) -> SettlementState {
        let option = read_option(&env, option_id);
        let exercised_amount = read_exercised_amount(&env, option_id);
        let open_remaining = (option.collateral_amount - exercised_amount).max(0);
        let (status, remaining_amount) = if read_cancelled(&env, option_id) {
            (SettlementStatus::Cancelled, 0)
        } else if option.expired {
            (SettlementStatus::Expired, 0)
        } else if option.exercised {
            (SettlementStatus::Exercised, 0)
        } else if exercised_amount > 0 {
            (SettlementStatus::PartiallyExercised, open_remaining)
        } else {
            (SettlementStatus::Open, open_remaining)
        };
        SettlementState {
            status,
            exercised_amount,
            remaining_amount,
        }
    }

    /// Privacy-safe diagnostic for a settlement failure (#1751).
    ///
    /// After a settlement call (`exercise`, `exercise_partial`,
    /// `exercise_partial_checked`, `cancel`, or `expire`) returns an error,
    /// call this with the `option_id` and the error code to obtain a
    /// [`SettlementDiagnostic`] that identifies the stage that most likely
    /// failed and a generic remediation path.
    ///
    /// The diagnostic is privacy-safe: it contains no addresses, amounts, or
    /// asset identifiers — only the option id, the stage, the error code, and
    /// a short remediation string. State and balances are never mutated by
    /// this read-only function.
    pub fn get_settlement_diagnostic(
        env: Env,
        option_id: u32,
        error: OptionsError,
    ) -> SettlementDiagnostic {
        let stage = diagnose_stage(error);
        let remediation = remediation_text(&env, error);
        SettlementDiagnostic {
            option_id,
            stage,
            error_code: error as u32,
            remediation,
        }
    }

    /// Cancels an unexpired option and returns only its unexercised collateral
    /// to the minter. The minter must authorize the cancellation.
    /// Compatibility wrapper. New callers should use `cancel_with_sequence`.
    pub fn cancel(env: Env, minter: Address, option_id: u32) -> Result<(), OptionsError> {
        let expected_sequence = read_settlement_sequence(&env, option_id);
        Self::cancel_with_sequence(env, minter, option_id, expected_sequence)
    }

    pub fn cancel_with_sequence(
        env: Env,
        minter: Address,
        option_id: u32,
        expected_sequence: u64,
    ) -> Result<(), OptionsError> {
        minter.require_auth();
        let option = read_option(&env, option_id);

        if option.minter != minter {
            return Err(OptionsError::Unauthorized);
        }
        if read_cancelled(&env, option_id) {
            return Err(OptionsError::AlreadyCancelled);
        }
        if option.exercised {
            return Err(OptionsError::AlreadyExercised);
        }
        if option.expired {
            return Err(OptionsError::AlreadyExpired);
        }
        if env.ledger().timestamp() > option.expiration_time {
            return Err(OptionsError::CancellationWindowClosed);
        }
        Self::begin_settlement(&env, option_id, expected_sequence)?;

        let collateral_asset = match option.option_type {
            OptionType::Call => option.underlying_asset.clone(),
            OptionType::Put => option.quote_asset.clone(),
        };
        let exercised_amount = read_exercised_amount(&env, option_id);
        let remaining = option.collateral_amount - exercised_amount;

        // Commit state before the token leg; a failed transfer reverts all of it.
        release_reserved(&env, &minter, &collateral_asset, remaining);
        write_cancelled(&env, option_id);
        Self::advance_settlement(&env, option_id)?;
        token::Client::new(&env, &collateral_asset).transfer(
            &env.current_contract_address(),
            &minter,
            &remaining,
        );
        emit_cancelled(&env, option_id, &option, remaining, exercised_amount);
        Self::end_settlement(&env, option_id);

        Ok(())
    }

    /// Compatibility wrapper. New callers should use `expire_with_sequence`.
    pub fn expire(env: Env, option_id: u32) -> Result<(), OptionsError> {
        let expected_sequence = read_settlement_sequence(&env, option_id);
        Self::expire_with_sequence(env, option_id, expected_sequence)
    }

    pub fn expire_with_sequence(
        env: Env,
        option_id: u32,
        expected_sequence: u64,
    ) -> Result<(), OptionsError> {
        let mut option = read_option(&env, option_id);

        if read_cancelled(&env, option_id) {
            return Err(OptionsError::AlreadyCancelled);
        }
        if option.exercised || option.expired {
            return Err(OptionsError::AlreadyExpired);
        }

        let current_time = env.ledger().timestamp();
        // Expire is only callable after the exercise window closes
        if current_time <= option.expiration_time {
            return Err(OptionsError::NotExpired);
        }
        Self::begin_settlement(&env, option_id, expected_sequence)?;

        let collateral_asset = match option.option_type {
            OptionType::Call => option.underlying_asset.clone(),
            OptionType::Put => option.quote_asset.clone(),
        };

        // Only what partial exercises have not already paid out is still held.
        let exercised_amount = read_exercised_amount(&env, option_id);
        let remaining = option.collateral_amount - exercised_amount;

        // Commit state before the token leg; a failed transfer reverts all of it.
        release_reserved(&env, &option.minter, &collateral_asset, remaining);
        option.expired = true;
        write_option(&env, option_id, &option);
        Self::advance_settlement(&env, option_id)?;

        let client = token::Client::new(&env, &collateral_asset);
        client.transfer(&env.current_contract_address(), &option.minter, &remaining);

        emit_expired(&env, option_id, &option, remaining, exercised_amount);
        Self::end_settlement(&env, option_id);

        Ok(())
    }

    /// Deposits `amount` of `asset` as free collateral. Free collateral can be
    /// withdrawn at any time and is used first when minting.
    pub fn deposit(
        env: Env,
        owner: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), OptionsError> {
        owner.require_auth();
        if !has_admin(&env) {
            return Err(OptionsError::NotInitialized);
        }
        if amount <= 0 {
            return Err(OptionsError::ZeroAmount);
        }
        let free = read_free_collateral(&env, &owner, &asset);
        let new_free = free.checked_add(amount).ok_or(OptionsError::MathOverflow)?;

        token::Client::new(&env, &asset).transfer(&owner, &env.current_contract_address(), &amount);
        write_free_collateral(&env, &owner, &asset, new_free);

        env.events()
            .publish((symbol_short!("deposit"), owner), (asset, amount));
        Ok(())
    }

    /// Withdraws `amount` of free collateral. Collateral reserved behind open
    /// option positions is never withdrawable, so a withdrawal that would leave
    /// open contracts undercollateralized is rejected.
    pub fn withdraw(
        env: Env,
        owner: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), OptionsError> {
        owner.require_auth();
        if !has_admin(&env) {
            return Err(OptionsError::NotInitialized);
        }
        if amount <= 0 {
            return Err(OptionsError::ZeroAmount);
        }
        let free = read_free_collateral(&env, &owner, &asset);
        if amount > free {
            return Err(OptionsError::InsufficientFreeCollateral);
        }
        write_free_collateral(&env, &owner, &asset, free - amount);

        token::Client::new(&env, &asset).transfer(&env.current_contract_address(), &owner, &amount);

        env.events()
            .publish((symbol_short!("withdraw"), owner), (asset, amount));
        Ok(())
    }

    /// Collateral `owner` can withdraw right now.
    pub fn get_free_collateral(env: Env, owner: Address, asset: Address) -> i128 {
        read_free_collateral(&env, &owner, &asset)
    }

    /// Collateral `owner` has locked behind open option positions.
    pub fn get_reserved_collateral(env: Env, owner: Address, asset: Address) -> i128 {
        read_reserved_collateral(&env, &owner, &asset)
    }

    /// Returns the collateral health of a single option position without
    /// mutating any state. Reserved collateral is the amount still locked behind
    /// the position, the remaining obligation is what is still owed by the
    /// position, and coverage is the ratio of reserved collateral to the
    /// remaining obligation (scaled by 10_000_000).
    pub fn get_option_collateral_health(env: Env, option_id: u32) -> CollateralHealth {
        let option = read_option(&env, option_id);
        let exercised = read_exercised_amount(&env, option_id);
        let mut remaining_obligation = option.collateral_amount - exercised;
        if remaining_obligation < 0 {
            remaining_obligation = 0;
        }

        // Once exercised or expired, the position is closed and no collateral
        // remains reserved behind it.
        let active = !option.exercised && !option.expired && !read_cancelled(&env, option_id);
        let reserved = if active { remaining_obligation } else { 0 };

        CollateralHealth {
            reserved,
            remaining_obligation,
            active,
            exercised: option.exercised,
            expired: option.expired,
        }
    }

    /// Returns the optimistic-concurrency sequence for settlement operations.
    pub fn get_settlement_sequence(env: Env, option_id: u32) -> u64 {
        read_settlement_sequence(&env, option_id)
    }

    pub fn get_premium(
        env: Env,
        spot: i128,
        strike: i128,
        time_to_expiry_years: i128,
        iv: i128,
    ) -> i128 {
        black_scholes_call(&env, spot, strike, time_to_expiry_years, iv)
    }
}

impl OptionsContract {
    /// Shared exercise path. `amount` of `None` exercises the full remaining
    /// collateral. Exercised collateral leaves the contract, so its reserve is
    /// released; any remainder stays reserved.
    fn settle(
        env: &Env,
        exerciser: Address,
        option_id: u32,
        expected_sequence: u64,
        mut option: OptionData,
        amount: Option<i128>,
        expected_config_fingerprint: &BytesN<32>,
    ) -> Result<(), OptionsError> {
        // Reject a stale configuration snapshot before validating the position
        // or moving any collateral: the caller prepares settlement under terms
        // it has seen, and a mismatch means those terms no longer hold.
        require_config(env, expected_config_fingerprint)?;

        if read_cancelled(env, option_id) {
            return Err(OptionsError::AlreadyCancelled);
        }
        // Guard: prevent double-exercise (repeated exercise cannot pay twice)
        if option.exercised {
            return Err(OptionsError::AlreadyExercised);
        }
        // Guard: expired options can no longer be exercised
        if option.expired {
            return Err(OptionsError::AlreadyExpired);
        }
        Self::begin_settlement(env, option_id, expected_sequence)?;

        let current_time = env.ledger().timestamp();
        if current_time < option.opening_time {
            return Err(OptionsError::TooEarly);
        }
        if current_time > option.expiration_time {
            return Err(OptionsError::ExerciseWindowClosed);
        }

        let already_exercised = read_exercised_amount(env, option_id);
        let remaining = option.collateral_amount - already_exercised;
        let to_exercise = match amount {
            None => remaining,
            Some(a) => a,
        };
        if to_exercise <= 0 {
            return Err(OptionsError::ZeroAmount);
        }
        if to_exercise > remaining {
            return Err(OptionsError::ExceedsCollateral);
        }

        let collateral_asset = match option.option_type {
            OptionType::Call => option.underlying_asset.clone(),
            OptionType::Put => option.quote_asset.clone(),
        };

        // Validate arithmetic before touching any state or moving funds.
        let new_exercised = already_exercised
            .checked_add(to_exercise)
            .ok_or(OptionsError::MathOverflow)?;
        let fully_exercised = new_exercised >= option.collateral_amount;

        // Commit state first, then pay out. A failed transfer reverts the whole
        // call, leaving balances, reserve, and progress exactly as they were.
        release_reserved(env, &option.minter, &collateral_asset, to_exercise);
        write_exercised_amount(env, option_id, new_exercised);
        Self::advance_settlement(env, option_id)?;
        if fully_exercised {
            option.exercised = true;
            write_option(env, option_id, &option);
        }

        token::Client::new(env, &collateral_asset).transfer(
            &env.current_contract_address(),
            &exerciser,
            &to_exercise,
        );

        if fully_exercised {
            emit_exercised(
                env,
                option_id,
                &option,
                exerciser,
                to_exercise,
                new_exercised,
            );
        } else {
            emit_filled(
                env,
                option_id,
                &option,
                exerciser,
                to_exercise,
                new_exercised,
            );
        }

        Self::end_settlement(env, option_id);

        Ok(())
    }

    fn begin_settlement(
        env: &Env,
        option_id: u32,
        expected_sequence: u64,
    ) -> Result<(), OptionsError> {
        if env
            .storage()
            .temporary()
            .get(&storage::DataKey::SettlementLock(option_id))
            .unwrap_or(false)
        {
            return Err(OptionsError::ReentrantSettlement);
        }
        if read_settlement_sequence(env, option_id) != expected_sequence {
            return Err(OptionsError::ConcurrentModification);
        }
        env.storage()
            .temporary()
            .set(&storage::DataKey::SettlementLock(option_id), &true);
        Ok(())
    }

    fn end_settlement(env: &Env, option_id: u32) {
        env.storage()
            .temporary()
            .set(&storage::DataKey::SettlementLock(option_id), &false);
    }

    fn advance_settlement(env: &Env, option_id: u32) -> Result<(), OptionsError> {
        let next = read_settlement_sequence(env, option_id)
            .checked_add(1)
            .ok_or(OptionsError::MathOverflow)?;
        write_settlement_sequence(env, option_id, next);
        Ok(())
    }
}

/// Read the configuration settlement depends on, applying the same defaults
/// the execution paths use.
fn config_snapshot(env: &Env) -> ConfigSnapshot {
    ConfigSnapshot {
        admin: read_admin(env),
        oracle: read_oracle(env),
        oracle_max_age: read_oracle_max_age(env),
        storage_version: read_storage_version(env),
    }
}

/// Deterministic SHA-256 fingerprint of the current configuration.
fn config_fingerprint(env: &Env) -> BytesN<32> {
    let mut preimage = Bytes::from_slice(env, CONFIG_FINGERPRINT_DOMAIN);
    preimage.append(&config_snapshot(env).to_xdr(env));
    env.crypto().sha256(&preimage).to_bytes()
}

/// Reject settlement whose caller observed a different configuration.
fn require_config(env: &Env, expected: &BytesN<32>) -> Result<(), OptionsError> {
    if config_fingerprint(env) != *expected {
        return Err(OptionsError::StaleConfig);
    }
    Ok(())
}

/// Announce the new configuration fingerprint after an admin change.
fn publish_config_update(env: &Env, admin: &Address) {
    emit_config_updated(env, admin, &config_fingerprint(env));
}

/// Requires the configured oracle to hold a valid, recent observation for
/// `asset`. The observation must exist, carry a positive price, and be
/// timestamped no later than now and no more than `max_age` seconds ago.
fn require_fresh_observation(env: &Env, asset: &Address, max_age: u64) -> Result<(), OptionsError> {
    let oracle = read_oracle(env);
    let (price, observed_at) = OracleClient::new(env, &oracle)
        .get_price(asset)
        .ok_or(OptionsError::OracleObservationMissing)?;

    let now = env.ledger().timestamp();
    if price <= 0 || observed_at == 0 || observed_at > now {
        return Err(OptionsError::InvalidPrice);
    }
    if now - observed_at > max_age {
        return Err(OptionsError::StaleOracleObservation);
    }
    Ok(())
}

/// Maps a settlement [`OptionsError`] to the [`SettlementStage`] where it most
/// likely occurred. The mapping is deterministic and based solely on the error
/// code — it does not read private data.
fn diagnose_stage(error: OptionsError) -> SettlementStage {
    match error {
        // Configuration and oracle-guard checks happen before any position
        // validation or collateral movement.
        OptionsError::StaleConfig
        | OptionsError::NotInitialized
        | OptionsError::AlreadyInitialized
        | OptionsError::InvalidMaxAge
        | OptionsError::OracleObservationMissing
        | OptionsError::StaleOracleObservation
        | OptionsError::InvalidPrice => SettlementStage::ConfigValidation,

        // Status and authorization checks (cancelled / exercised / expired /
        // unauthorized) happen after config validation but before the
        // concurrency lock.
        OptionsError::Unauthorized
        | OptionsError::InvalidOption
        | OptionsError::AlreadyExercised
        | OptionsError::AlreadyExpired
        | OptionsError::AlreadyCancelled => SettlementStage::StatusCheck,

        // Concurrency checks (sequence mismatch, reentrancy guard,
        // settlement-state-changed) happen inside begin_settlement / checked.
        OptionsError::ConcurrentModification
        | OptionsError::ReentrantSettlement
        | OptionsError::SettlementStateChanged => SettlementStage::ConcurrencyCheck,

        // Time-window checks happen after the concurrency lock is acquired.
        OptionsError::TooEarly
        | OptionsError::ExerciseWindowClosed
        | OptionsError::NotExpired
        | OptionsError::CancellationWindowClosed => SettlementStage::TimeWindowCheck,

        // Amount, collateral, and arithmetic validation happens after the
        // time-window check but before any state is committed.
        OptionsError::ZeroAmount
        | OptionsError::ExceedsCollateral
        | OptionsError::InsufficientFreeCollateral
        | OptionsError::MathOverflow
        | OptionsError::InvalidExerciseWindow => SettlementStage::AmountValidation,
    }
}

/// Returns a short, privacy-safe remediation string for a settlement error.
/// The string contains no addresses, amounts, or asset identifiers — only a
/// generic action the caller can take to fix the issue and retry safely.
fn remediation_text(env: &Env, error: OptionsError) -> String {
    match error {
        OptionsError::AlreadyInitialized => String::from_str(env, "Contract already initialized"),
        OptionsError::NotInitialized => {
            String::from_str(env, "Call initialize() before settlement")
        }
        OptionsError::Unauthorized => {
            String::from_str(env, "Caller is not authorized for this operation")
        }
        OptionsError::InvalidOption => String::from_str(env, "Option id does not exist"),
        OptionsError::NotExpired => {
            String::from_str(env, "Wait until after expiration_time then call expire()")
        }
        OptionsError::AlreadyExercised => String::from_str(
            env,
            "Option fully exercised; no further settlement possible",
        ),
        OptionsError::AlreadyExpired => String::from_str(
            env,
            "Option already expired; no further settlement possible",
        ),
        OptionsError::ZeroAmount => String::from_str(env, "Provide a positive exercise amount"),
        OptionsError::InvalidPrice => {
            String::from_str(env, "Oracle returned invalid price; fix oracle and retry")
        }
        OptionsError::TooEarly => String::from_str(env, "Wait until opening_time to exercise"),
        OptionsError::ExerciseWindowClosed => String::from_str(
            env,
            "Exercise window closed; call expire() to return collateral",
        ),
        OptionsError::InvalidExerciseWindow => {
            String::from_str(env, "opening_time must be strictly before expiration_time")
        }
        OptionsError::InsufficientFreeCollateral => {
            String::from_str(env, "Deposit more collateral or reduce withdrawal amount")
        }
        OptionsError::ExceedsCollateral => {
            String::from_str(env, "Reduce amount to at most remaining collateral")
        }
        OptionsError::MathOverflow => String::from_str(env, "Amount too large; reduce and retry"),
        OptionsError::OracleObservationMissing => {
            String::from_str(env, "Oracle has no observation; provide one and retry")
        }
        OptionsError::StaleOracleObservation => {
            String::from_str(env, "Oracle observation is stale; update and retry")
        }
        OptionsError::InvalidMaxAge => {
            String::from_str(env, "Oracle max age must be greater than zero")
        }
        OptionsError::CancellationWindowClosed => {
            String::from_str(env, "Cancellation window closed; call expire() instead")
        }
        OptionsError::AlreadyCancelled => {
            String::from_str(env, "Option cancelled; no further settlement possible")
        }
        OptionsError::StaleConfig => String::from_str(
            env,
            "Refresh fingerprint with get_config_fingerprint() and retry",
        ),
        OptionsError::SettlementStateChanged => String::from_str(
            env,
            "Read get_settlement_state() and resume from new exercised_amount",
        ),
        OptionsError::ConcurrentModification => String::from_str(
            env,
            "Read get_settlement_sequence() and retry with new value",
        ),
        OptionsError::ReentrantSettlement => {
            String::from_str(env, "Settlement in progress; wait and retry")
        }
    }
}
