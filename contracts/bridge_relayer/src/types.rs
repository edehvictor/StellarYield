use soroban_sdk::{contracttype, Address, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessagePayload {
    pub source_chain: Symbol,
    pub nonce: u64,
    pub recipient: Address,
    pub asset: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub multi_sig_threshold: u32,
    pub queue_threshold: i128,
    pub queue_delay: u64, // Number of ledgers or seconds? Use ledgers for simplicity.
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MessageStatus {
    Pending,
    Processed,
    Queued(u64), // Release ledger
}
