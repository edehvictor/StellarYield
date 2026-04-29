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
