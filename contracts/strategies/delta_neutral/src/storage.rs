use soroban_sdk::{contracttype, Address, Env};

/// All persistent storage keys for the DeltaNeutral contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Contract admin address.
    Admin,
    /// USDC (or base-asset) token address.
    UsdcToken,
    /// Spot asset token address (e.g. XLM).
    SpotToken,
    /// AMM router contract address for spot leg.
    AmmRouter,
    /// Perpetuals exchange contract address for short leg.
    PerpExchange,
    /// Oracle contract address for price feeds.
    Oracle,
    /// Whether the contract has been initialised.
    Initialized,
    /// Whether the contract is paused.
    Paused,
    /// Per-user position data.
    Position(Address),
    /// Total USDC deposited across all users.
    TotalDeposited,
    /// Rebalance threshold in basis points (e.g. 500 = 5%).
    RebalanceThresholdBps,
}

/// Represents a single user's delta-neutral position.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    /// Owner of this position.
    pub owner: Address,
    /// USDC deposited by this user.
    pub usdc_deposited: i128,
    /// Spot asset amount held (long leg).
    pub spot_amount: i128,
    /// Notional size of the short perp position (in USDC, scaled 1e7).
    pub perp_notional: i128,
    /// Entry price of the spot asset when position was opened (scaled 1e7).
    pub entry_price: i128,
    /// Accumulated funding rate collected (scaled 1e7).
    pub funding_collected: i128,
    /// Whether this position is currently open.
    pub is_open: bool,
}

// ── Storage helpers ──────────────────────────────────────────────────────

use storage_helpers::{extend_instance_ttl_default, extend_persistent_ttl_default};

#[allow(dead_code)]
pub fn has_admin(e: &Env) -> bool {
    let has = e.storage().instance().has(&DataKey::Admin);
    if has {
        extend_instance_ttl_default(e);
    }
    has
}

pub fn read_admin(e: &Env) -> Address {
    extend_instance_ttl_default(e);
    e.storage().instance().get(&DataKey::Admin).unwrap()
}

pub fn write_admin(e: &Env, admin: &Address) {
    e.storage().instance().set(&DataKey::Admin, admin);
    extend_instance_ttl_default(e);
}

pub fn read_usdc_token(e: &Env) -> Address {
    extend_instance_ttl_default(e);
    e.storage().instance().get(&DataKey::UsdcToken).unwrap()
}

pub fn write_usdc_token(e: &Env, addr: &Address) {
    e.storage().instance().set(&DataKey::UsdcToken, addr);
    extend_instance_ttl_default(e);
}

pub fn read_spot_token(e: &Env) -> Address {
    extend_instance_ttl_default(e);
    e.storage().instance().get(&DataKey::SpotToken).unwrap()
}

pub fn write_spot_token(e: &Env, addr: &Address) {
    e.storage().instance().set(&DataKey::SpotToken, addr);
    extend_instance_ttl_default(e);
}

pub fn read_amm_router(e: &Env) -> Address {
    extend_instance_ttl_default(e);
    e.storage().instance().get(&DataKey::AmmRouter).unwrap()
}

pub fn write_amm_router(e: &Env, addr: &Address) {
    e.storage().instance().set(&DataKey::AmmRouter, addr);
    extend_instance_ttl_default(e);
}

pub fn read_perp_exchange(e: &Env) -> Address {
    extend_instance_ttl_default(e);
    e.storage().instance().get(&DataKey::PerpExchange).unwrap()
}

pub fn write_perp_exchange(e: &Env, addr: &Address) {
    e.storage().instance().set(&DataKey::PerpExchange, addr);
    extend_instance_ttl_default(e);
}

pub fn read_oracle(e: &Env) -> Address {
    extend_instance_ttl_default(e);
    e.storage().instance().get(&DataKey::Oracle).unwrap()
}

pub fn write_oracle(e: &Env, addr: &Address) {
    e.storage().instance().set(&DataKey::Oracle, addr);
    extend_instance_ttl_default(e);
}

pub fn is_initialized(e: &Env) -> bool {
    let init = e.storage()
        .instance()
        .get(&DataKey::Initialized)
        .unwrap_or(false);
    if init {
        extend_instance_ttl_default(e);
    }
    init
}

pub fn set_initialized(e: &Env) {
    e.storage().instance().set(&DataKey::Initialized, &true);
    extend_instance_ttl_default(e);
}

pub fn is_paused(e: &Env) -> bool {
    let paused = e.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        extend_instance_ttl_default(e);
    }
    paused
}

pub fn set_paused(e: &Env, paused: bool) {
    e.storage().instance().set(&DataKey::Paused, &paused);
    extend_instance_ttl_default(e);
}

pub fn read_position(e: &Env, owner: &Address) -> Option<Position> {
    let key = DataKey::Position(owner.clone());
    let pos_opt = e.storage().persistent().get(&key);
    if pos_opt.is_some() {
        extend_persistent_ttl_default(e, &key);
    }
    pos_opt
}

pub fn write_position(e: &Env, owner: &Address, pos: &Position) {
    let key = DataKey::Position(owner.clone());
    e.storage().persistent().set(&key, pos);
    extend_persistent_ttl_default(e, &key);
}

pub fn read_total_deposited(e: &Env) -> i128 {
    extend_instance_ttl_default(e);
    e.storage()
        .instance()
        .get(&DataKey::TotalDeposited)
        .unwrap_or(0)
}

pub fn write_total_deposited(e: &Env, amount: i128) {
    e.storage()
        .instance()
        .set(&DataKey::TotalDeposited, &amount);
    extend_instance_ttl_default(e);
}

pub fn read_rebalance_threshold_bps(e: &Env) -> i128 {
    extend_instance_ttl_default(e);
    e.storage()
        .instance()
        .get(&DataKey::RebalanceThresholdBps)
        .unwrap_or(500) // default 5%
}

pub fn write_rebalance_threshold_bps(e: &Env, bps: i128) {
    e.storage()
        .instance()
        .set(&DataKey::RebalanceThresholdBps, &bps);
    extend_instance_ttl_default(e);
}
