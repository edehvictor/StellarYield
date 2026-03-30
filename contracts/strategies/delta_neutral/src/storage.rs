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

pub fn has_admin(e: &Env) -> bool {
    e.storage().instance().has(&DataKey::Admin)
}

pub fn read_admin(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Admin).unwrap()
}

pub fn write_admin(e: &Env, admin: &Address) {
    e.storage().instance().set(&DataKey::Admin, admin);
}

pub fn read_usdc_token(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::UsdcToken).unwrap()
}

pub fn write_usdc_token(e: &Env, addr: &Address) {
    e.storage().instance().set(&DataKey::UsdcToken, addr);
}

pub fn read_spot_token(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::SpotToken).unwrap()
}

pub fn write_spot_token(e: &Env, addr: &Address) {
    e.storage().instance().set(&DataKey::SpotToken, addr);
}

pub fn read_amm_router(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::AmmRouter).unwrap()
}

pub fn write_amm_router(e: &Env, addr: &Address) {
    e.storage().instance().set(&DataKey::AmmRouter, addr);
}

pub fn read_perp_exchange(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::PerpExchange).unwrap()
}

pub fn write_perp_exchange(e: &Env, addr: &Address) {
    e.storage().instance().set(&DataKey::PerpExchange, addr);
}

pub fn read_oracle(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Oracle).unwrap()
}

pub fn write_oracle(e: &Env, addr: &Address) {
    e.storage().instance().set(&DataKey::Oracle, addr);
}

pub fn is_initialized(e: &Env) -> bool {
    e.storage()
        .instance()
        .get(&DataKey::Initialized)
        .unwrap_or(false)
}

pub fn set_initialized(e: &Env) {
    e.storage().instance().set(&DataKey::Initialized, &true);
}

pub fn is_paused(e: &Env) -> bool {
    e.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(e: &Env, paused: bool) {
    e.storage().instance().set(&DataKey::Paused, &paused);
}

pub fn read_position(e: &Env, owner: &Address) -> Option<Position> {
    e.storage()
        .persistent()
        .get(&DataKey::Position(owner.clone()))
}

pub fn write_position(e: &Env, owner: &Address, pos: &Position) {
    e.storage()
        .persistent()
        .set(&DataKey::Position(owner.clone()), pos);
}

pub fn read_total_deposited(e: &Env) -> i128 {
    e.storage()
        .instance()
        .get(&DataKey::TotalDeposited)
        .unwrap_or(0)
}

pub fn write_total_deposited(e: &Env, amount: i128) {
    e.storage()
        .instance()
        .set(&DataKey::TotalDeposited, &amount);
}

pub fn read_rebalance_threshold_bps(e: &Env) -> i128 {
    e.storage()
        .instance()
        .get(&DataKey::RebalanceThresholdBps)
        .unwrap_or(500) // default 5%
}

pub fn write_rebalance_threshold_bps(e: &Env, bps: i128) {
    e.storage()
        .instance()
        .set(&DataKey::RebalanceThresholdBps, &bps);
}
