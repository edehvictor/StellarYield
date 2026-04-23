#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, token, Address, Env};

mod math;
mod storage;

#[cfg(test)]
mod test;

use math::calculate_voting_power;
use storage::{DataKey, UserLock, MAX_TIME, WEEK};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    ZeroAmount = 4,
    InvalidUnlockTime = 5,
    LockUnderway = 6,
    NoLockFound = 7,
    LockExpired = 8,
    LockNotExpired = 9,
    InvalidWeight = 10,
}

#[contract]
pub struct VeTokenomics;

#[contractimpl]
impl VeTokenomics {
    /// Initialize the contract with an admin and the $YIELD token address.
    ///
    /// # Arguments
    /// * `admin` — The address with administrative privileges.
    /// * `yield_token` — The address of the $YIELD SAC token.
    pub fn initialize(env: Env, admin: Address, yield_token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::YieldToken, &yield_token);
        env.storage().instance().set(&DataKey::Initialized, &true);
        Ok(())
    }

    /// Create a new lock for $YIELD tokens.
    ///
    /// The user's voting power (veYIELD) will be proportional to the lock duration
    /// and will decay linearly until it reaches zero at the `unlock_time`.
    ///
    /// # Arguments
    /// * `from` — The address of the user creating the lock (must authorize).
    /// * `amount` — The quantity of $YIELD tokens to lock.
    /// * `unlock_time` — The timestamp (in seconds) when the lock expires.
    ///                   Must be between 1 week and 4 years from now.
    pub fn create_lock(
        env: Env,
        from: Address,
        amount: i128,
        unlock_time: u64,
    ) -> Result<(), Error> {
        Self::require_init(&env)?;
        from.require_auth();

        if amount <= 0 {
            return Err(Error::ZeroAmount);
        }

        let current_time = env.ledger().timestamp();
        if unlock_time <= current_time + WEEK || unlock_time > current_time + MAX_TIME {
            return Err(Error::InvalidUnlockTime);
        }

        if env
            .storage()
            .persistent()
            .has(&DataKey::UserLock(from.clone()))
        {
            return Err(Error::LockUnderway);
        }

        // Transfer tokens from user to contract
        let yield_token: Address = env.storage().instance().get(&DataKey::YieldToken).unwrap();
        let client = token::Client::new(&env, &yield_token);
        client.transfer(&from, &env.current_contract_address(), &amount);

        let lock = UserLock {
            amount,
            end: unlock_time,
        };

        env.storage()
            .persistent()
            .set(&DataKey::UserLock(from.clone()), &lock);

        env.events()
            .publish((symbol_short!("lock"), from), (amount, unlock_time));

        Ok(())
    }

    /// Increase the amount of tokens in an existing lock.
    ///
    /// # Arguments
    /// * `from` — The address of the lock owner.
    /// * `amount` — Additional $YIELD tokens to add to the lock.
    pub fn increase_amount(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        Self::require_init(&env)?;
        from.require_auth();

        if amount <= 0 {
            return Err(Error::ZeroAmount);
        }

        let mut lock: UserLock = env
            .storage()
            .persistent()
            .get(&DataKey::UserLock(from.clone()))
            .ok_or(Error::NoLockFound)?;

        let current_time = env.ledger().timestamp();
        if lock.end <= current_time {
            return Err(Error::LockExpired);
        }

        // Transfer tokens
        let yield_token: Address = env.storage().instance().get(&DataKey::YieldToken).unwrap();
        let client = token::Client::new(&env, &yield_token);
        client.transfer(&from, &env.current_contract_address(), &amount);

        // Update lock
        lock.amount += amount;

        env.storage()
            .persistent()
            .set(&DataKey::UserLock(from.clone()), &lock);

        env.events()
            .publish((symbol_short!("inc_amt"), from), (amount, lock.amount));

        Ok(())
    }

    /// Extend the duration of an existing lock.
    ///
    /// # Arguments
    /// * `from` — The address of the lock owner.
    /// * `unlock_time` — The new expiration timestamp. Must be further in the future than the current expiration.
    pub fn increase_unlock_time(env: Env, from: Address, unlock_time: u64) -> Result<(), Error> {
        Self::require_init(&env)?;
        from.require_auth();

        let mut lock: UserLock = env
            .storage()
            .persistent()
            .get(&DataKey::UserLock(from.clone()))
            .ok_or(Error::NoLockFound)?;

        let current_time = env.ledger().timestamp();
        if lock.end <= current_time {
            return Err(Error::LockExpired);
        }

        if unlock_time <= lock.end || unlock_time > current_time + MAX_TIME {
            return Err(Error::InvalidUnlockTime);
        }

        // Update lock
        lock.end = unlock_time;

        env.storage()
            .persistent()
            .set(&DataKey::UserLock(from.clone()), &lock);

        env.events()
            .publish((symbol_short!("inc_time"), from), (unlock_time,));

        Ok(())
    }

    /// Withdraw all locked tokens after the lock has expired.
    ///
    /// # Arguments
    /// * `from` — The address of the lock owner.
    pub fn withdraw(env: Env, from: Address) -> Result<(), Error> {
        Self::require_init(&env)?;
        from.require_auth();

        let lock: UserLock = env
            .storage()
            .persistent()
            .get(&DataKey::UserLock(from.clone()))
            .ok_or(Error::NoLockFound)?;

        let current_time = env.ledger().timestamp();
        if lock.end > current_time {
            return Err(Error::LockNotExpired);
        }

        // Return tokens
        let yield_token: Address = env.storage().instance().get(&DataKey::YieldToken).unwrap();
        let client = token::Client::new(&env, &yield_token);
        client.transfer(&env.current_contract_address(), &from, &lock.amount);

        // Remove lock
        env.storage()
            .persistent()
            .remove(&DataKey::UserLock(from.clone()));

        env.events()
            .publish((symbol_short!("withdraw"), from), (lock.amount,));

        Ok(())
    }

    /// Vote for a specific emission gauge for a pool.
    ///
    /// This function records the user's preference for weight distribution among gauges.
    ///
    /// # Arguments
    /// * `from` — The address of the veYIELD holder.
    /// * `pool` — The address of the pool/gauge.
    /// * `weight` — Relative weight in basis points (0 - 10000).
    pub fn vote(env: Env, from: Address, pool: Address, weight: u32) -> Result<(), Error> {
        Self::require_init(&env)?;
        from.require_auth();

        if weight > 10000 {
            return Err(Error::InvalidWeight);
        }

        let lock: UserLock = env
            .storage()
            .persistent()
            .get(&DataKey::UserLock(from.clone()))
            .ok_or(Error::NoLockFound)?;

        let current_time = env.ledger().timestamp();
        if lock.end <= current_time {
            return Err(Error::LockExpired);
        }

        // For this task, we emit an event. A full gauge system would store
        // these in an instance map.
        env.events()
            .publish((symbol_short!("vote"), from), (pool, weight));

        Ok(())
    }

    /// Returns the current veYIELD voting power of `user`.
    ///
    /// Voting power is calculated based on the locked amount and time remaining until unlock.
    pub fn get_voting_power(env: Env, user: Address) -> i128 {
        let lock_opt: Option<UserLock> = env.storage().persistent().get(&DataKey::UserLock(user));
        if let Some(lock) = lock_opt {
            let current_time = env.ledger().timestamp();
            calculate_voting_power(lock.amount, lock.end, current_time)
        } else {
            0
        }
    }

    /// Returns the timestamp when `user` can withdraw their tokens.
    pub fn get_unlock_time(env: Env, user: Address) -> u64 {
        let lock_opt: Option<UserLock> = env.storage().persistent().get(&DataKey::UserLock(user));
        if let Some(lock) = lock_opt {
            lock.end
        } else {
            0
        }
    }

    // ── Internal Helpers ────────────────────────────────────────────

    fn require_init(env: &Env) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }
        Ok(())
    }
}
