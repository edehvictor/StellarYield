#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, token, Address, Env, Vec};

mod math;
mod storage;

#[cfg(test)]
mod test;

use math::calculate_voting_power;
use storage::{
    DataKey, LockCheckpoint, TotalCheckpoint, UserLock, MAX_CLAIM_EPOCHS, MAX_DELEGATION_DEPTH,
    MAX_TIME, WEEK,
};
use storage_helpers::{extend_instance_ttl_default, extend_persistent_ttl_default};

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
    /// Delegating would create a direct (self) or indirect delegation loop.
    DelegationCycle = 11,
    /// Delegating would make a delegation chain longer than `MAX_DELEGATION_DEPTH`.
    DelegationTooDeep = 12,
    /// The caller has no active delegation to remove.
    NotDelegated = 13,
    /// A historical query named a time that has not happened yet, so the answer
    /// could still change.
    FutureTimestamp = 14,
    /// The epoch range is empty or longer than `MAX_CLAIM_EPOCHS`.
    InvalidEpochRange = 15,
    /// Fees can only be claimed for an epoch once it has ended.
    EpochNotFinished = 16,
    /// Every epoch in the range was already claimed, or earns the account nothing.
    NothingToClaim = 17,
    /// An amount calculation overflowed.
    Overflow = 18,
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
        extend_instance_ttl_default(&env);
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

        let lock_key = DataKey::UserLock(from.clone());
        if env.storage().persistent().has(&lock_key) {
            extend_persistent_ttl_default(&env, &lock_key);
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

        Self::checkpoint_lock(&env, &from, Some(&lock));
        env.storage().persistent().set(&lock_key, &lock);
        extend_persistent_ttl_default(&env, &lock_key);
        Self::adjust_total_locked(&env, amount);

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

        let lock_key = DataKey::UserLock(from.clone());
        extend_persistent_ttl_default(&env, &lock_key);
        let mut lock: UserLock = env
            .storage()
            .persistent()
            .get(&lock_key)
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

        Self::checkpoint_lock(&env, &from, Some(&lock));
        env.storage().persistent().set(&lock_key, &lock);
        extend_persistent_ttl_default(&env, &lock_key);
        Self::adjust_total_locked(&env, amount);

        env.events()
            .publish((symbol_short!("inc_amt"), from), (amount, lock.amount));

        Ok(())
    }

    /// Extend the duration of an existing lock.
    ///
    /// Only the end time moves: the locked token total is preserved and voting
    /// power is recomputed from `(amount, new_end)` rather than added on top of
    /// the power the lock already had. Repeated extensions therefore converge on
    /// the power of a single lock ending at the latest `unlock_time`, and the
    /// power delegated to another account follows automatically.
    ///
    /// # Arguments
    /// * `from` — The address of the lock owner.
    /// * `unlock_time` — The new expiration timestamp. Must be further in the future than the current expiration.
    pub fn increase_unlock_time(env: Env, from: Address, unlock_time: u64) -> Result<(), Error> {
        Self::require_init(&env)?;
        from.require_auth();

        let lock_key = DataKey::UserLock(from.clone());
        extend_persistent_ttl_default(&env, &lock_key);
        let mut lock: UserLock = env
            .storage()
            .persistent()
            .get(&lock_key)
            .ok_or(Error::NoLockFound)?;

        let current_time = env.ledger().timestamp();
        if lock.end <= current_time {
            return Err(Error::LockExpired);
        }

        if unlock_time <= lock.end || unlock_time > current_time + MAX_TIME {
            return Err(Error::InvalidUnlockTime);
        }

        // Update the end time only; `lock.amount` is intentionally untouched so
        // the locked token total (and `TotalLocked`) stays the same.
        lock.end = unlock_time;

        Self::checkpoint_lock(&env, &from, Some(&lock));
        env.storage().persistent().set(&lock_key, &lock);
        extend_persistent_ttl_default(&env, &lock_key);

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

        let lock_key = DataKey::UserLock(from.clone());
        extend_persistent_ttl_default(&env, &lock_key);
        let lock: UserLock = env
            .storage()
            .persistent()
            .get(&lock_key)
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
        Self::checkpoint_lock(&env, &from, None);
        env.storage().persistent().remove(&lock_key);
        Self::adjust_total_locked(&env, -lock.amount);

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

        let lock_key = DataKey::UserLock(from.clone());
        extend_persistent_ttl_default(&env, &lock_key);
        let lock: UserLock = env
            .storage()
            .persistent()
            .get(&lock_key)
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
        let lock_key = DataKey::UserLock(user);
        let lock_opt: Option<UserLock> = env.storage().persistent().get(&lock_key);
        if let Some(lock) = lock_opt {
            extend_persistent_ttl_default(&env, &lock_key);
            let current_time = env.ledger().timestamp();
            calculate_voting_power(lock.amount, lock.end, current_time)
        } else {
            0
        }
    }

    /// Returns the timestamp when `user` can withdraw their tokens.
    pub fn get_unlock_time(env: Env, user: Address) -> u64 {
        let lock_key = DataKey::UserLock(user);
        let lock_opt: Option<UserLock> = env.storage().persistent().get(&lock_key);
        if let Some(lock) = lock_opt {
            extend_persistent_ttl_default(&env, &lock_key);
            lock.end
        } else {
            0
        }
    }

    /// Returns the raw lock of `user`, if any.
    pub fn get_lock(env: Env, user: Address) -> Option<UserLock> {
        let lock_key = DataKey::UserLock(user);
        let lock_opt: Option<UserLock> = env.storage().persistent().get(&lock_key);
        if lock_opt.is_some() {
            extend_persistent_ttl_default(&env, &lock_key);
        }
        lock_opt
    }

    /// Returns the total amount of $YIELD currently held in locks.
    pub fn get_total_locked(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0)
    }

    // ── Historical lock state ───────────────────────────────────────

    /// Returns the lock `user` had at `timestamp`, as of the end of that
    /// second: changes made at `timestamp` itself are included, later ones are
    /// not. `timestamp` must not be in the future.
    ///
    /// Accounts whose lock predates checkpointing report their current lock
    /// until they next change it.
    pub fn get_lock_at(env: Env, user: Address, timestamp: u64) -> Result<Option<UserLock>, Error> {
        Self::require_past(&env, timestamp)?;
        Ok(Self::lock_at(&env, &user, timestamp))
    }

    /// Returns the veYIELD voting power `user` had at `timestamp`, computed
    /// from the lock they held then. Token movement after `timestamp` (a
    /// withdrawal, a bigger or longer lock) does not change the answer, which
    /// is what lets governance fix a proposal's voting weight when it is
    /// created. Delegation is not part of this figure.
    pub fn get_voting_power_at(env: Env, user: Address, timestamp: u64) -> Result<i128, Error> {
        Self::require_past(&env, timestamp)?;
        Ok(match Self::lock_at(&env, &user, timestamp) {
            Some(lock) => calculate_voting_power(lock.amount, lock.end, timestamp),
            None => 0,
        })
    }

    /// Returns the total amount locked in the contract at `timestamp`.
    pub fn get_total_locked_at(env: Env, timestamp: u64) -> Result<i128, Error> {
        Self::require_past(&env, timestamp)?;
        Ok(Self::total_locked_at(&env, timestamp))
    }

    // ── Fee distribution ────────────────────────────────────────────

    /// The epoch the ledger is currently in. Epochs are weeks since the Unix
    /// epoch.
    pub fn get_current_epoch(env: Env) -> u64 {
        env.ledger().timestamp() / WEEK
    }

    /// Deposit $YIELD fees for the lockers of the current epoch.
    ///
    /// Lockers share an epoch's fees in proportion to the amount they had
    /// locked when the epoch began, so locking after the epoch has started
    /// earns nothing from it. The fees become claimable once the epoch ends.
    ///
    /// # Arguments
    /// * `from` — The depositor (must authorize).
    /// * `amount` — The quantity of $YIELD to distribute.
    pub fn deposit_fees(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        Self::require_init(&env)?;
        from.require_auth();

        if amount <= 0 {
            return Err(Error::ZeroAmount);
        }

        let epoch = env.ledger().timestamp() / WEEK;
        let fees_key = DataKey::EpochFees(epoch);
        let total = Self::read_i128(&env, &fees_key)
            .checked_add(amount)
            .ok_or(Error::Overflow)?;

        let yield_token: Address = env.storage().instance().get(&DataKey::YieldToken).unwrap();
        let client = token::Client::new(&env, &yield_token);
        client.transfer(&from, &env.current_contract_address(), &amount);

        env.storage().persistent().set(&fees_key, &total);
        extend_persistent_ttl_default(&env, &fees_key);

        env.events()
            .publish((symbol_short!("fees"), from), (epoch, amount));

        Ok(())
    }

    /// Claim `user`'s share of the fees of every epoch from `start_epoch` to
    /// `end_epoch` (inclusive) and return the amount paid.
    ///
    /// Each epoch pays an account at most once: epochs that were already
    /// claimed, for example by an earlier overlapping or partial claim, are
    /// skipped rather than paid again. Fails with `NothingToClaim` if no epoch
    /// in the range pays anything new.
    ///
    /// # Arguments
    /// * `user` — The locker claiming (must authorize).
    /// * `start_epoch`, `end_epoch` — The epochs to claim. All of them must
    ///   have ended, and there can be at most `MAX_CLAIM_EPOCHS`.
    pub fn claim_fees(
        env: Env,
        user: Address,
        start_epoch: u64,
        end_epoch: u64,
    ) -> Result<i128, Error> {
        Self::require_init(&env)?;
        user.require_auth();
        Self::check_epoch_range(start_epoch, end_epoch)?;

        let current_epoch = env.ledger().timestamp() / WEEK;
        if end_epoch >= current_epoch {
            return Err(Error::EpochNotFinished);
        }

        let mut paid: i128 = 0;
        for epoch in start_epoch..=end_epoch {
            let share = Self::unclaimed_share(&env, &user, epoch)?;
            if share == 0 {
                continue;
            }
            let claimed_key = DataKey::EpochFeesClaimed(epoch);
            let claimed = Self::read_i128(&env, &claimed_key)
                .checked_add(share)
                .ok_or(Error::Overflow)?;
            // Rounding down keeps the shares within the deposit; this guards
            // against the books ever disagreeing.
            if claimed > Self::read_i128(&env, &DataKey::EpochFees(epoch)) {
                return Err(Error::Overflow);
            }
            let fee_claim_key = DataKey::FeeClaim(user.clone(), epoch);
            env.storage().persistent().set(&fee_claim_key, &share);
            extend_persistent_ttl_default(&env, &fee_claim_key);
            env.storage().persistent().set(&claimed_key, &claimed);
            extend_persistent_ttl_default(&env, &claimed_key);
            paid = paid.checked_add(share).ok_or(Error::Overflow)?;
        }

        if paid == 0 {
            return Err(Error::NothingToClaim);
        }

        let yield_token: Address = env.storage().instance().get(&DataKey::YieldToken).unwrap();
        let client = token::Client::new(&env, &yield_token);
        client.transfer(&env.current_contract_address(), &user, &paid);

        env.events().publish(
            (symbol_short!("claim"), user),
            (start_epoch, end_epoch, paid),
        );

        Ok(paid)
    }

    /// Returns what `user` could still claim over the epochs from
    /// `start_epoch` to `end_epoch` (inclusive). Epochs that have not ended and
    /// epochs already claimed count for nothing.
    pub fn get_unclaimed_fees(
        env: Env,
        user: Address,
        start_epoch: u64,
        end_epoch: u64,
    ) -> Result<i128, Error> {
        Self::check_epoch_range(start_epoch, end_epoch)?;
        let current_epoch = env.ledger().timestamp() / WEEK;
        let mut unclaimed: i128 = 0;
        for epoch in start_epoch..=end_epoch.min(current_epoch.saturating_sub(1)) {
            if epoch >= current_epoch {
                break;
            }
            unclaimed = unclaimed
                .checked_add(Self::unclaimed_share(&env, &user, epoch)?)
                .ok_or(Error::Overflow)?;
        }
        Ok(unclaimed)
    }

    /// Returns the fees deposited for `epoch`.
    pub fn get_epoch_fees(env: Env, epoch: u64) -> i128 {
        Self::read_i128(&env, &DataKey::EpochFees(epoch))
    }

    /// Returns how much of the fees of `epoch` has been claimed so far.
    pub fn get_epoch_fees_claimed(env: Env, epoch: u64) -> i128 {
        Self::read_i128(&env, &DataKey::EpochFeesClaimed(epoch))
    }

    /// Returns the fees `user` has claimed for `epoch`.
    pub fn get_claimed_fees(env: Env, user: Address, epoch: u64) -> i128 {
        Self::read_i128(&env, &DataKey::FeeClaim(user, epoch))
    }

    /// Returns whether `user` has already claimed the fees of `epoch`.
    pub fn has_claimed_fees(env: Env, user: Address, epoch: u64) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::FeeClaim(user, epoch))
    }

    // ── Delegation ──────────────────────────────────────────────────

    /// Delegate the voting power of `from` (and everything delegated to
    /// `from`) to `to`.
    ///
    /// Delegation is transitive, so the request is rejected before any voting
    /// weight changes if it would create a loop: either `from == to` or `to`
    /// already (directly or indirectly) delegates to `from`. Calling it again
    /// with a different `to` moves the delegation.
    ///
    /// # Arguments
    /// * `from` — The delegating account (must authorize).
    /// * `to` — The account that receives the voting power.
    pub fn delegate(env: Env, from: Address, to: Address) -> Result<(), Error> {
        Self::require_init(&env)?;
        from.require_auth();

        let previous = Self::read_delegate(&env, &from);
        if previous.as_ref() == Some(&to) {
            return Ok(());
        }

        Self::check_delegation(&env, &from, &to)?;

        if let Some(prev) = previous {
            Self::remove_delegator(&env, &prev, &from);
        }

        let delegate_key = DataKey::Delegate(from.clone());
        env.storage().persistent().set(&delegate_key, &to);
        extend_persistent_ttl_default(&env, &delegate_key);

        let delegators_key = DataKey::Delegators(to.clone());
        let mut delegators = Self::read_delegators(&env, &to);
        delegators.push_back(from.clone());
        env.storage().persistent().set(&delegators_key, &delegators);
        extend_persistent_ttl_default(&env, &delegators_key);

        env.events()
            .publish((symbol_short!("delegate"), from), (to,));

        Ok(())
    }

    /// Remove the active delegation of `from`, returning its voting power to it.
    pub fn undelegate(env: Env, from: Address) -> Result<(), Error> {
        Self::require_init(&env)?;
        from.require_auth();

        let to = Self::read_delegate(&env, &from).ok_or(Error::NotDelegated)?;
        Self::remove_delegator(&env, &to, &from);
        env.storage()
            .persistent()
            .remove(&DataKey::Delegate(from.clone()));

        env.events()
            .publish((symbol_short!("undeleg"), from), (to,));

        Ok(())
    }

    /// Returns the account `user` delegates to, if any.
    pub fn get_delegate(env: Env, user: Address) -> Option<Address> {
        Self::read_delegate(&env, &user)
    }

    /// Returns the governance weight `user` controls: its own voting power plus
    /// the power of every account delegating to it (directly or through a
    /// chain). An account that has delegated away controls no weight.
    pub fn get_delegated_voting_power(env: Env, user: Address) -> i128 {
        if Self::read_delegate(&env, &user).is_some() {
            return 0;
        }
        let current_time = env.ledger().timestamp();
        Self::power_with_delegators(&env, &user, current_time, 0)
    }

    // ── Internal Helpers ────────────────────────────────────────────

    fn read_i128(env: &Env, key: &DataKey) -> i128 {
        let value: Option<i128> = env.storage().persistent().get(key);
        match value {
            Some(value) => {
                extend_persistent_ttl_default(env, key);
                value
            }
            None => 0,
        }
    }

    fn require_past(env: &Env, timestamp: u64) -> Result<(), Error> {
        if timestamp > env.ledger().timestamp() {
            return Err(Error::FutureTimestamp);
        }
        Ok(())
    }

    fn check_epoch_range(start_epoch: u64, end_epoch: u64) -> Result<(), Error> {
        if end_epoch < start_epoch || end_epoch - start_epoch >= MAX_CLAIM_EPOCHS {
            return Err(Error::InvalidEpochRange);
        }
        Ok(())
    }

    /// What `user` would be paid for `epoch` if they claimed now: nothing if
    /// they already claimed it, otherwise their share of the epoch's fees,
    /// rounded down. The share is the amount they had locked when the epoch
    /// began over the total locked then. Both are fixed once the epoch has
    /// started, so the answer never changes for a finished epoch.
    fn unclaimed_share(env: &Env, user: &Address, epoch: u64) -> Result<i128, Error> {
        if env
            .storage()
            .persistent()
            .has(&DataKey::FeeClaim(user.clone(), epoch))
        {
            return Ok(0);
        }
        let fees = Self::read_i128(env, &DataKey::EpochFees(epoch));
        if fees == 0 {
            return Ok(0);
        }
        let epoch_start = epoch.checked_mul(WEEK).ok_or(Error::Overflow)?;
        let total = Self::total_locked_at(env, epoch_start);
        let locked = match Self::lock_at(env, user, epoch_start) {
            Some(lock) => lock.amount,
            None => 0,
        };
        if total <= 0 || locked <= 0 {
            return Ok(0);
        }
        Ok(fees.checked_mul(locked).ok_or(Error::Overflow)? / total)
    }

    /// Record `lock` (or its removal) as the account's lock from now on. Must
    /// run before the stored lock is changed.
    fn checkpoint_lock(env: &Env, user: &Address, lock: Option<&UserLock>) {
        let count_key = DataKey::UserCheckpointCount(user.clone());
        let mut count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);

        // A lock made before checkpoints existed has no history. Keep what it
        // was so far as the baseline for every earlier time.
        if count == 0 {
            let existing: Option<UserLock> = env
                .storage()
                .persistent()
                .get(&DataKey::UserLock(user.clone()));
            if let Some(existing) = existing {
                let key = DataKey::UserCheckpoint(user.clone(), 0);
                env.storage().persistent().set(
                    &key,
                    &LockCheckpoint {
                        timestamp: 0,
                        amount: existing.amount,
                        end: existing.end,
                    },
                );
                extend_persistent_ttl_default(env, &key);
                count = 1;
            }
        }

        let now = env.ledger().timestamp();
        let checkpoint = LockCheckpoint {
            timestamp: now,
            amount: lock.map_or(0, |l| l.amount),
            end: lock.map_or(0, |l| l.end),
        };
        // Several changes in the same second share one checkpoint.
        let last_key = DataKey::UserCheckpoint(user.clone(), count.saturating_sub(1));
        let same_second = count > 0
            && env
                .storage()
                .persistent()
                .get::<_, LockCheckpoint>(&last_key)
                .is_some_and(|last| last.timestamp == now);
        let index = if same_second { count - 1 } else { count };
        let key = DataKey::UserCheckpoint(user.clone(), index);
        env.storage().persistent().set(&key, &checkpoint);
        extend_persistent_ttl_default(env, &key);
        env.storage().persistent().set(&count_key, &(index + 1));
        extend_persistent_ttl_default(env, &count_key);
    }

    /// Record `new_total` as the total locked from now on.
    fn checkpoint_total(env: &Env, previous_total: i128, new_total: i128) {
        let mut count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCheckpointCount)
            .unwrap_or(0);

        // Amounts locked before checkpoints existed form the baseline.
        if count == 0 && previous_total != 0 {
            let key = DataKey::TotalCheckpoint(0);
            env.storage().persistent().set(
                &key,
                &TotalCheckpoint {
                    timestamp: 0,
                    total: previous_total,
                },
            );
            extend_persistent_ttl_default(env, &key);
            count = 1;
        }

        let now = env.ledger().timestamp();
        let last_key = DataKey::TotalCheckpoint(count.saturating_sub(1));
        let same_second = count > 0
            && env
                .storage()
                .persistent()
                .get::<_, TotalCheckpoint>(&last_key)
                .is_some_and(|last| last.timestamp == now);
        let index = if same_second { count - 1 } else { count };
        let key = DataKey::TotalCheckpoint(index);
        env.storage().persistent().set(
            &key,
            &TotalCheckpoint {
                timestamp: now,
                total: new_total,
            },
        );
        extend_persistent_ttl_default(env, &key);
        env.storage()
            .persistent()
            .set(&DataKey::TotalCheckpointCount, &(index + 1));
        extend_persistent_ttl_default(env, &DataKey::TotalCheckpointCount);
    }

    /// The lock `user` had at `timestamp`: the newest checkpoint at or before
    /// it. An account with no checkpoints at all still has its original,
    /// never-changed lock.
    fn lock_at(env: &Env, user: &Address, timestamp: u64) -> Option<UserLock> {
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserCheckpointCount(user.clone()))
            .unwrap_or(0);
        if count == 0 {
            return env
                .storage()
                .persistent()
                .get(&DataKey::UserLock(user.clone()));
        }

        // Binary search for the number of checkpoints at or before `timestamp`.
        let (mut low, mut high) = (0u32, count);
        while low < high {
            let mid = low + (high - low) / 2;
            let checkpoint: LockCheckpoint = env
                .storage()
                .persistent()
                .get(&DataKey::UserCheckpoint(user.clone(), mid))
                .unwrap();
            if checkpoint.timestamp <= timestamp {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        if low == 0 {
            return None;
        }
        let checkpoint: LockCheckpoint = env
            .storage()
            .persistent()
            .get(&DataKey::UserCheckpoint(user.clone(), low - 1))
            .unwrap();
        if checkpoint.amount == 0 {
            return None;
        }
        Some(UserLock {
            amount: checkpoint.amount,
            end: checkpoint.end,
        })
    }

    /// The total locked at `timestamp`, found like [`Self::lock_at`].
    fn total_locked_at(env: &Env, timestamp: u64) -> i128 {
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCheckpointCount)
            .unwrap_or(0);
        if count == 0 {
            return env
                .storage()
                .instance()
                .get(&DataKey::TotalLocked)
                .unwrap_or(0);
        }

        let (mut low, mut high) = (0u32, count);
        while low < high {
            let mid = low + (high - low) / 2;
            let checkpoint: TotalCheckpoint = env
                .storage()
                .persistent()
                .get(&DataKey::TotalCheckpoint(mid))
                .unwrap();
            if checkpoint.timestamp <= timestamp {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        if low == 0 {
            return 0;
        }
        let checkpoint: TotalCheckpoint = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCheckpoint(low - 1))
            .unwrap();
        checkpoint.total
    }

    fn adjust_total_locked(env: &Env, delta: i128) {
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        Self::checkpoint_total(env, total, total + delta);
        env.storage()
            .instance()
            .set(&DataKey::TotalLocked, &(total + delta));
    }

    fn own_voting_power(env: &Env, user: &Address, current_time: u64) -> i128 {
        let lock_opt: Option<UserLock> = env
            .storage()
            .persistent()
            .get(&DataKey::UserLock(user.clone()));
        match lock_opt {
            Some(lock) => calculate_voting_power(lock.amount, lock.end, current_time),
            None => 0,
        }
    }

    fn power_with_delegators(env: &Env, user: &Address, current_time: u64, depth: u32) -> i128 {
        let mut power = Self::own_voting_power(env, user, current_time);
        // Cycles and chains longer than MAX_DELEGATION_DEPTH are rejected when
        // delegating, so this guard only protects against corrupted state.
        if depth >= MAX_DELEGATION_DEPTH {
            return power;
        }
        for delegator in Self::read_delegators(env, user).iter() {
            power += Self::power_with_delegators(env, &delegator, current_time, depth + 1);
        }
        power
    }

    fn read_delegate(env: &Env, user: &Address) -> Option<Address> {
        let key = DataKey::Delegate(user.clone());
        let delegate: Option<Address> = env.storage().persistent().get(&key);
        if delegate.is_some() {
            extend_persistent_ttl_default(env, &key);
        }
        delegate
    }

    fn read_delegators(env: &Env, user: &Address) -> Vec<Address> {
        let key = DataKey::Delegators(user.clone());
        let delegators: Option<Vec<Address>> = env.storage().persistent().get(&key);
        match delegators {
            Some(list) => {
                extend_persistent_ttl_default(env, &key);
                list
            }
            None => Vec::new(env),
        }
    }

    fn remove_delegator(env: &Env, delegatee: &Address, delegator: &Address) {
        let key = DataKey::Delegators(delegatee.clone());
        let mut delegators = Self::read_delegators(env, delegatee);
        if let Some(index) = delegators.first_index_of(delegator) {
            delegators.remove(index);
        }
        if delegators.is_empty() {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &delegators);
            extend_persistent_ttl_default(env, &key);
        }
    }

    /// Reject `from -> to` if it would close a delegation loop or produce a
    /// chain longer than `MAX_DELEGATION_DEPTH`.
    fn check_delegation(env: &Env, from: &Address, to: &Address) -> Result<(), Error> {
        if from == to {
            return Err(Error::DelegationCycle);
        }

        // Walk the existing chain downstream of `to`. Reaching `from` means
        // `to` already delegates (indirectly) to `from`.
        let mut downstream: u32 = 1;
        let mut current = to.clone();
        while let Some(next) = Self::read_delegate(env, &current) {
            if &next == from {
                return Err(Error::DelegationCycle);
            }
            downstream += 1;
            if downstream > MAX_DELEGATION_DEPTH {
                return Err(Error::DelegationTooDeep);
            }
            current = next;
        }

        // Everything already delegating to `from` gets stacked on top of the
        // downstream chain, so the combined length must stay bounded too.
        let upstream = Self::delegator_height(env, from, MAX_DELEGATION_DEPTH - downstream)?;
        if downstream + upstream > MAX_DELEGATION_DEPTH {
            return Err(Error::DelegationTooDeep);
        }
        Ok(())
    }

    /// Length of the longest delegation chain ending at `user`, failing once it
    /// exceeds `budget`.
    fn delegator_height(env: &Env, user: &Address, budget: u32) -> Result<u32, Error> {
        let mut height = 0;
        for delegator in Self::read_delegators(env, user).iter() {
            if budget == 0 {
                return Err(Error::DelegationTooDeep);
            }
            let h = 1 + Self::delegator_height(env, &delegator, budget - 1)?;
            if h > height {
                height = h;
            }
        }
        Ok(height)
    }

    fn require_init(env: &Env) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }
        extend_instance_ttl_default(env);
        Ok(())
    }
}
