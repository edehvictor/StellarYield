#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, token, Address, Env};

mod math;
mod storage;
#[cfg(test)]
mod tests;

use math::black_scholes_call;
use storage::{
    has_admin, read_option, read_option_counter, write_admin,
    write_option, write_option_counter, write_oracle, OptionData, OptionType,
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

    #[allow(clippy::too_many_arguments)]
    pub fn mint(
        env: Env,
        minter: Address,
        option_type: OptionType,
        underlying_asset: Address,
        quote_asset: Address,
        strike_price: i128,
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

        let collateral_asset = match option_type {
            OptionType::Call => underlying_asset.clone(),
            OptionType::Put => quote_asset.clone(),
        };

        // Transfer collateral to contract
        let client = token::Client::new(&env, &collateral_asset);
        client.transfer(&minter, &env.current_contract_address(), &collateral_amount);

        let mut counter = read_option_counter(&env);
        counter += 1;

        let option_data = OptionData {
            minter: minter.clone(),
            option_type,
            underlying_asset,
            quote_asset,
            strike_price,
            expiration_time,
            collateral_amount,
            exercised: false,
            expired: false,
        };

        write_option(&env, counter, &option_data);
        write_option_counter(&env, counter);

        env.events().publish(
            (symbol_short!("mint"), counter),
            (minter, strike_price, expiration_time),
        );

        Ok(counter)
    }

    pub fn exercise(env: Env, exerciser: Address, option_id: u32) -> Result<(), OptionsError> {
        exerciser.require_auth();
        let mut option = read_option(&env, option_id);

        if option.exercised || option.expired {
            return Err(OptionsError::AlreadyExercised);
        }

        let current_time = env.ledger().timestamp();
        if current_time < option.expiration_time {
            return Err(OptionsError::NotExpired);
        }

        // For Call: exerciser pays strike_price * collateral_amount (scaled) of quote_asset, receives collateral_asset (underlying)
        // For Put: exerciser pays strike_price * collateral_amount of underlying, receives collateral_asset (quote)

        let quote_client = token::Client::new(&env, &option.quote_asset);
        let underlying_client = token::Client::new(&env, &option.underlying_asset);

        if option.option_type == OptionType::Call {
            let total_cost = (option.collateral_amount * option.strike_price) / 10_000_000_i128;
            quote_client.transfer(&exerciser, &option.minter, &total_cost);
            underlying_client.transfer(
                &env.current_contract_address(),
                &exerciser,
                &option.collateral_amount,
            );
        } else {
            let total_cost = (option.collateral_amount * 10_000_000_i128) / option.strike_price;
            underlying_client.transfer(&exerciser, &option.minter, &total_cost);
            quote_client.transfer(
                &env.current_contract_address(),
                &exerciser,
                &option.collateral_amount,
            );
        }

        option.exercised = true;
        write_option(&env, option_id, &option);

        env.events().publish(
            (symbol_short!("exercise"), option_id),
            (exerciser, option.minter.clone()),
        );

        Ok(())
    }

    pub fn expire(env: Env, option_id: u32) -> Result<(), OptionsError> {
        let mut option = read_option(&env, option_id);

        if option.exercised || option.expired {
            return Err(OptionsError::AlreadyExpired);
        }

        let current_time = env.ledger().timestamp();
        if current_time < option.expiration_time {
            return Err(OptionsError::NotExpired);
        }

        let collateral_asset = match option.option_type {
            OptionType::Call => option.underlying_asset.clone(),
            OptionType::Put => option.quote_asset.clone(),
        };

        let client = token::Client::new(&env, &collateral_asset);
        client.transfer(
            &env.current_contract_address(),
            &option.minter,
            &option.collateral_amount,
        );

        option.expired = true;
        write_option(&env, option_id, &option);

        env.events().publish(
            (symbol_short!("expire"), option_id),
            (option.minter.clone(),),
        );

        Ok(())
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
