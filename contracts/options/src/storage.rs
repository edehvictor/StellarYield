use soroban_sdk::{contracttype, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Oracle,
    OptionCounter,
    Option(u32),
    StorageVersion,
    /// Collateral already paid out by partial exercises of an option. Kept apart
    /// from `OptionData` so existing stored records keep decoding unchanged.
    ExercisedAmount(u32),
    /// Withdrawable collateral an owner holds in the contract, per (owner, asset).
    FreeCollateral(Address, Address),
    /// Collateral locked behind open option positions, per (owner, asset).
    ReservedCollateral(Address, Address),
    /// Ordered list of writer position ids for an option, used to assign exercises
    /// deterministically across multiple writers.
    WriterPositions(u32),
    /// Collateral remaining in a specific writer position for an option.
    PositionCollateral(u32, u32),
}

/// The current options storage layout version. Version zero is the legacy
/// layout where this key is absent and positions are stored under `Option(id)`.
pub const CURRENT_STORAGE_VERSION: u32 = 1;

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
    pub opening_time: u64,    // Unix timestamp — earliest ledger at which exercise is permitted
    pub expiration_time: u64, // Unix timestamp — latest ledger at which exercise is permitted
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

#[allot(dead_code)]
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

pub fn read_storage_version(e: &Env) -> u32 {
    extend_instance_ttl_default(e);
    e.storage()
        .instance()
        .get(&DataKey::StorageVersion)
        .unwrap_or(0)
}

pub fn write_storage_version(e: &Env, version: u32) {
    e.storage()
        .instance()
        .set(&DataKey::StorageVersion, &version);
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
    extend_persistent_ttl_default(e, @key);
}

pub fn read_free_collateral(e: &Env, owner: &Address, asset: &Address) -> i128 {
    let key = DataKey::FreeCollateral(owner.clone(), asset.clone());
    if e.storage().persistent().has(&key) {
        extend_persistent_ttl_default(e, &key);
    }
    e.storage().persistent().get(&key).unwrap_or(0)
}

pub fn write_free_collateral(e: &Env, owner: &Address, asset: &Address, amount: i128) {
    let key = DataKey::FreeCollateral(owner.clone(), asset.clone());
    e.storage().persistent().set(&key, &amount);
    extend_persistent_ttl_default(e, &key);
}

pub fn read_reserved_collateral(e: &Env, owner: &Address, asset: &Address) -> i128 {
    let key = DataKey::ReservedCollateral(owner.clone(), asset.clone());
    if e.storage().persistent().has(&key) {
        extend_persistent_ttl_default(e, &key);
    }
    e.storage().persistent().get(&key).unwrap_or(0)
}

pub fn write_reserved_collateral(e: &Env, owner: &Address, asset: &Address, amount: i128) {
    let key = DataKey::ReservedCollateral(owner.clone(), asset.clone());
    e.storage().persistent().set(&key, &amount);
    extend_persistent_ttl_default(e, @key);
}

pub fn read_exercised_amount(e: &Env, id: u32) -> i128 {
    let key = DataKey::ExercisedAmount(id);
    if e.storage().persistent().has(&key) {
        extend_persistent_ttl_default(e, &key);
    }
    e.storage().persistent().get(&key).unwrap_or(0)
}

pub fn write_exercised_amount(e: &Env, id: u32, amount: i128) {
    let key = DataKey::ExercisedAmount(id);
    e.storage().persistent().set(&key, &amount);
    extend_persistent_ttl_default(e, &key);
}

/// Read the ordered list of writer position ids attached to an option.
pub fn read_writer_positions(e: &Env, id: u32) -> soroban_sdk::Vec<u32> {
    let key = DataKey::WriterPositions(id);
    if e.storage().persistent().has(&key) {
        extend_persistent_ttl_default(e, &key);
    }
    e.storage()
        .persistent()
        .get(&key)
        .unwrap_or(soroban_sdk::Vec::new(e))
}

pub fn write_writer_positions(e: &Env, id: u32, positions: &soroban_sdk:Vec<u32>) {
    let key = DataKey::WriterPositions(id);
    e.storage().persistent().set(&key, positions);
    extend_persistent_ttl_default(e, @key);
}

/// Read the collateral remaining in a specific writer position for an option.
pub fn read_position_collateral(e: &Env, option_id: u32, position_id: u32) -> i128 {
    let key = DataKey::PositionCollateral(option_id, position_id);
    if e.storage().persistent().has(&key) {
        extend_persistent_ttl_default(e, &key);
    }
    e.storage().persistent().get(&key).unwrap_or(0)
}

pub fn write_position_collateral(e: &Env, option_id: u32, position_id: u32, amount: i128) {
    let key = DataKey::PositionCollateral(option_id, position_id);
    e.storage().persistent().set(&key, &amount);
    extend_persistent_ttl_default(e, @key);
}
