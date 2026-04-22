#![no_std]
#![allow(clippy::arithmetic_side_effects, clippy::unwrap_used)]

//! # YieldVault — Core Soroban Vault for Automated Rebalancing
//!
//! Accepts user deposits of SAC tokens (XLM, USDC, etc.), tracks ownership
//! via LP-style vault shares, and exposes an admin-gated `rebalance`
//! function for moving funds across liquidity pools.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, vec, Address, Bytes,
    Env, IntoVal, Symbol, Val,
};
#[path = "../../interfaces/vault_standard.rs"]
mod vault_standard;
use vault_standard::VaultStandard;

// ── Storage keys ────────────────────────────────────────────────────────

#[contracttype]
enum DataKey {
    Admin,
    Token,
    TotalShares,
    TotalAssets,
    Shares(Address),
    Initialized,
    // Strategy keys
    RewardProtocol,
    RewardToken,
    DexRouter,
    TotalHarvested,
    Keeper,
    Paused,
    Timelock(Symbol), // Key for different timelocked actions
    PendingAdmin,
    Oracle,
    // Emergency settings
    EmergencyPenaltyBps, // optional haircut on withdrawals during emergency
}

mod admin;
mod emergency;
mod fees;
mod flashloan;
mod keeper;
mod oracle;
mod referrals;
mod verification;

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    ZeroAmount = 3,
    InsufficientShares = 4,
    Unauthorized = 5,
    ZeroSupply = 6,
    Paused = 7,
    TimelockActive = 8,
    InvalidPrice = 9,
    SlippageExceeded = 10,
}

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct YieldVault;

#[contractimpl]
impl YieldVault {
    // ── Initialisation ──────────────────────────────────────────────

    /// Initialise the vault with an admin (strategy) address and the
    /// deposit token address.
    ///
    /// Can only be called once. The admin is the sole address allowed to
    /// call `rebalance`.
    ///
    /// # Arguments
    /// * `admin` — The strategy / admin address that controls rebalancing.
    /// * `token` — The SAC token address accepted for deposits (e.g. USDC).
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), VaultError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(VaultError::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        env.storage().instance().set(&DataKey::TotalAssets, &0i128);
        env.storage().instance().set(&DataKey::Initialized, &true);

        env.events()
            .publish((symbol_short!("init"),), (admin.clone(), token.clone()));

        Ok(())
    }

    // ── Deposits ────────────────────────────────────────────────────

    /// Deposit `amount` of the vault token and receive proportional vault
    /// shares in return.
    ///
    /// The first depositor sets the 1:1 ratio (shares == assets). All
    /// subsequent deposits receive shares proportional to their
    /// contribution relative to total vault assets.
    ///
    /// Deposit `amount` of the vault token and receive proportional vault
    /// shares in return.
    ///
    /// # Arguments
    /// * `from`   - The depositor's address (must authorise the call).
    /// * `amount` - The quantity of tokens to deposit (must be > 0).
    /// * `min_shares_out` - Minimum acceptable shares minted, otherwise revert.
    ///
    /// # Returns
    /// The number of vault shares minted for this deposit.
    ///
    /// # Security
    /// Shares are calculated as `(amount * total_shares) / total_assets`.
    /// First deposit is 1:1.
    pub fn deposit(
        env: Env,
        from: Address,
        amount: i128,
        min_shares_out: i128,
    ) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        from.require_auth();
        if Self::is_paused(&env) {
            return Err(VaultError::Paused);
        }

        if amount <= 0 {
            return Err(VaultError::ZeroAmount);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap();
        let total_assets: i128 = env.storage().instance().get(&DataKey::TotalAssets).unwrap();

        // Get secure price for validation (flash-loan resistance)
        let _price = Self::get_secure_price(&env)?;

        let shares = Self::preview_deposit(env.clone(), amount)?;

        if shares <= 0 {
            return Err(VaultError::ZeroAmount);
        }
        if shares < min_shares_out {
            return Err(VaultError::SlippageExceeded);
        }

        // Transfer tokens from depositor to vault
        let client = token::Client::new(&env, &token_addr);
        client.transfer(&from, &env.current_contract_address(), &amount);

        // Update state
        let user_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Shares(from.clone()))
            .unwrap_or(0);

        env.storage()
            .persistent()
            .set(&DataKey::Shares(from.clone()), &(user_shares + shares));
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &(total_shares + shares));
        env.storage()
            .instance()
            .set(&DataKey::TotalAssets, &(total_assets + amount));

        env.events()
            .publish((symbol_short!("deposit"),), (from, amount, shares));

        Ok(shares)
    }

    /// Deposit vault tokens held by a `payer` contract (for example the Zap
    /// contract after a DEX swap) and mint shares to `beneficiary`.
    ///
    /// # Arguments
    ///
    /// * `payer`       — Address that holds the vault token and must authorize
    ///   (typically a router or Zap contract).
    /// * `beneficiary` — Receives the newly minted vault shares.
    /// * `amount`      — Amount of vault token to move from `payer` into the vault.
    /// * `min_shares_out` — Minimum acceptable shares minted, otherwise revert.
    ///
    /// # Returns
    ///
    /// The number of vault shares minted to `beneficiary`.
    ///
    /// # Security
    ///
    /// Only `payer` may initiate the transfer. Share accounting uses
    /// `beneficiary`, not `payer`, so end users receive positions when a
    /// contract routes funds on their behalf.
    pub fn deposit_for(
        env: Env,
        payer: Address,
        beneficiary: Address,
        amount: i128,
        min_shares_out: i128,
    ) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        payer.require_auth();
        if Self::is_paused(&env) {
            return Err(VaultError::Paused);
        }

        if amount <= 0 {
            return Err(VaultError::ZeroAmount);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap();
        let total_assets: i128 = env.storage().instance().get(&DataKey::TotalAssets).unwrap();

        let _price = Self::get_secure_price(&env)?;

        let shares = Self::preview_deposit(env.clone(), amount)?;

        if shares <= 0 {
            return Err(VaultError::ZeroAmount);
        }
        if shares < min_shares_out {
            return Err(VaultError::SlippageExceeded);
        }

        let client = token::Client::new(&env, &token_addr);
        client.transfer(&payer, &env.current_contract_address(), &amount);

        let beneficiary_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Shares(beneficiary.clone()))
            .unwrap_or(0);

        env.storage().persistent().set(
            &DataKey::Shares(beneficiary.clone()),
            &(beneficiary_shares + shares),
        );
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &(total_shares + shares));
        env.storage()
            .instance()
            .set(&DataKey::TotalAssets, &(total_assets + amount));

        env.events().publish(
            (symbol_short!("dep_for"),),
            (payer, beneficiary, amount, shares),
        );

        Ok(shares)
    }

    // ── Withdrawals ─────────────────────────────────────────────────

    /// Burn `shares` vault shares and receive the proportional amount of
    /// underlying tokens.
    ///
    /// # Arguments
    /// * `to`     - The recipient address (must authorise the call).
    /// * `shares` - Number of vault shares to redeem (must be > 0).
    ///
    /// # Returns
    /// The amount of underlying tokens transferred to the user.
    ///
    /// # Security
    /// Replaces standard zero-check with error. Uses secure price from oracle.
    pub fn withdraw(env: Env, to: Address, shares: i128) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        to.require_auth();

        if shares <= 0 {
            return Err(VaultError::ZeroAmount);
        }

        let user_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Shares(to.clone()))
            .unwrap_or(0);

        if user_shares < shares {
            return Err(VaultError::InsufficientShares);
        }

        let total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap();
        let total_assets: i128 = env.storage().instance().get(&DataKey::TotalAssets).unwrap();

        if total_shares == 0 {
            return Err(VaultError::ZeroSupply);
        }

        // Get secure price for validation
        let _price = Self::get_secure_price(&env)?;

        let amount = Self::convert_to_assets(env.clone(), shares)?;

        // Transfer tokens to user
        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        client.transfer(&env.current_contract_address(), &to, &amount);

        // Update state
        env.storage()
            .persistent()
            .set(&DataKey::Shares(to.clone()), &(user_shares - shares));
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &(total_shares - shares));
        env.storage()
            .instance()
            .set(&DataKey::TotalAssets, &(total_assets - amount));

        env.events()
            .publish((symbol_short!("withdraw"),), (to, amount, shares));

        Ok(amount)
    }

    // ── Rebalancing (admin only) ────────────────────────────────────

    /// Move `amount` tokens from the vault to a target protocol address.
    ///
    /// This is the core rebalancing primitive — only callable by the
    /// contract admin (strategy address). The strategy off-chain logic
    /// determines *where* to allocate; this function executes the transfer.
    ///
    /// Move `amount` tokens from the vault to a target protocol address.
    ///
    /// # Arguments
    /// * `caller` - Must be the admin address.
    /// * `target` - The protocol / pool address to send funds to.
    /// * `amount` - Amount of tokens to move.
    ///
    /// # Security
    /// Only the admin can call this. Assets are tracked to reflect output.
    ///
    /// # Invariants
    /// rebalance_amount <= total_assets
    pub fn rebalance(
        env: Env,
        caller: Address,
        target: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        Self::require_init(&env)?;
        caller.require_auth();
        if Self::is_paused(&env) {
            return Err(VaultError::Paused);
        }

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            return Err(VaultError::Unauthorized);
        }

        if amount <= 0 {
            return Err(VaultError::ZeroAmount);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let total_assets: i128 = env.storage().instance().get(&DataKey::TotalAssets).unwrap();

        let client = token::Client::new(&env, &token_addr);
        client.transfer(&env.current_contract_address(), &target, &amount);

        // Update tracked assets to reflect funds sent out
        env.storage()
            .instance()
            .set(&DataKey::TotalAssets, &(total_assets - amount));

        env.events()
            .publish((symbol_short!("rebal"),), (target, amount));

        Ok(())
    }

    /// Transfer vault shares from one address to another.
    ///
    /// # Arguments
    /// * `from`   — The sender of shares (must authorise).
    /// * `to`     — The recipient of shares.
    /// * `amount` — Number of shares to transfer.
    pub fn transfer_shares(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        from.require_auth();
        if amount <= 0 {
            return Err(VaultError::ZeroAmount);
        }

        let from_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Shares(from.clone()))
            .unwrap_or(0);

        if from_shares < amount {
            return Err(VaultError::InsufficientShares);
        }

        let to_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Shares(to.clone()))
            .unwrap_or(0);

        env.storage()
            .persistent()
            .set(&DataKey::Shares(from.clone()), &(from_shares - amount));
        env.storage()
            .persistent()
            .set(&DataKey::Shares(to.clone()), &(to_shares + amount));

        env.events()
            .publish((symbol_short!("tr_sh"),), (from, to, amount));

        Ok(())
    }

    // ── View functions ──────────────────────────────────────────────

    /// Returns the number of vault shares held by `user`.
    pub fn get_shares(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Shares(user))
            .unwrap_or(0)
    }

    /// Returns the total vault shares in circulation.
    pub fn total_shares(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0)
    }

    /// Returns the total assets held by the vault.
    pub fn total_assets(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0)
    }

    /// Returns the admin address.
    pub fn get_admin(env: Env) -> Result<Address, VaultError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::Admin).unwrap())
    }

    /// Returns the deposit token address.
    pub fn get_token(env: Env) -> Result<Address, VaultError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::Token).unwrap())
    }

    // ── Strategy: Harvest & Auto-Compound ───────────────────────────

    /// Configure the strategy parameters. Admin-only.
    pub fn configure_strategy(
        env: Env,
        admin: Address,
        reward_protocol: Address,
        reward_token: Address,
        dex_router: Address,
        keeper: Address,
    ) -> Result<(), VaultError> {
        Self::require_init(&env)?;
        Self::require_admin(&env, &admin)?;
        env.storage()
            .instance()
            .set(&DataKey::RewardProtocol, &reward_protocol);
        env.storage()
            .instance()
            .set(&DataKey::RewardToken, &reward_token);
        env.storage()
            .instance()
            .set(&DataKey::DexRouter, &dex_router);
        env.storage().instance().set(&DataKey::Keeper, &keeper);
        if !env.storage().instance().has(&DataKey::TotalHarvested) {
            env.storage()
                .instance()
                .set(&DataKey::TotalHarvested, &0i128);
        }

        env.events().publish(
            (symbol_short!("strat_cfg"),),
            (reward_protocol, reward_token, dex_router, keeper),
        );
        Ok(())
    }

    /// Harvest rewards, swap for base asset, and auto-compound.
    ///
    /// # Arguments
    /// * `caller`         - Admin, legacy keeper, or registered keeper.
    /// * `min_amount_out` - Slippage protection for DEX swap.
    ///
    /// # Returns
    /// Net auto-compounded amount.
    ///
    /// # Security
    /// Re-entrancy protected via Soroban environment.
    pub fn harvest(env: Env, caller: Address, min_amount_out: i128) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        let legacy_keeper: Option<Address> = env.storage().instance().get(&DataKey::Keeper);
        let is_admin = caller == admin;
        let is_legacy_keeper = match &legacy_keeper {
            Some(k) => k == &caller,
            None => false,
        };
        let is_registered = Self::is_registered_keeper(&env, &caller);
        if !is_admin && !is_legacy_keeper && !is_registered {
            return Err(VaultError::Unauthorized);
        }
        let base_token: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let reward_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::RewardToken)
            .ok_or(VaultError::NotInitialized)?;
        let reward_protocol: Address = env
            .storage()
            .instance()
            .get(&DataKey::RewardProtocol)
            .ok_or(VaultError::NotInitialized)?;
        let dex_router: Address = env
            .storage()
            .instance()
            .get(&DataKey::DexRouter)
            .ok_or(VaultError::NotInitialized)?;

        // Step 1: Claim rewards from underlying protocol
        let vault_addr = env.current_contract_address();
        let claim_args: soroban_sdk::Vec<Val> = vec![&env, vault_addr.clone().into_val(&env)];
        env.invoke_contract::<()>(
            &reward_protocol,
            &Symbol::new(&env, "claim_rewards"),
            claim_args,
        );

        // Step 2: Check reward balance
        let reward_client = token::Client::new(&env, &reward_token);
        let reward_balance = reward_client.balance(&vault_addr);
        if reward_balance <= 0 {
            return Ok(0);
        }

        // Step 3: Swap rewards for base asset via DEX router
        let swap_args: soroban_sdk::Vec<Val> = vec![
            &env,
            reward_token.into_val(&env),
            base_token.into_val(&env),
            reward_balance.into_val(&env),
            min_amount_out.into_val(&env),
        ];
        let amount_out: i128 =
            env.invoke_contract(&dex_router, &Symbol::new(&env, "swap"), swap_args);

        // Step 4: Calculate keeper fee (only for non-admin callers)
        let keeper_fee = if !is_admin {
            Self::calculate_keeper_fee(&env, amount_out)
        } else {
            0i128
        };
        let net_amount = amount_out - keeper_fee;

        // Step 5: Pay keeper fee if applicable
        if keeper_fee > 0 {
            let base_client = token::Client::new(&env, &base_token);
            base_client.transfer(&env.current_contract_address(), &caller, &keeper_fee);
        }

        // Step 6: Auto-compound net amount (increase TVL, no new shares)
        let total_assets: i128 = env.storage().instance().get(&DataKey::TotalAssets).unwrap();
        env.storage()
            .instance()
            .set(&DataKey::TotalAssets, &(total_assets + net_amount));
        let total_harvested: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalHarvested)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalHarvested, &(total_harvested + net_amount));

        env.events().publish(
            (symbol_short!("harvest"),),
            (caller, reward_balance, amount_out, keeper_fee),
        );
        Ok(net_amount)
    }

    /// Return total harvested amount.
    pub fn total_harvested(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalHarvested)
            .unwrap_or(0)
    }

    // ── Flash Loans ─────────────────────────────────────────────────

    /// Execute a flash loan.
    ///
    /// # Arguments
    /// * `initiator` — Address initiating the flash loan (must authorize)
    /// * `receiver` — Contract address that will receive and repay the loan
    /// * `amount` — Amount to borrow
    /// * `params` — Arbitrary data to pass to receiver
    ///
    /// # Returns
    /// The premium fee collected
    pub fn flash_loan(
        env: Env,
        initiator: Address,
        receiver: Address,
        amount: i128,
        params: Bytes,
    ) -> Result<i128, VaultError> {
        Self::flash_loan_impl(&env, &initiator, &receiver, amount, &params)
    }

    /// View function: calculate flash loan fee for a given amount.
    pub fn get_flash_loan_fee(_env: Env, amount: i128) -> i128 {
        Self::calc_flash_fee(amount)
    }

    /// View function: get maximum available flash loan amount.
    pub fn get_max_flash_loan(env: Env) -> Result<i128, VaultError> {
        Self::max_flash_amount(&env)
    }

    // ── Emergency Withdrawals ────────────────────────────────────────

    /// Admin: set emergency penalty bps [0..=10_000].
    pub fn set_emergency_penalty(
        env: Env,
        admin: Address,
        penalty_bps: u32,
    ) -> Result<(), VaultError> {
        YieldVault::set_emergency_penalty_impl(&env, &admin, penalty_bps)
    }

    /// Emergency withdraw from idle reserves only; may apply penalty.
    pub fn emergency_withdraw(env: Env, to: Address, shares: i128) -> Result<i128, VaultError> {
        YieldVault::emergency_withdraw_impl(&env, &to, shares)
    }
    // ── Referral System ─────────────────────────────────────────────

    /// Register a referral relationship.
    pub fn register_referral(
        env: Env,
        referee: Address,
        referrer: Address,
    ) -> Result<(), VaultError> {
        Self::register_referral_impl(env, referee, referrer)
    }

    /// Deposit with an optional referrer.
    pub fn deposit_with_referral(
        env: Env,
        from: Address,
        amount: i128,
        referrer: Address,
    ) -> Result<i128, VaultError> {
        Self::deposit_with_referral_impl(env, from, amount, referrer)
    }

    /// Claim accumulated referral rewards.
    pub fn claim_referral_rewards(env: Env, referrer: Address) -> Result<i128, VaultError> {
        Self::claim_referral_rewards_impl(env, referrer)
    }

    /// Set referral fee (admin only).
    pub fn set_referral_fee(env: Env, admin: Address, fee_bps: i128) -> Result<(), VaultError> {
        Self::set_referral_fee_impl(env, admin, fee_bps)
    }

    /// Get referrer for a given address.
    pub fn get_referrer(env: Env, referee: Address) -> Option<Address> {
        Self::get_referrer_view(env, referee)
    }

    /// Get referred TVL for a referrer.
    pub fn get_referred_tvl(env: Env, referrer: Address) -> i128 {
        Self::get_referred_tvl_view(env, referrer)
    }

    /// Get unclaimed referral rewards.
    pub fn get_referral_rewards(env: Env, referrer: Address) -> i128 {
        Self::get_referral_rewards_view(env, referrer)
    }

    /// Get referral fee in basis points.
    pub fn get_referral_fee_bps(env: Env) -> i128 {
        Self::get_referral_fee_bps_view(env)
    }

    /// Get total referral rewards distributed.
    pub fn get_total_referral_rewards(env: Env) -> i128 {
        Self::get_total_referral_rewards_view(env)
    }

    // ── Internal ────────────────────────────────────────────────────

    fn require_init(env: &Env) -> Result<(), VaultError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(VaultError::NotInitialized);
        }
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), VaultError> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(VaultError::NotInitialized)?;
        if *caller != admin {
            return Err(VaultError::Unauthorized);
        }
        Ok(())
    }
}

impl VaultStandard for YieldVault {
    fn total_assets(env: Env) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0))
    }

    fn convert_to_shares(env: Env, assets: i128) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        if assets <= 0 {
            return Ok(0);
        }
        let total_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0);
        let total_assets: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);
        if total_shares == 0 || total_assets == 0 {
            return Ok(assets);
        }
        let numerator = assets * total_shares;
        Ok((numerator + total_assets - 1) / total_assets)
    }

    fn convert_to_assets(env: Env, shares: i128) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        if shares <= 0 {
            return Ok(0);
        }
        let total_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0);
        let total_assets: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);
        if total_shares == 0 {
            return Err(VaultError::ZeroSupply);
        }
        Ok((shares * total_assets) / total_shares)
    }

    fn preview_deposit(env: Env, assets: i128) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        if assets <= 0 {
            return Err(VaultError::ZeroAmount);
        }
        let total_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0);
        let total_assets: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);
        if total_shares == 0 || total_assets == 0 {
            return Ok(assets);
        }
        let numerator = assets * total_shares;
        Ok((numerator + total_assets - 1) / total_assets)
    }

    fn preview_withdraw(env: Env, shares: i128) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        if shares <= 0 {
            return Err(VaultError::ZeroAmount);
        }
        let total_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0);
        if total_shares == 0 {
            return Err(VaultError::ZeroSupply);
        }
        let total_assets: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);
        Ok((shares * total_assets) / total_shares)
    }

    fn preview_redeem(env: Env, assets: i128) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        if assets <= 0 {
            return Err(VaultError::ZeroAmount);
        }
        let total_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0);
        let total_assets: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);
        if total_shares == 0 || total_assets == 0 {
            return Ok(assets);
        }
        let numerator = assets * total_shares;
        Ok((numerator + total_assets - 1) / total_assets)
    }

    fn share_price(env: Env) -> Result<i128, VaultError> {
        Self::require_init(&env)?;
        let total_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0);
        if total_shares == 0 {
            return Ok(1_000_000_000_000_000_000i128);
        }
        let total_assets: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);
        Ok((total_assets * 1_000_000_000_000_000_000i128) / total_shares)
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{contract, contractimpl, Env};

    #[contract]
    struct ContractWallet;

    #[contractimpl]
    impl ContractWallet {
        pub fn ping(_env: Env) {}
    }

    fn setup_env() -> (Env, YieldVaultClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(YieldVault, ());
        let client = YieldVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();

        client.initialize(&admin, &token_addr);

        (env, client, admin, token_addr, token_admin)
    }

    fn mint_tokens(env: &Env, token_addr: &Address, _admin: &Address, to: &Address, amount: i128) {
        let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    #[test]
    fn test_initialize() {
        let (_, client, admin, token_addr, _) = setup_env();
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_token(), token_addr);
        assert_eq!(client.total_shares(), 0);
        assert_eq!(client.total_assets(), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let (env, client, admin, token_addr, _) = setup_env();
        let new_admin = Address::generate(&env);
        let _ = admin;
        client.initialize(&new_admin, &token_addr);
    }

    #[test]
    fn test_deposit_first_user() {
        let (env, client, _, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);
        mint_tokens(&env, &token_addr, &token_admin, &user, 1000);

        let shares = client.deposit(&user, &1000, &1000);
        assert_eq!(shares, 1000); // 1:1 for first deposit
        assert_eq!(client.get_shares(&user), 1000);
        assert_eq!(client.total_shares(), 1000);
        assert_eq!(client.total_assets(), 1000);
    }

    #[test]
    fn test_deposit_second_user_proportional() {
        let (env, client, _, token_addr, token_admin) = setup_env();
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);

        mint_tokens(&env, &token_addr, &token_admin, &user1, 1000);
        mint_tokens(&env, &token_addr, &token_admin, &user2, 500);

        client.deposit(&user1, &1000, &1000);
        let shares2 = client.deposit(&user2, &500, &500);

        assert_eq!(shares2, 500); // proportional to existing ratio
        assert_eq!(client.total_shares(), 1500);
        assert_eq!(client.total_assets(), 1500);
    }

    #[test]
    fn test_deposit_accepts_contract_wallet_address() {
        let (env, client, _, token_addr, token_admin) = setup_env();
        let contract_wallet = env.register(ContractWallet, ());

        mint_tokens(&env, &token_addr, &token_admin, &contract_wallet, 1000);

        let shares = client.deposit(&contract_wallet, &1000, &1000);
        assert_eq!(shares, 1000);
        assert_eq!(client.get_shares(&contract_wallet), 1000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_deposit_zero_panics() {
        let (env, client, _, _, _) = setup_env();
        let user = Address::generate(&env);
        client.deposit(&user, &0, &0);
    }

    #[test]
    fn test_withdraw() {
        let (env, client, _, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);
        mint_tokens(&env, &token_addr, &token_admin, &user, 1000);

        client.deposit(&user, &1000, &1000);
        let amount = client.withdraw(&user, &500);

        assert_eq!(amount, 500);
        assert_eq!(client.get_shares(&user), 500);
        assert_eq!(client.total_shares(), 500);
        assert_eq!(client.total_assets(), 500);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_withdraw_insufficient_shares_panics() {
        let (env, client, _, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);
        mint_tokens(&env, &token_addr, &token_admin, &user, 1000);

        client.deposit(&user, &1000, &1000);
        client.withdraw(&user, &2000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_withdraw_zero_panics() {
        let (env, client, _, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);
        mint_tokens(&env, &token_addr, &token_admin, &user, 1000);

        client.deposit(&user, &1000, &1000);
        client.withdraw(&user, &0);
    }

    #[test]
    fn test_rebalance_by_admin() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);
        let target_pool = Address::generate(&env);

        mint_tokens(&env, &token_addr, &token_admin, &user, 1000);
        client.deposit(&user, &1000, &1000);

        client.rebalance(&admin, &target_pool, &300);

        // Token balance of target should have 300
        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&target_pool), 300);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_rebalance_by_non_admin_panics() {
        let (env, client, _, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);
        let target = Address::generate(&env);
        let impostor = Address::generate(&env);

        mint_tokens(&env, &token_addr, &token_admin, &user, 1000);
        client.deposit(&user, &1000, &1000);

        client.rebalance(&impostor, &target, &100);
    }

    #[test]
    fn test_full_lifecycle() {
        let (env, client, admin, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);
        let pool = Address::generate(&env);

        // Deposit
        mint_tokens(&env, &token_addr, &token_admin, &user, 5000);
        client.deposit(&user, &5000, &5000);
        assert_eq!(client.get_shares(&user), 5000);

        // Rebalance some to pool
        client.rebalance(&admin, &pool, &2000);

        // Withdraw remaining shares
        let withdrawn = client.withdraw(&user, &5000);
        // User gets proportional amount of what's left in vault
        assert_eq!(withdrawn, 3000);
        assert_eq!(client.get_shares(&user), 0);
        assert_eq!(client.total_shares(), 0);
    }

    #[test]
    fn test_get_shares_unregistered_user() {
        let (env, client, _, _, _) = setup_env();
        let unknown = Address::generate(&env);
        assert_eq!(client.get_shares(&unknown), 0);
    }

    // ── Referral Tests ───────────────────────────────────────────────

    #[test]
    fn test_register_referral() {
        let (env, client, _, _, _) = setup_env();
        let referee = Address::generate(&env);
        let referrer = Address::generate(&env);

        client.register_referral(&referee, &referrer);

        assert_eq!(client.get_referrer(&referee), Some(referrer));
    }

    #[test]
    fn test_register_referral_self_referral_fails() {
        let (env, client, _, _, _) = setup_env();
        let user = Address::generate(&env);

        let result = client.try_register_referral(&user, &user);
        assert!(result.is_err());
    }

    #[test]
    fn test_register_referral_first_referrer_wins() {
        let (env, client, _, _, _) = setup_env();
        let referee = Address::generate(&env);
        let referrer1 = Address::generate(&env);
        let referrer2 = Address::generate(&env);

        client.register_referral(&referee, &referrer1);
        client.register_referral(&referee, &referrer2);

        // First referrer should stick
        assert_eq!(client.get_referrer(&referee), Some(referrer1));
    }

    #[test]
    fn test_deposit_with_referral() {
        let (env, client, _, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);
        let referrer = Address::generate(&env);

        mint_tokens(&env, &token_addr, &token_admin, &user, 1000);

        let shares = client.deposit_with_referral(&user, &1000, &referrer);
        assert_eq!(shares, 1000);
        assert_eq!(client.get_referrer(&user), Some(referrer.clone()));
        assert_eq!(client.get_referred_tvl(&referrer), 1000);
    }

    #[test]
    fn test_deposit_with_referral_self_skips_referral() {
        let (env, client, _, token_addr, token_admin) = setup_env();
        let user = Address::generate(&env);

        mint_tokens(&env, &token_addr, &token_admin, &user, 1000);

        let shares = client.deposit_with_referral(&user, &1000, &user);
        assert_eq!(shares, 1000);
        assert_eq!(client.get_referrer(&user), None);
        assert_eq!(client.get_referred_tvl(&user), 0);
    }

    #[test]
    fn test_deposit_with_referral_accumulates_tvl() {
        let (env, client, _, token_addr, token_admin) = setup_env();
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let referrer = Address::generate(&env);

        mint_tokens(&env, &token_addr, &token_admin, &user1, 500);
        mint_tokens(&env, &token_addr, &token_admin, &user2, 700);

        client.deposit_with_referral(&user1, &500, &referrer);
        client.deposit_with_referral(&user2, &700, &referrer);

        assert_eq!(client.get_referred_tvl(&referrer), 1200);
    }

    #[test]
    fn test_accrue_referral_reward() {
        let (env, client, _, _, _) = setup_env();
        let referee = Address::generate(&env);
        let referrer = Address::generate(&env);

        client.register_referral(&referee, &referrer);

        // Simulate accrual within contract context
        let contract_id = client.address.clone();
        env.as_contract(&contract_id, || {
            YieldVault::accrue_referral_reward(&env, &referee, 10_000);
        });

        assert_eq!(client.get_referral_rewards(&referrer), 500);
        assert_eq!(client.get_total_referral_rewards(), 500);
    }

    #[test]
    fn test_accrue_referral_reward_no_referrer() {
        let (env, client, _, _, _) = setup_env();
        let user = Address::generate(&env);

        let contract_id = client.address.clone();
        env.as_contract(&contract_id, || {
            YieldVault::accrue_referral_reward(&env, &user, 10_000);
        });

        assert_eq!(client.get_total_referral_rewards(), 0);
    }

    #[test]
    fn test_accrue_referral_reward_zero_fee() {
        let (env, client, _, _, _) = setup_env();
        let referee = Address::generate(&env);
        let referrer = Address::generate(&env);

        client.register_referral(&referee, &referrer);

        let contract_id = client.address.clone();
        env.as_contract(&contract_id, || {
            YieldVault::accrue_referral_reward(&env, &referee, 0);
        });

        assert_eq!(client.get_referral_rewards(&referrer), 0);
    }

    #[test]
    fn test_claim_referral_rewards() {
        let (env, client, _, token_addr, token_admin) = setup_env();
        let referee = Address::generate(&env);
        let referrer = Address::generate(&env);

        // Register referral
        client.register_referral(&referee, &referrer);

        // Accrue some rewards within contract context
        let contract_id = client.address.clone();
        env.as_contract(&contract_id, || {
            YieldVault::accrue_referral_reward(&env, &referee, 10_000);
        });
        assert_eq!(client.get_referral_rewards(&referrer), 500);

        // Mint tokens to the contract so it can pay out
        mint_tokens(&env, &token_addr, &token_admin, &contract_id, 1000);

        // Claim
        let claimed = client.claim_referral_rewards(&referrer);
        assert_eq!(claimed, 500);
        assert_eq!(client.get_referral_rewards(&referrer), 0);
    }

    #[test]
    fn test_claim_referral_rewards_zero_fails() {
        let (env, client, _, _, _) = setup_env();
        let referrer = Address::generate(&env);

        let result = client.try_claim_referral_rewards(&referrer);
        assert!(result.is_err());
    }

    #[test]
    fn test_set_referral_fee() {
        let (_, client, admin, _, _) = setup_env();

        client.set_referral_fee(&admin, &800);
        assert_eq!(client.get_referral_fee_bps(), 800);
    }

    #[test]
    fn test_set_referral_fee_clamps_to_max() {
        let (_, client, admin, _, _) = setup_env();

        client.set_referral_fee(&admin, &5000);
        assert_eq!(client.get_referral_fee_bps(), 1000); // clamped to MAX
    }

    #[test]
    fn test_set_referral_fee_clamps_negative_to_zero() {
        let (_, client, admin, _, _) = setup_env();

        client.set_referral_fee(&admin, &-100);
        assert_eq!(client.get_referral_fee_bps(), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_set_referral_fee_non_admin_panics() {
        let (env, client, _, _, _) = setup_env();
        let impostor = Address::generate(&env);

        client.set_referral_fee(&impostor, &800);
    }

    #[test]
    fn test_default_referral_fee() {
        let (_, client, _, _, _) = setup_env();
        assert_eq!(client.get_referral_fee_bps(), 500); // default
    }

    #[test]
    fn test_get_referred_tvl_unregistered() {
        let (env, client, _, _, _) = setup_env();
        let unknown = Address::generate(&env);
        assert_eq!(client.get_referred_tvl(&unknown), 0);
    }

    #[test]
    fn test_get_referral_rewards_unregistered() {
        let (env, client, _, _, _) = setup_env();
        let unknown = Address::generate(&env);
        assert_eq!(client.get_referral_rewards(&unknown), 0);
    }
}

// ── Fuzz / Invariant Tests ───────────────────────────────────────────────

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod fuzz_tests {
    extern crate std;

    use super::*;
    use proptest::prelude::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup_env() -> (Env, YieldVaultClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(YieldVault, ());
        let client = YieldVaultClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();

        client.initialize(&admin, &token_addr);

        (env, client, admin, token_addr, token_admin)
    }

    fn mint_tokens(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
        let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    // Invariant 1 & 2: totals never go negative
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        #[test]
        fn fuzz_deposit_totals_non_negative(amount in 1i128..=i64::MAX as i128) {
            let (env, client, _, token_addr, _) = setup_env();
            let user = Address::generate(&env);
            mint_tokens(&env, &token_addr, &user, amount);

            client.deposit(&user, &amount, &amount);

            prop_assert!(client.total_shares() > 0);
            prop_assert!(client.total_assets() > 0);
        }
    }

    // Invariant 3: first deposit mints 1:1 shares
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        #[test]
        fn fuzz_first_deposit_shares_equal_assets(amount in 1i128..=i64::MAX as i128) {
            let (env, client, _, token_addr, _) = setup_env();
            let user = Address::generate(&env);
            mint_tokens(&env, &token_addr, &user, amount);

            let shares = client.deposit(&user, &amount, &amount);

            prop_assert_eq!(shares, amount);
            prop_assert_eq!(client.total_shares(), client.total_assets());
        }
    }

    // Invariant 4: deposit then full withdraw roundtrip
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        #[test]
        fn fuzz_deposit_withdraw_roundtrip(amount in 1i128..=i64::MAX as i128) {
            let (env, client, _, token_addr, _) = setup_env();
            let user = Address::generate(&env);
            mint_tokens(&env, &token_addr, &user, amount);

            let shares = client.deposit(&user, &amount, &amount);
            let withdrawn = client.withdraw(&user, &shares);

            prop_assert_eq!(withdrawn, amount);
            prop_assert_eq!(client.total_shares(), 0);
            prop_assert_eq!(client.total_assets(), 0);
        }
    }

    // Invariant 5: proportional shares in multi-depositor scenario
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(5_000))]

        #[test]
        fn fuzz_multi_deposit_proportional(
            amount1 in 1i128..=1_000_000_000i128,
            amount2 in 1i128..=1_000_000_000i128,
        ) {
            let (env, client, _, token_addr, _) = setup_env();
            let user1 = Address::generate(&env);
            let user2 = Address::generate(&env);
            mint_tokens(&env, &token_addr, &user1, amount1);
            mint_tokens(&env, &token_addr, &user2, amount2);

            let shares1 = client.deposit(&user1, &amount1, &amount1);
            let shares2 = client.deposit(&user2, &amount2, &amount2);

            prop_assert_eq!(client.total_shares(), shares1 + shares2);
            prop_assert_eq!(client.total_assets(), amount1 + amount2);
            prop_assert!(shares1 > 0);
            prop_assert!(shares2 > 0);

            let withdrawn1 = client.withdraw(&user1, &shares1);
            prop_assert!(withdrawn1 > 0);
            prop_assert!(withdrawn1 <= amount1);
        }
    }

    // Invariant 6: rebalance correctly tracks assets
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(5_000))]

        #[test]
        fn fuzz_rebalance_updates_assets(
            deposit_amount in 100i128..=1_000_000_000i128,
            rebalance_pct in 1u32..=100u32,
        ) {
            let (env, client, admin, token_addr, _) = setup_env();
            let user = Address::generate(&env);
            let target = Address::generate(&env);

            mint_tokens(&env, &token_addr, &user, deposit_amount);
            client.deposit(&user, &deposit_amount, &deposit_amount);

            let rebalance_amount = (deposit_amount * rebalance_pct as i128) / 100;
            if rebalance_amount > 0 {
                client.rebalance(&admin, &target, &rebalance_amount);

                let remaining = client.total_assets();
                prop_assert_eq!(remaining, deposit_amount - rebalance_amount);
                prop_assert!(remaining >= 0);

                let token_client = token::Client::new(&env, &token_addr);
                prop_assert_eq!(token_client.balance(&target), rebalance_amount);
            }
        }
    }

    // Invariant 7: share price never decreases from deposit/withdraw
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(5_000))]

        #[test]
        fn fuzz_share_price_monotonic(
            amount1 in 1000i128..=1_000_000_000i128,
            amount2 in 1000i128..=1_000_000_000i128,
            withdraw_shares in 1i128..=500i128,
        ) {
            let (env, client, _, token_addr, _) = setup_env();
            let user1 = Address::generate(&env);
            let user2 = Address::generate(&env);

            mint_tokens(&env, &token_addr, &user1, amount1);
            mint_tokens(&env, &token_addr, &user2, amount2);

            client.deposit(&user1, &amount1, &amount1);
            let price_before = (client.total_assets() * 1_000_000_000) / client.total_shares();

            client.deposit(&user2, &amount2, &amount2);
            let price_after = (client.total_assets() * 1_000_000_000) / client.total_shares();

            prop_assert!(
                price_after >= price_before,
                "Share price decreased after deposit: {} -> {}", price_before, price_after
            );

            let user1_shares = client.get_shares(&user1);
            let actual_withdraw = withdraw_shares.min(user1_shares - 1).max(1);

            if actual_withdraw > 0 && actual_withdraw < user1_shares {
                client.withdraw(&user1, &actual_withdraw);
                let ts = client.total_shares();
                if ts > 0 {
                    let price_post_withdraw = (client.total_assets() * 1_000_000_000) / ts;
                    prop_assert!(
                        price_post_withdraw >= price_before,
                        "Share price decreased after withdraw: {} -> {}", price_before, price_post_withdraw
                    );
                }
            }
        }
    }
}
