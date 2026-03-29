#![allow(clippy::too_many_arguments)]
#![no_std]

//! # Zap — One-Click Swap & Deposit
//!
//! Accepts any SAC token from the user, swaps it for the vault's required
//! token via a DEX router, and deposits the result into the YieldVault in
//! a single transaction. Handles slippage tolerance during the swap.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, vec, Address, Env,
    IntoVal, Symbol, Val,
};

// ── Storage ──────────────────────────────────────────────────────────────────

#[contracttype]
enum DataKey {
    Admin,
    DexRouter,
    Initialized,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ZapError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    ZeroAmount = 3,
    Unauthorized = 4,
    SlippageExceeded = 5,
    SwapFailed = 6,
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct Zap;

#[contractimpl]
impl Zap {
    /// Initialize the Zap contract with an admin and DEX router address.
    pub fn initialize(env: Env, admin: Address, dex_router: Address) -> Result<(), ZapError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(ZapError::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::DexRouter, &dex_router);
        env.storage().instance().set(&DataKey::Initialized, &true);

        env.events()
            .publish((symbol_short!("zap_init"),), (admin, dex_router));

        Ok(())
    }

    /// Zap deposit: swap input token for vault token, then deposit into vault.
    ///
    /// # Arguments
    /// * `user` - The depositor (must authorize the call).
    /// * `input_token` - The token the user wants to deposit (e.g. XLM).
    /// * `vault_token` - The token the vault requires (e.g. USDC).
    /// * `vault` - The YieldVault contract address.
    /// * `amount_in` - Amount of input_token to swap.
    /// * `min_amount_out` - Minimum vault_token to receive (slippage protection).
    ///
    /// # Returns
    /// The number of vault shares received.
    pub fn zap_deposit(
        env: Env,
        user: Address,
        input_token: Address,
        vault_token: Address,
        vault: Address,
        amount_in: i128,
        min_amount_out: i128,
    ) -> Result<i128, ZapError> {
        Self::require_init(&env)?;
        user.require_auth();

        if amount_in <= 0 {
            return Err(ZapError::ZeroAmount);
        }

        let zap_addr = env.current_contract_address();
        let dex_router: Address = env.storage().instance().get(&DataKey::DexRouter).unwrap();

        // Step 1: Transfer input tokens from user to this contract
        let input_client = token::Client::new(&env, &input_token);
        input_client.transfer(&user, &zap_addr, &amount_in);

        // Step 2: If input_token == vault_token, skip the swap
        let deposit_amount = if input_token == vault_token {
            amount_in
        } else {
            // Approve DEX router to spend our input tokens
            input_client.approve(&zap_addr, &dex_router, &amount_in, &4294967295u32);

            // Swap via DEX router
            let swap_fn = Symbol::new(&env, "swap");
            let swap_args: soroban_sdk::Vec<Val> = vec![
                &env,
                input_token.into_val(&env),
                vault_token.clone().into_val(&env),
                amount_in.into_val(&env),
                min_amount_out.into_val(&env),
            ];
            let amount_out: i128 = env.invoke_contract(&dex_router, &swap_fn, swap_args);

            if amount_out < min_amount_out {
                return Err(ZapError::SlippageExceeded);
            }

            amount_out
        };

        // Step 3: Approve vault to spend the swapped tokens
        let vault_token_client = token::Client::new(&env, &vault_token);
        vault_token_client.approve(&zap_addr, &vault, &deposit_amount, &4294967295u32);

        // Step 4: Deposit into YieldVault
        let deposit_fn = Symbol::new(&env, "deposit");
        let deposit_args: soroban_sdk::Vec<Val> =
            vec![&env, zap_addr.into_val(&env), deposit_amount.into_val(&env)];
        let shares: i128 = env.invoke_contract(&vault, &deposit_fn, deposit_args);

        env.events().publish(
            (symbol_short!("zap_dep"),),
            (user, amount_in, deposit_amount, shares),
        );

        Ok(shares)
    }

    /// Update the DEX router address. Admin-only.
    pub fn set_dex_router(env: Env, admin: Address, new_router: Address) -> Result<(), ZapError> {
        Self::require_init(&env)?;
        admin.require_auth();

        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if admin != stored_admin {
            return Err(ZapError::Unauthorized);
        }

        env.storage()
            .instance()
            .set(&DataKey::DexRouter, &new_router);
        Ok(())
    }

    // ── Internal ─────────────────────────────────────────────────────

    fn require_init(env: &Env) -> Result<(), ZapError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(ZapError::NotInitialized);
        }
        Ok(())
    }
}
