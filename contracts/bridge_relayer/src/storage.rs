use soroban_sdk::{contracttype, Address, Env, Symbol, BytesN};

#[contracttype]
pub enum DataKey {
    Config,
    Signers, // Vec<Address>
    MerkleRoot, // BytesN<32>
    LastNonce(Symbol), // Chain -> u64
    MessageStatus(BytesN<32>), // Hash -> Status
    Initialized,
}

pub fn get_config(env: &Env) -> Option<crate::types::Config> {
    env.storage().instance().get(&DataKey::Config)
}

pub fn set_config(env: &Env, config: &crate::types::Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Initialized)
}

pub fn set_initialized(env: &Env) {
    env.storage().instance().set(&DataKey::Initialized, &true);
}

pub fn get_signers(env: &Env) -> soroban_sdk::Vec<Address> {
    env.storage().instance().get(&DataKey::Signers).unwrap_or(soroban_sdk::Vec::new(env))
}

pub fn set_signers(env: &Env, signers: &soroban_sdk::Vec<Address>) {
    env.storage().instance().set(&DataKey::Signers, signers);
}

pub fn get_last_nonce(env: &Env, chain: Symbol) -> u64 {
    env.storage().persistent().get(&DataKey::LastNonce(chain)).unwrap_or(0)
}

pub fn set_last_nonce(env: &Env, chain: Symbol, nonce: u64) {
    env.storage().persistent().set(&DataKey::LastNonce(chain), &nonce);
}

pub fn get_message_status(env: &Env, hash: BytesN<32>) -> Option<crate::types::MessageStatus> {
    env.storage().persistent().get(&DataKey::MessageStatus(hash))
}

pub fn set_message_status(env: &Env, hash: BytesN<32>, status: &crate::types::MessageStatus) {
    env.storage().persistent().set(&DataKey::MessageStatus(hash), status);
}

pub fn get_merkle_root(env: &Env) -> BytesN<32> {
    env.storage().instance().get(&DataKey::MerkleRoot).unwrap_or(BytesN::from_array(env, &[0u8; 32]))
}

pub fn set_merkle_root(env: &Env, root: &BytesN<32>) {
    env.storage().instance().set(&DataKey::MerkleRoot, root);
}
