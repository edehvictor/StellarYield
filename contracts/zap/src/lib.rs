#![no_std]
#![allow(clippy::too_many_arguments)]

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
    ///
    /// # Arguments
    ///
    /// * `admin`       — Account allowed to update configuration (such as the DEX router).
    /// * `dex_router`  — Contract implementing `swap(from, to, amount_in, min_out) -> i128`.
    ///
    /// # Errors
    ///
    /// * [`ZapError::AlreadyInitialized`] — If `initialize` was already called successfully.
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

    /// Swap `amount_in` of `input_token` into `vault_token` (unless they match), then
    /// deposit into `vault` so that **vault shares are credited to `user`**.
    ///
    /// When `expected_amount_out` is greater than zero and the swap returns less than
    /// that quote but still at least `min_amount_out`, a partial fill is recorded via
    /// `zap_part` when `allow_partial` is true. Any unused `input_token` held by this
    /// contract after the swap is refunded to `user` and recorded via `zap_ref`.
    ///
    /// # Arguments
    ///
    /// * `user` — End user; must authorize this call. Receives vault shares via `deposit_for`.
    /// * `input_token` — Asset pulled from `user` into this contract (any Stellar SAC).
    /// * `vault_token` — Asset the vault accepts (must match the vault’s configured token).
    /// * `vault` — Yield vault contract address.
    /// * `amount_in` — Amount of `input_token` to use.
    /// * `min_amount_out` — Minimum `vault_token` amount after swap (0 if `input_token == vault_token`).
    /// * `min_shares_out` — Minimum acceptable vault shares after deposit.
    /// * `expected_amount_out` — Quoted swap output; `0` skips partial-fill detection.
    /// * `allow_partial` — Whether to accept output below `expected_amount_out` when above `min_amount_out`.
    ///
    /// # Returns
    ///
    /// Vault shares minted to `user`.
    ///
    /// # Errors
    ///
    /// * [`ZapError::SlippageExceeded`] — Swap output below `min_amount_out`, or below
    ///   `expected_amount_out` when partial fills are disallowed.
    /// * [`ZapError::ZeroAmount`] — `amount_in` is not positive.
    pub fn zap_deposit(
        env: Env,
        user: Address,
        input_token: Address,
        vault_token: Address,
        vault: Address,
        amount_in: i128,
        min_amount_out: i128,
        min_shares_out: i128,
        expected_amount_out: i128,
        allow_partial: bool,
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
            input_client.approve(
                &zap_addr,
                &dex_router,
                &amount_in,
                &(env.ledger().sequence() + 100),
            );

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

            let quoted = if expected_amount_out > 0 {
                expected_amount_out
            } else {
                min_amount_out
            };

            if amount_out < quoted {
                if !allow_partial {
                    return Err(ZapError::SlippageExceeded);
                }

                env.events().publish(
                    (symbol_short!("zap_part"),),
                    (
                        user.clone(),
                        input_token.clone(),
                        vault_token.clone(),
                        amount_in,
                        quoted,
                        amount_out,
                    ),
                );
            }

            Self::refund_unused_input(
                &env,
                &user,
                &input_token,
                &zap_addr,
                symbol_short!("unused_in"),
            );

            amount_out
        };

        // Step 3: Deposit into YieldVault — shares go to `user` (payer is this contract)
        let deposit_fn = Symbol::new(&env, "deposit_for");
        let deposit_args: soroban_sdk::Vec<Val> = vec![
            &env,
            zap_addr.into_val(&env),
            user.clone().into_val(&env),
            deposit_amount.into_val(&env),
            min_shares_out.into_val(&env),
        ];
        let shares: i128 = env.invoke_contract(&vault, &deposit_fn, deposit_args);

        env.events().publish(
            (symbol_short!("zap_dep"),),
            (user, amount_in, deposit_amount, shares),
        );

        Ok(shares)
    }

    /// Replace the DEX router contract used for swaps.
    ///
    /// # Arguments
    ///
    /// * `admin` — Must match the admin set in [`initialize`].
    /// * `new_router` — New router implementing the expected `swap` interface.
    ///
    /// # Errors
    ///
    /// * [`ZapError::Unauthorized`] — Caller is not the stored admin.
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

    /// Return unused input held by the zap contract and emit `zap_ref`.
    fn refund_unused_input(
        env: &Env,
        user: &Address,
        token_addr: &Address,
        zap_addr: &Address,
        reason: Symbol,
    ) -> i128 {
        let client = token::Client::new(env, token_addr);
        let balance = client.balance(zap_addr);
        if balance > 0 {
            client.transfer(zap_addr, user, &balance);
            env.events().publish(
                (symbol_short!("zap_ref"),),
                (user.clone(), token_addr.clone(), balance, reason),
            );
        }
        balance
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Events};
    use soroban_sdk::token::StellarAssetClient;

    // ── Mock DEX router ──────────────────────────────────────────────

    #[contracttype]
    enum RouterKey {
        Output,
        InputUsed,
        ZapCaller,
    }

    #[contract]
    struct MockDexRouter;

    #[contractimpl]
    impl MockDexRouter {
        pub fn configure(env: Env, zap_caller: Address, amount_out: i128, input_used: i128) {
            env.storage()
                .instance()
                .set(&RouterKey::ZapCaller, &zap_caller);
            env.storage().instance().set(&RouterKey::Output, &amount_out);
            env.storage()
                .instance()
                .set(&RouterKey::InputUsed, &input_used);
        }

        pub fn swap(
            env: Env,
            from: Address,
            to: Address,
            amount_in: i128,
            min_out: i128,
        ) -> i128 {
            let router = env.current_contract_address();
            let zap: Address = env
                .storage()
                .instance()
                .get(&RouterKey::ZapCaller)
                .unwrap_or_else(|| panic!("router not configured"));
            let amount_out: i128 = env
                .storage()
                .instance()
                .get(&RouterKey::Output)
                .unwrap_or(amount_in);
            let input_used: i128 = env
                .storage()
                .instance()
                .get(&RouterKey::InputUsed)
                .unwrap_or(amount_in);

            let _ = min_out;

            let in_client = token::Client::new(&env, &from);
            in_client.transfer_from(&router, &zap, &router, &input_used.min(amount_in));

            let out_client = token::Client::new(&env, &to);
            out_client.transfer(&router, &zap, &amount_out);

            amount_out
        }
    }

    // ── Mock vault ───────────────────────────────────────────────────

    #[contracttype]
    enum VaultKey {
        Token,
    }

    #[contract]
    struct MockVault;

    #[contractimpl]
    impl MockVault {
        pub fn set_token(env: Env, token_addr: Address) {
            env.storage().instance().set(&VaultKey::Token, &token_addr);
        }

        pub fn deposit_for(
            env: Env,
            payer: Address,
            beneficiary: Address,
            amount: i128,
            min_shares: i128,
        ) -> i128 {
            if amount < min_shares {
                panic!("min shares");
            }
            let shares = amount;
            env.events().publish(
                (symbol_short!("dep_for"),),
                (payer, beneficiary, amount, shares),
            );
            shares
        }
    }

    // ── Test harness ─────────────────────────────────────────────────

    struct ZapTestEnv {
        env: Env,
        zap: ZapClient<'static>,
        zap_id: Address,
        user: Address,
        input_token: Address,
        vault_token: Address,
        vault_id: Address,
        router_id: Address,
        router: MockDexRouterClient<'static>,
    }

    fn setup_zap_env() -> ZapTestEnv {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let zap_id = env.register(Zap, ());
        let zap = ZapClient::new(&env, &zap_id);

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let input_admin = Address::generate(&env);
        let input_sac = env.register_stellar_asset_contract_v2(input_admin.clone());
        let input_token = input_sac.address();

        let vault_admin = Address::generate(&env);
        let vault_sac = env.register_stellar_asset_contract_v2(vault_admin.clone());
        let vault_token = vault_sac.address();

        let router_id = env.register(MockDexRouter, ());
        let router = MockDexRouterClient::new(&env, &router_id);

        let vault_id = env.register(MockVault, ());
        let vault = MockVaultClient::new(&env, &vault_id);
        vault.set_token(&vault_token);

        zap.initialize(&admin, &router_id);

        StellarAssetClient::new(&env, &input_token).mint(&user, &10_000);
        StellarAssetClient::new(&env, &vault_token).mint(&router_id, &10_000);

        ZapTestEnv {
            env,
            zap,
            zap_id,
            user,
            input_token,
            vault_token,
            vault_id,
            router_id,
            router,
        }
    }

    fn event_topic(env: &Env, topics: &soroban_sdk::Vec<Val>) -> Symbol {
        topics.get(0).unwrap().into_val(env)
    }

    fn zap_event_topics(env: &Env, zap_id: &Address) -> soroban_sdk::Vec<Symbol> {
        let mut out = soroban_sdk::Vec::new(env);
        for (contract, topics, _data) in env.events().all().iter() {
            if contract == *zap_id {
                out.push_back(event_topic(env, &topics));
            }
        }
        out
    }

    fn count_zap_events(env: &Env, zap_id: &Address, topic: Symbol) -> u32 {
        env.events()
            .all()
            .iter()
            .filter(|(contract, topics, _)| {
                *contract == *zap_id && event_topic(env, topics) == topic
            })
            .count() as u32
    }

    // ── Existing regression tests ────────────────────────────────────

    #[test]
    fn test_double_initialize_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(Zap, ());
        let client = ZapClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let router = Address::generate(&env);
        client.initialize(&admin, &router);

        let result = client.try_initialize(&admin, &router);
        assert_eq!(result, Err(Ok(ZapError::AlreadyInitialized)));
    }

    #[test]
    fn test_set_dex_router_unauthorized_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(Zap, ());
        let client = ZapClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);
        let router = Address::generate(&env);
        let new_router = Address::generate(&env);
        client.initialize(&admin, &router);

        let result = client.try_set_dex_router(&attacker, &new_router);
        assert_eq!(result, Err(Ok(ZapError::Unauthorized)));
    }

    // ── Event assertion tests (#1045) ──────────────────────────────────

    #[test]
    fn test_initialize_emits_zap_init() {
        let env = Env::default();
        env.mock_all_auths();

        let zap_id = env.register(Zap, ());
        let client = ZapClient::new(&env, &zap_id);
        let admin = Address::generate(&env);
        let router = Address::generate(&env);

        client.initialize(&admin, &router);

        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let (contract, topics, data) = events.last().unwrap();
        assert_eq!(contract, zap_id);
        assert_eq!(event_topic(&env, &topics), symbol_short!("zap_init"));
        let decoded: (Address, Address) = data.clone().into_val(&env);
        assert_eq!(decoded.0, admin);
        assert_eq!(decoded.1, router);
    }

    #[test]
    fn test_zap_deposit_direct_emits_zap_dep() {
        let t = setup_zap_env();
        StellarAssetClient::new(&t.env, &t.vault_token).mint(&t.user, &1_000);

        let shares = t
            .zap
            .zap_deposit(
                &t.user,
                &t.vault_token,
                &t.vault_token,
                &t.vault_id,
                &1_000,
                &0,
                &1,
                &0,
                &false,
            );

        assert_eq!(shares, 1_000);
        assert_eq!(
            count_zap_events(&t.env, &t.zap_id, symbol_short!("zap_dep")),
            1
        );
        assert_eq!(
            count_zap_events(&t.env, &t.zap_id, symbol_short!("zap_part")),
            0
        );
        assert_eq!(
            count_zap_events(&t.env, &t.zap_id, symbol_short!("zap_ref")),
            0
        );

        let (_contract, topics, data) = t.env.events().all().last().unwrap();
        assert_eq!(event_topic(&t.env, &topics), symbol_short!("zap_dep"));
        let decoded: (Address, i128, i128, i128) = data.clone().into_val(&t.env);
        assert_eq!(decoded.0, t.user);
        assert_eq!(decoded.1, 1_000);
        assert_eq!(decoded.2, 1_000);
        assert_eq!(decoded.3, 1_000);
    }

    #[test]
    fn test_zap_deposit_swap_full_emits_zap_dep() {
        let t = setup_zap_env();
        t.router
            .configure(&t.zap_id, &900, &1_000);

        let shares = t
            .zap
            .zap_deposit(
                &t.user,
                &t.input_token,
                &t.vault_token,
                &t.vault_id,
                &1_000,
                &800,
                &1,
                &900,
                &false,
            );

        assert_eq!(shares, 900);
        assert_eq!(
            count_zap_events(&t.env, &t.zap_id, symbol_short!("zap_dep")),
            1
        );
        assert_eq!(
            count_zap_events(&t.env, &t.zap_id, symbol_short!("zap_part")),
            0
        );
    }

    #[test]
    fn test_zap_deposit_partial_fill_emits_zap_part() {
        let t = setup_zap_env();
        t.router.configure(&t.zap_id, &600, &1_000);

        let shares = t
            .zap
            .zap_deposit(
                &t.user,
                &t.input_token,
                &t.vault_token,
                &t.vault_id,
                &1_000,
                &500,
                &1,
                &900,
                &true,
            );

        assert_eq!(shares, 600);
        assert_eq!(
            count_zap_events(&t.env, &t.zap_id, symbol_short!("zap_part")),
            1
        );

        let part_data = t
            .env
            .events()
            .all()
            .iter()
            .find(|(contract, topics, _)| {
                *contract == t.zap_id && event_topic(&t.env, topics) == symbol_short!("zap_part")
            })
            .map(|(_, _, data)| data.clone())
            .unwrap();
        let decoded: (Address, Address, Address, i128, i128, i128) =
            part_data.into_val(&t.env);
        assert_eq!(decoded.0, t.user);
        assert_eq!(decoded.1, t.input_token);
        assert_eq!(decoded.2, t.vault_token);
        assert_eq!(decoded.3, 1_000);
        assert_eq!(decoded.4, 900);
        assert_eq!(decoded.5, 600);
    }

    #[test]
    fn test_zap_deposit_refund_emits_zap_ref() {
        let t = setup_zap_env();
        // Router consumes only 600 of 1000 input; 400 should be refunded.
        t.router.configure(&t.zap_id, &900, &600);

        t.zap
            .zap_deposit(
                &t.user,
                &t.input_token,
                &t.vault_token,
                &t.vault_id,
                &1_000,
                &800,
                &1,
                &900,
                &false,
            );

        assert_eq!(
            count_zap_events(&t.env, &t.zap_id, symbol_short!("zap_ref")),
            1
        );

        let ref_data = t
            .env
            .events()
            .all()
            .iter()
            .find(|(contract, topics, _)| {
                *contract == t.zap_id && event_topic(&t.env, topics) == symbol_short!("zap_ref")
            })
            .map(|(_, _, data)| data.clone())
            .unwrap();
        let decoded: (Address, Address, i128, Symbol) = ref_data.into_val(&t.env);
        assert_eq!(decoded.0, t.user);
        assert_eq!(decoded.1, t.input_token);
        assert_eq!(decoded.2, 400);
        assert_eq!(decoded.3, symbol_short!("unused_in"));
        assert_eq!(
            token::Client::new(&t.env, &t.input_token).balance(&t.user),
            9_400
        );
    }

    #[test]
    fn test_zap_deposit_event_ordering_partial_refund_then_exec() {
        let t = setup_zap_env();
        t.router.configure(&t.zap_id, &600, &600);

        t.zap
            .zap_deposit(
                &t.user,
                &t.input_token,
                &t.vault_token,
                &t.vault_id,
                &1_000,
                &500,
                &1,
                &900,
                &true,
            );

        let topics = zap_event_topics(&t.env, &t.zap_id);
        assert_eq!(topics.len(), 3);
        assert_eq!(topics.get(0).unwrap(), symbol_short!("zap_part"));
        assert_eq!(topics.get(1).unwrap(), symbol_short!("zap_ref"));
        assert_eq!(topics.get(2).unwrap(), symbol_short!("zap_dep"));
    }

    #[test]
    fn test_zap_deposit_slippage_emits_no_success_events() {
        let t = setup_zap_env();
        t.router.configure(&t.zap_id, &400, &1_000);

        let result = t.zap.try_zap_deposit(
            &t.user,
            &t.input_token,
            &t.vault_token,
            &t.vault_id,
            &1_000,
            &500,
            &1,
            &900,
            &false,
        );
        assert_eq!(result, Err(Ok(ZapError::SlippageExceeded)));
        assert_eq!(
            count_zap_events(&t.env, &t.zap_id, symbol_short!("zap_dep")),
            0
        );
        assert_eq!(
            count_zap_events(&t.env, &t.zap_id, symbol_short!("zap_part")),
            0
        );
        assert_eq!(
            count_zap_events(&t.env, &t.zap_id, symbol_short!("zap_ref")),
            0
        );
    }
}
