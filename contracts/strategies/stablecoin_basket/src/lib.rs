#![no_std]

//! # Adaptive Stablecoin Basket Vault Strategy (#279)
//!
//! Routes capital across a basket of stablecoin yield opportunities based on:
//!   - Configured target weights per asset
//!   - Rebalancing threshold (minimum drift before rebalancing)
//!   - Maximum concentration cap per asset (allowlist-enforced)
//!
//! ## Security
//! - Only assets on the admin-managed allowlist are accepted.
//! - Rebalance threshold prevents dust-trade griefing.
//! - Concentration cap limits single-asset exposure.
//! - Admin-gated pause mechanism for emergency stops.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env, Vec};

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BasketError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    ZeroAmount = 4,
    Paused = 5,
    AssetNotAllowed = 6,
    ConcentrationCapExceeded = 7,
    WeightMismatch = 8,
    RebalanceNotNeeded = 9,
    InvalidWeight = 10,
    TooManyAssets = 11,
    InsufficientShares = 12,
    EmptyBasket = 13,
}

/// Maximum number of assets in the basket.
const MAX_ASSETS: u32 = 10;
/// Precision scalar — weights are expressed in basis points (10_000 = 100%).
const BPS: i128 = 10_000;

// ── Storage types ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct AssetConfig {
    pub token: Address,
    /// Target weight in basis points (must sum to BPS across all assets).
    pub weight_bps: i128,
    /// Maximum concentration in basis points (e.g. 3000 = 30%).
    pub max_concentration_bps: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetRedemption {
    pub token: Address,
    /// Proportional raw units transferred to the redeemer.
    pub amount: i128,
    /// Fractional remainder preserved in the vault to conserve assets under uneven decimals.
    pub remainder: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct BasketState {
    pub total_deposited: i128,
    pub asset_configs: Vec<AssetConfig>,
    /// Rebalance threshold in basis points — minimum drift to trigger rebalance.
    pub rebalance_threshold_bps: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Initialized,
    Paused,
    State,
    Allowlist(Address),
    Shares(Address),
    TotalShares,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct StablecoinBasketStrategy;

#[contractimpl]
impl StablecoinBasketStrategy {
    // ── Admin helpers ─────────────────────────────────────────────────────────

    fn read_admin(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    fn require_admin(env: &Env) -> Result<(), BasketError> {
        let admin = Self::read_admin(env);
        admin.require_auth();
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), BasketError> {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            Err(BasketError::Paused)
        } else {
            Ok(())
        }
    }

    fn require_initialized(env: &Env) -> Result<(), BasketError> {
        let init: bool = env
            .storage()
            .instance()
            .get(&DataKey::Initialized)
            .unwrap_or(false);
        if !init {
            Err(BasketError::NotInitialized)
        } else {
            Ok(())
        }
    }

    fn read_state(env: &Env) -> BasketState {
        env.storage().instance().get(&DataKey::State).unwrap()
    }

    fn write_state(env: &Env, state: &BasketState) {
        env.storage().instance().set(&DataKey::State, state);
    }

    fn read_total_shares(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0)
    }

    fn write_total_shares(env: &Env, shares: i128) {
        env.storage().instance().set(&DataKey::TotalShares, &shares);
    }

    fn read_user_shares(env: &Env, user: &Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Shares(user.clone()))
            .unwrap_or(0)
    }

    fn write_user_shares(env: &Env, user: &Address, shares: i128) {
        if shares <= 0 {
            env.storage()
                .instance()
                .remove(&DataKey::Shares(user.clone()));
        } else {
            env.storage()
                .instance()
                .set(&DataKey::Shares(user.clone()), &shares);
        }
    }

    // ── Initialisation ────────────────────────────────────────────────────────

    /// Initialise the basket strategy.
    ///
    /// `asset_configs` weights must sum to exactly 10,000 bps (100%).
    /// Each asset token must be added to the allowlist via `add_to_allowlist`
    /// before depositing — or pass the allowlist entries directly here.
    pub fn initialize(
        env: Env,
        admin: Address,
        asset_configs: Vec<AssetConfig>,
        rebalance_threshold_bps: i128,
    ) -> Result<(), BasketError> {
        if env
            .storage()
            .instance()
            .get::<_, bool>(&DataKey::Initialized)
            .unwrap_or(false)
        {
            return Err(BasketError::AlreadyInitialized);
        }
        if asset_configs.len() > MAX_ASSETS {
            return Err(BasketError::TooManyAssets);
        }

        // Validate weights sum to BPS
        let total_weight: i128 = asset_configs.iter().map(|a| a.weight_bps).sum();
        if total_weight != BPS {
            return Err(BasketError::WeightMismatch);
        }

        for config in asset_configs.iter() {
            if config.weight_bps <= 0
                || config.max_concentration_bps <= 0
                || config.max_concentration_bps > BPS
            {
                return Err(BasketError::InvalidWeight);
            }
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Paused, &false);

        // Add all configured assets to the allowlist
        for config in asset_configs.iter() {
            env.storage()
                .instance()
                .set(&DataKey::Allowlist(config.token.clone()), &true);
        }

        let state = BasketState {
            total_deposited: 0,
            asset_configs,
            rebalance_threshold_bps,
        };
        Self::write_state(&env, &state);
        Ok(())
    }

    // ── Allowlist management ──────────────────────────────────────────────────

    pub fn add_to_allowlist(env: Env, token: Address) -> Result<(), BasketError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Allowlist(token), &true);
        Ok(())
    }

    pub fn remove_from_allowlist(env: Env, token: Address) -> Result<(), BasketError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        env.storage().instance().remove(&DataKey::Allowlist(token));
        Ok(())
    }

    pub fn is_allowed(env: Env, token: Address) -> bool {
        env.storage()
            .instance()
            .get::<_, bool>(&DataKey::Allowlist(token))
            .unwrap_or(false)
    }

    // ── Pause / Unpause ───────────────────────────────────────────────────────

    pub fn pause(env: Env) -> Result<(), BasketError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), BasketError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    /// Deposit a single stablecoin asset into the basket.
    /// The asset must be on the allowlist and the resulting allocation must
    /// not exceed the asset's concentration cap.
    pub fn deposit(
        env: Env,
        depositor: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), BasketError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        depositor.require_auth();

        if amount <= 0 {
            return Err(BasketError::ZeroAmount);
        }

        let allowed: bool = env
            .storage()
            .instance()
            .get(&DataKey::Allowlist(token.clone()))
            .unwrap_or(false);
        if !allowed {
            return Err(BasketError::AssetNotAllowed);
        }

        let mut state = Self::read_state(&env);
        let new_total = state.total_deposited + amount;

        // Enforce concentration cap for this asset
        if let Some(config) = state.asset_configs.iter().find(|c| c.token == token) {
            let new_concentration_bps = if new_total > 0 {
                amount * BPS / new_total
            } else {
                BPS
            };
            if new_concentration_bps > config.max_concentration_bps {
                return Err(BasketError::ConcentrationCapExceeded);
            }
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&depositor, &env.current_contract_address(), &amount);

        let total_shares = Self::read_total_shares(&env);
        let shares_minted = if total_shares == 0 || state.total_deposited == 0 {
            amount
        } else {
            let minted = amount * total_shares / state.total_deposited;
            if minted > 0 {
                minted
            } else {
                1
            }
        };

        let current_user_shares = Self::read_user_shares(&env, &depositor);
        Self::write_user_shares(&env, &depositor, current_user_shares + shares_minted);
        Self::write_total_shares(&env, total_shares + shares_minted);

        state.total_deposited = new_total;
        Self::write_state(&env, &state);
        Ok(())
    }

    /// Mint shares directly for an account (Admin only).
    pub fn mint_shares(env: Env, to: Address, shares: i128) -> Result<(), BasketError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        if shares <= 0 {
            return Err(BasketError::ZeroAmount);
        }
        let total = Self::read_total_shares(&env);
        let current = Self::read_user_shares(&env, &to);
        Self::write_user_shares(&env, &to, current + shares);
        Self::write_total_shares(&env, total + shares);
        Ok(())
    }

    // ── Redemption ────────────────────────────────────────────────────────────

    /// Proportional multi-asset redemption from the basket.
    ///
    /// Liquidates `shares` and returns proportional raw-unit amounts of every
    /// configured basket asset.
    ///
    /// ## Asset Conservation Under Uneven Decimals
    /// Under uneven decimals (e.g. 6-decimal USDC vs 18-decimal DAI), raw units
    /// are calculated using floor division:
    /// `payout = (balance * shares) / total_shares`.
    /// The raw-unit remainder `(balance * shares) % total_shares` is explicitly
    /// preserved in the contract reserve to guarantee solvency and strict asset conservation.
    /// When the final outstanding shares are redeemed (`shares == total_shares`),
    /// the full remaining contract balance is distributed, preventing dust locking.
    ///
    /// ## Boundary and Error Behavior
    /// - Rejects `shares <= 0` with `BasketError::ZeroAmount` without state modifications.
    /// - Rejects calls when paused with `BasketError::Paused`.
    /// - Rejects calls when `total_shares == 0` with `BasketError::EmptyBasket`.
    /// - Rejects redemption exceeding user's share balance with `BasketError::InsufficientShares`.
    /// - If any token transfer fails, the transaction reverts atomically, preserving state.
    pub fn redeem(
        env: Env,
        redeemer: Address,
        shares: i128,
    ) -> Result<Vec<AssetRedemption>, BasketError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        redeemer.require_auth();

        if shares <= 0 {
            return Err(BasketError::ZeroAmount);
        }

        let total_shares = Self::read_total_shares(&env);
        if total_shares == 0 {
            return Err(BasketError::EmptyBasket);
        }

        let user_shares = Self::read_user_shares(&env, &redeemer);
        if shares > user_shares {
            return Err(BasketError::InsufficientShares);
        }

        let state = Self::read_state(&env);
        let mut redemptions = Vec::new(&env);
        let is_final = shares == total_shares;

        for config in state.asset_configs.iter() {
            let token_client = token::Client::new(&env, &config.token);
            let contract_bal = token_client.balance(&env.current_contract_address());

            let (payout, remainder) = if is_final {
                // Final redemption sweeps full remaining balance to prevent dust lock
                (contract_bal, 0)
            } else if contract_bal > 0 {
                let payout = contract_bal * shares / total_shares;
                let remainder = (contract_bal * shares) % total_shares;
                (payout, remainder)
            } else {
                (0, 0)
            };

            if payout > 0 {
                token_client.transfer(&env.current_contract_address(), &redeemer, &payout);
            }

            redemptions.push_back(AssetRedemption {
                token: config.token.clone(),
                amount: payout,
                remainder,
            });
        }

        // State update only occurs if all token transfers succeed
        Self::write_user_shares(&env, &redeemer, user_shares - shares);
        Self::write_total_shares(&env, total_shares - shares);

        let mut updated_state = state;
        if is_final {
            updated_state.total_deposited = 0;
        } else {
            let reduction = updated_state.total_deposited * shares / total_shares;
            updated_state.total_deposited = (updated_state.total_deposited - reduction).max(0);
        }
        Self::write_state(&env, &updated_state);

        Ok(redemptions)
    }

    /// Preview proportional multi-asset redemption without executing transfers.
    pub fn preview_redeem(env: Env, shares: i128) -> Result<Vec<AssetRedemption>, BasketError> {
        Self::require_initialized(&env)?;

        if shares <= 0 {
            return Err(BasketError::ZeroAmount);
        }

        let total_shares = Self::read_total_shares(&env);
        if total_shares == 0 {
            return Err(BasketError::EmptyBasket);
        }

        if shares > total_shares {
            return Err(BasketError::InsufficientShares);
        }

        let state = Self::read_state(&env);
        let mut redemptions = Vec::new(&env);
        let is_final = shares == total_shares;

        for config in state.asset_configs.iter() {
            let token_client = token::Client::new(&env, &config.token);
            let contract_bal = token_client.balance(&env.current_contract_address());

            let (payout, remainder) = if is_final {
                (contract_bal, 0)
            } else if contract_bal > 0 {
                let payout = contract_bal * shares / total_shares;
                let remainder = (contract_bal * shares) % total_shares;
                (payout, remainder)
            } else {
                (0, 0)
            };

            redemptions.push_back(AssetRedemption {
                token: config.token.clone(),
                amount: payout,
                remainder,
            });
        }

        Ok(redemptions)
    }

    // ── Rebalance ─────────────────────────────────────────────────────────────

    /// Compute the rebalance deltas without executing transfers.
    /// Returns `(token, current_bps, target_bps, delta_amount)` for each asset
    /// that deviates beyond the rebalance threshold.
    ///
    /// A positive delta means the strategy should acquire more of that asset;
    /// negative means it should reduce exposure.
    pub fn compute_rebalance_deltas(
        env: Env,
    ) -> Result<Vec<(Address, i128, i128, i128)>, BasketError> {
        Self::require_initialized(&env)?;
        let state = Self::read_state(&env);
        let total = state.total_deposited;

        let mut deltas: Vec<(Address, i128, i128, i128)> = Vec::new(&env);

        if total == 0 {
            return Ok(deltas);
        }

        for config in state.asset_configs.iter() {
            let token_client = token::Client::new(&env, &config.token);
            let current_balance = token_client.balance(&env.current_contract_address());
            let current_bps = current_balance * BPS / total;
            let drift = (config.weight_bps - current_bps).abs();

            if drift >= state.rebalance_threshold_bps {
                let target_amount = total * config.weight_bps / BPS;
                let delta = target_amount - current_balance;
                deltas.push_back((config.token.clone(), current_bps, config.weight_bps, delta));
            }
        }

        if deltas.is_empty() {
            return Err(BasketError::RebalanceNotNeeded);
        }

        Ok(deltas)
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    pub fn get_state(env: Env) -> Result<BasketState, BasketError> {
        Self::require_initialized(&env)?;
        Ok(Self::read_state(&env))
    }

    pub fn total_deposited(env: Env) -> i128 {
        env.storage()
            .instance()
            .get::<_, BasketState>(&DataKey::State)
            .map(|s| s.total_deposited)
            .unwrap_or(0)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn get_user_shares(env: Env, user: Address) -> i128 {
        Self::read_user_shares(&env, &user)
    }

    pub fn get_total_shares(env: Env) -> i128 {
        Self::read_total_shares(&env)
    }
}

#[cfg(test)]
mod tests;
