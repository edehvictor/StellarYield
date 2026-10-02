use soroban_sdk::{contracttype, Address, Symbol, Val, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    VeYieldToken,
    ChallengeWindow,
    Proposal(u64),
    ProposalCount,
    IsInitialized,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Pending,
    Disputed,
    Executed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub contract_id: Address,
    pub function: Symbol,
    pub args: Vec<Val>,
    pub execution_time: u64,
    pub status: ProposalStatus,
}

/// Aggregate view of whether a proposal can be executed right now, and if
/// not, every specific reason blocking it (rather than a single generic
/// revert reason from `execute()`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionReadiness {
    pub is_ready: bool,
    pub blocking_reasons: Vec<u32>,
}
