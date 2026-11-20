use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    YieldToken,
    UserLock(Address),
    TotalVotingPower,         // Placeholder for global state
    GaugeVote(Address),       // User's set of votes
    PoolTotalWeight(Address), // Total weight for a specific pool
    Initialized,
    /// Address that `Address` has delegated its voting power to.
    Delegate(Address),
    /// Addresses that currently delegate directly to `Address`.
    Delegators(Address),
    /// Sum of all tokens currently held in locks.
    TotalLocked,
    /// The `index`-th lock checkpoint of an account (oldest first).
    UserCheckpoint(Address, u32),
    /// Number of lock checkpoints recorded for an account.
    UserCheckpointCount(Address),
    /// The `index`-th checkpoint of the total locked amount (oldest first).
    TotalCheckpoint(u32),
    /// Number of checkpoints recorded for the total locked amount.
    TotalCheckpointCount,
    /// Fees deposited for distribution in an epoch.
    EpochFees(u64),
    /// Part of an epoch's fees that has already been claimed.
    EpochFeesClaimed(u64),
    /// Fees an account has claimed for an epoch; present once it has claimed.
    FeeClaim(Address, u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserLock {
    pub amount: i128,
    pub end: u64,
}

/// State of an account's lock as of `timestamp`. An `amount` of zero means the
/// account had no lock from then on.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockCheckpoint {
    pub timestamp: u64,
    pub amount: i128,
    pub end: u64,
}

/// Total amount locked in the contract as of `timestamp`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TotalCheckpoint {
    pub timestamp: u64,
    pub total: i128,
}

pub const MAX_TIME: u64 = 4 * 365 * 24 * 60 * 60; // 4 years in seconds
pub const WEEK: u64 = 7 * 24 * 60 * 60; // 1 week in seconds

/// Most epochs a single fee claim or unclaimed-fee query may cover. Bounds the
/// work done in one call.
pub const MAX_CLAIM_EPOCHS: u64 = 52;

/// Maximum length of a delegation chain. Bounds the cost of cycle detection
/// and of resolving delegated voting power.
pub const MAX_DELEGATION_DEPTH: u32 = 16;
