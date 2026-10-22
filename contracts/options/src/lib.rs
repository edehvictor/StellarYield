#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, Env,
};

mod events;
mod math;
mod storage;
#[cfg(test)]
mod tests;

use events::{emit_cancelled, emit_created, emit_exercised, emit_expired, emit_filled};
use math::black_scholes_call;
use storage::{
    clear_oracle_max_age, has_admin, read_admin, read_cancelled, read_exercised_amount,
    read_free_collateral, read_option, read_option_counter, read_oracle, read_oracle_max_age,
    read_reserved_collateral, read_storage_version, release_reserved, write_admin, write_cancelled,
    write_exercised_amount, write_free_collateral, write_option, write_option_counter,
    write_oracle, write_oracle_max_age, write_reserved_collateral, write_storage_version,
    OptionData, OptionType, CURRENT_STORAGE_VERSION,
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
}

/// Price source consulted when the oracle guard is enabled. `get_price`
/// returns the latest `(price, observed_at)` for an asset, or `None` when the
/// oracle has no observation for it.
#[contractclient(name = "OracleClient")]
#[allow(dead_code)]
pub trait OracleInterface {
    fn get_price(env: Env, asset: Address) -> Option<(i128, u64)>;
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
        write_oracle_max_age(&env, max_age);
        Ok(())
    }

    /// Disables the oracle guard. Admin only.
    pub fn clear_oracle_max_age(env: Env) -> Result<(), OptionsError> {
        if !has_admin(&env) {
            return Err(OptionsError::NotInitialized);
        }
        read_admin(&env).require_auth();
        clear_oracle_max_age(&env);
        Ok(())
    }

    /// Maximum accepted observation age, or `None` when the guard is off.
    pub fn get_oracle_max_age(env: Env) -> Option<u64> {
        read_oracle_max_age(&env)
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

        emit_created(&env, counter, &option_data);

        Ok(counter)
    }

    /// Exercises the whole option.
    pub fn exercise(env: Env, exerciser: Address, option_id: u32) -> Result<(), OptionsError> {
        exerciser.require_auth();
        let option = read_option(&env, option_id);
        Self::settle(&env, exerciser, option_id, option, None)
    }

    /// Exercises `amount` of the option's collateral. The matching reserve is
    /// released; the rest stays reserved until the option is fully exercised or
    /// expires.
    pub fn exercise_partial(
        env: Env,
        exerciser: Address,
        option_id: u32,
        amount: i128,
    ) -> Result<(), OptionsError> {
        exerciser.require_auth();
        let option = read_option(&env, option_id);
        Self::settle(&env, exerciser, option_id, option, Some(amount))
    }

    /// Cancels an unexpired option and returns only its unexercised collateral
    /// to the minter. The minter must authorize the cancellation.
    pub fn cancel(env: Env, minter: Address, option_id: u32) -> Result<(), OptionsError> {
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

        let collateral_asset = match option.option_type {
            OptionType::Call => option.underlying_asset.clone(),
            OptionType::Put => option.quote_asset.clone(),
        };
        let exercised_amount = read_exercised_amount(&env, option_id);
        let remaining = option.collateral_amount - exercised_amount;

        token::Client::new(&env, &collateral_asset).transfer(
            &env.current_contract_address(),
            &minter,
            &remaining,
        );
        release_reserved(&env, &minter, &collateral_asset, remaining);
        write_cancelled(&env, option_id);

        emit_cancelled(&env, option_id, &option, remaining, exercised_amount);

        Ok(())
    }

    pub fn expire(env: Env, option_id: u32) -> Result<(), OptionsError> {
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

        let collateral_asset = match option.option_type {
            OptionType::Call => option.underlying_asset.clone(),
            OptionType::Put => option.quote_asset.clone(),
        };

        // Only what partial exercises have not already paid out is still held.
        let exercised_amount = read_exercised_amount(&env, option_id);
        let remaining = option.collateral_amount - exercised_amount;

        let client = token::Client::new(&env, &collateral_asset);
        client.transfer(&env.current_contract_address(), &option.minter, &remaining);

        release_reserved(&env, &option.minter, &collateral_asset, remaining);

        option.expired = true;
        write_option(&env, option_id, &option);

        emit_expired(&env, option_id, &option, remaining, exercised_amount);

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
        mut option: OptionData,
        amount: Option<i128>,
    ) -> Result<(), OptionsError> {
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

        // Pay out the exercised collateral to the exerciser and release its reserve.
        token::Client::new(env, &collateral_asset).transfer(
            &env.current_contract_address(),
            &exerciser,
            &to_exercise,
        );
        release_reserved(env, &option.minter, &collateral_asset, to_exercise);

        let new_exercised = already_exercised
            .checked_add(to_exercise)
            .ok_or(OptionsError::MathOverflow)?;
        write_exercised_amount(env, option_id, new_exercised);

        if new_exercised >= option.collateral_amount {
            option.exercised = true;
            write_option(env, option_id, &option);
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

        Ok(())
    }
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
