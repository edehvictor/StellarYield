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
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserLock {
    pub amount: i128,
    pub end: u64,
}

pub const MAX_TIME: u64 = 4 * 365 * 24 * 60 * 60; // 4 years in seconds
pub const WEEK: u64 = 7 * 24 * 60 * 60; // 1 week in seconds
