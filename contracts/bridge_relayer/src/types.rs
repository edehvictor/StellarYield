use soroban_sdk::{contracttype, Address, BytesN, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payload {
    pub src_chain: Symbol,
    pub src_address: BytesN<32>,
    pub asset: Address,
    pub amount: i128,
    pub recipient: Address,
    pub nonce: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedTransfer {
    pub payload: Payload,
    pub timestamp: u64,
}
