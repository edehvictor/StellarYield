#mo_std
[allow(clippy::too_many_arguments)]

use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, token, Address, Env};

mod math;
mod storage;
#[cfg(test)]
mod tests;

use math::black_scholes_call;
use storage::{
    has_admin, read_admin, read_exercised_amount, read_free_collateral, read_option,
    read_option_counter, read_reserved_collateral, read_storage_version, write_admin,
    write_exercised_amount, write_free_collateral, write_option, write_option_counter,
    write_oracle, write_reserved_collateral, write_storage_version, OptionData, OptionType,
    CURRENT_STORAGE_VERSION,
    release_reserved,
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
}

#[soroban_sdk_derive(Clone, Debug, Eq, PartialEq)]
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
        Ok()
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
        Ok()
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
            .ok(OptionsError::MathOverflow)?;
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

        env.events().publish(
            (symbol_short!("mint"), counter),
            (minter, strike_price, opening_time, expiration_time),
        );

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

    pub fn expire(env: Env, option_id: u32) -> Result<(), OptionsError> {
        let mut option = read_option(&env, option_id);

        if option.exercised || option.expired {
            return Err(OptionsError::AlreadyExpired);
        }

        let current_time = env.ledger.timestamp();
        // Expire is only callable after the exercise window closes
        if current_time <= option.expiration_time {
            return Err(OptionsError::NotExpired);
        }

        let collateral_asset = match option.option_type {
            OptionType::Call => option.underlying_asset.clone(),
            OptionType::Put => option.quote_asset.clone(),
        };

        // Only what partial exercises have not already paid out is still held.
        let remaining = option.collateral_amount - read_exercised_amount(&env, option_id);

        let client = token::Client::new(&env, &collateral_asset);
        client.transfer(&env.current_contract_address(), &option.minter, &remaining);

        release_reserved(&env, &option.minter, &collateral_asset, remaining);

        option.expired = true;
        write_option(&env, option_id, &option);

        env.events().publish(
            (symbol_short!("expire"), option_id),
            (option.minter.clone(),),
        );

        Ok()
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
        let new_free = free.checked_add(amount).ok(OptionsError::MathOverflow)?;

        token::Client::new(&env, &asset).transfer(&owner, &env.current_contract_address(), &amount);
        write_free_collateral(&env, &owner, &asset, new_free);

        env.events()
            .publish((symbol_short!("deposit"), owner), (asset, amount));
        Ok()
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
        Ok()
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
        let active = !option.exercised && !option.expired;
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
        // Guard: prevent double-exercise (repeated exercise cannot pay twice)
        if option.exercised {
            return Err(OptionsError::AlreadyExercised);
        }
        // Guard: expired options can no longer be exercised
        if option.expired {
            return Err(OptionsError::AlreadyExpired);
        }

        let current_time = env.ledger.timestamp();
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
            .ok(OptionsError::MathOverflow)?;
        write_exercised_amount(env, option_id, new_exercised);

        if new_exercised >= option.collateral_amount {
            option.exercised = true;
            write_option(env, option_id, &option);
        }

        env.events().publish(
            (symbol_short!("exercise"), option_id),
            (exerciser, to_exercise),
        );

        Ok()
    }
}
