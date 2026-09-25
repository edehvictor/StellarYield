use soroban_sdk::{contracttype, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Oracle,
    OptionCounter,
    Option(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OptionType {
    Call,
    Put,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OptionData {
    pub minter: Address,
    pub option_type: OptionType,
    pub underlying_asset: Address,
    pub quote_asset: Address,
    pub strike_price: i128,   // Scaled by 1e7
    pub expiration_time: u64, // Unix timestamp
    pub collateral_amount: i128,
    pub exercised: bool,
    pub expired: bool,
}

use storage_helpers::{extend_instance_ttl_default, extend_persistent_ttl_default};

pub fn has_admin(e: &Env) -> bool {
    let has = e.storage().instance().has(&DataKey::Admin);
    if has {
        extend_instance_ttl_default(e);
    }
    has
}

#[allow(dead_code)]
pub fn read_admin(e: &Env) -> Address {
    extend_instance_ttl_default(e);
    e.storage().instance().get(&DataKey::Admin).unwrap()
}

pub fn write_admin(e: &Env, id: &Address) {
    e.storage().instance().set(&DataKey::Admin, id);
    extend_instance_ttl_default(e);
}

#[allow(dead_code)]
pub fn read_oracle(e: &Env) -> Address {
    extend_instance_ttl_default(e);
    e.storage().instance().get(&DataKey::Oracle).unwrap()
}

pub fn write_oracle(e: &Env, id: &Address) {
    e.storage().instance().set(&DataKey::Oracle, id);
    extend_instance_ttl_default(e);
}

pub fn read_option_counter(e: &Env) -> u32 {
    extend_instance_ttl_default(e);
    e.storage()
        .instance()
        .get(&DataKey::OptionCounter)
        .unwrap_or(0)
}

pub fn write_option_counter(e: &Env, counter: u32) {
    e.storage()
        .instance()
        .set(&DataKey::OptionCounter, &counter);
    extend_instance_ttl_default(e);
}

pub fn read_option(e: &Env, id: u32) -> OptionData {
    let key = DataKey::Option(id);
    extend_persistent_ttl_default(e, &key);
    e.storage().persistent().get(&key).unwrap()
}

pub fn write_option(e: &Env, id: u32, option: &OptionData) {
    let key = DataKey::Option(id);
    e.storage().persistent().set(&key, option);
    extend_persistent_ttl_default(e, &key);
}
