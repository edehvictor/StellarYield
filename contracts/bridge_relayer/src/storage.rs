use soroban_sdk::{contracttype, Address, BytesN, Env, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Validators,
    Threshold,
    Limit,
    Processed(BytesN<32>),
    Queue(u32),
    QueueCounter,
}

pub fn read_admin(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Admin).unwrap()
}

pub fn write_admin(e: &Env, id: &Address) {
    e.storage().instance().set(&DataKey::Admin, id);
}

pub fn read_validators(e: &Env) -> Vec<BytesN<32>> {
    e.storage()
        .instance()
        .get(&DataKey::Validators)
        .unwrap_or(Vec::new(e))
}

pub fn write_validators(e: &Env, validators: &Vec<BytesN<32>>) {
    e.storage().instance().set(&DataKey::Validators, validators);
}

pub fn read_threshold(e: &Env) -> u32 {
    e.storage().instance().get(&DataKey::Threshold).unwrap_or(1)
}

pub fn write_threshold(e: &Env, threshold: u32) {
    e.storage().instance().set(&DataKey::Threshold, &threshold);
}

pub fn read_limit(e: &Env) -> i128 {
    e.storage()
        .instance()
        .get(&DataKey::Limit)
        .unwrap_or(1_000_000_000_000i128)
}

pub fn write_limit(e: &Env, limit: i128) {
    e.storage().instance().set(&DataKey::Limit, &limit);
}

pub fn is_processed(e: &Env, hash: &BytesN<32>) -> bool {
    e.storage()
        .persistent()
        .has(&DataKey::Processed(hash.clone()))
}

pub fn mark_processed(e: &Env, hash: &BytesN<32>) {
    e.storage()
        .persistent()
        .set(&DataKey::Processed(hash.clone()), &true);
}

pub fn increment_queue_counter(e: &Env) -> u32 {
    let count: u32 = e
        .storage()
        .instance()
        .get(&DataKey::QueueCounter)
        .unwrap_or(0);
    let new_count = count + 1;
    e.storage()
        .instance()
        .set(&DataKey::QueueCounter, &new_count);
    new_count
}

pub fn write_queue(e: &Env, id: u32, transfer: &super::types::QueuedTransfer) {
    e.storage().persistent().set(&DataKey::Queue(id), transfer);
}

pub fn read_queue(e: &Env, id: u32) -> Option<super::types::QueuedTransfer> {
    e.storage().persistent().get(&DataKey::Queue(id))
}

pub fn remove_queue(e: &Env, id: u32) {
    e.storage().persistent().remove(&DataKey::Queue(id));
}
