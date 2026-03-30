#[cfg(test)]
mod tests {
    use crate::{DeltaNeutralStrategy, DeltaNeutralStrategyClient, StrategyError};
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Ledger},
        token, Address, Env, IntoVal,
    };

    // ── Mock AMM Router ───────────────────────────────────────────────────

    /// Simulates a 1:1 swap (no slippage) for testing.
    #[contract]
    pub struct MockAmm;

    #[contractimpl]
    impl MockAmm {
        pub fn swap_exact_tokens_for_tokens(
            env: Env,
            sender: Address,
            amount_in: i128,
            amount_out_min: i128,
            token_in: Address,
            token_out: Address,
        ) -> i128 {
            // Transfer token_in from sender to this contract
            let in_client = token::Client::new(&env, &token_in);
            in_client.transfer(&sender, &env.current_contract_address(), &amount_in);

            // Transfer token_out from this contract to sender (1:1 rate)
            let out_client = token::Client::new(&env, &token_out);
            let balance = out_client.balance(&env.current_contract_address());
            let out_amount = amount_in.min(balance);

            if out_amount < amount_out_min {
                panic!("slippage");
            }

            out_client.transfer(&env.current_contract_address(), &sender, &out_amount);
            out_amount
        }
    }

    // ── Mock Perp Exchange ────────────────────────────────────────────────

    /// Simulates a perp exchange that returns collateral as notional and
    /// pays a fixed 1% funding rate.
    #[contract]
    pub struct MockPerp;

    #[contractimpl]
    impl MockPerp {
        pub fn open_short(
            env: Env,
            trader: Address,
            collateral: i128,
            _asset: Address,
        ) -> i128 {
            // Pull collateral from trader
            // (In tests the strategy contract is the "trader")
            let _ = trader;
            let _ = env;
            // Return notional = collateral (1x leverage)
            collateral
        }

        pub fn close_short(env: Env, trader: Address, _asset: Address) -> i128 {
            let _ = env;
            let _ = trader;
            // Return collateral unchanged (no PnL for simplicity)
            0_i128
        }

        pub fn collect_funding(env: Env, trader: Address, _asset: Address) -> i128 {
            let _ = env;
            let _ = trader;
            // Return 1% of a fixed notional as funding
            100_000_i128 // 0.1 USDC (scaled 1e7 = 1_000_000 = $0.10)
        }
    }

    // ── Mock Oracle ───────────────────────────────────────────────────────

    #[contract]
    pub struct MockOracle;

    #[contractimpl]
    impl MockOracle {
        /// Returns a fixed price of $1.00 (scaled 1e7 = 10_000_000).
        pub fn get_price(_env: Env, _asset: Address) -> i128 {
            10_000_000_i128 // $1.00
        }
    }

    /// A mock oracle that returns a price 10% higher (for rebalance tests).
    #[contract]
    pub struct MockOracleHighPrice;

    #[contractimpl]
    impl MockOracleHighPrice {
        pub fn get_price(_env: Env, _asset: Address) -> i128 {
            11_000_000_i128 // $1.10 — 10% above entry
        }
    }

    // ── Test Helpers ──────────────────────────────────────────────────────

    struct TestEnv {
        env: Env,
        client: DeltaNeutralStrategyClient<'static>,
        admin: Address,
        usdc: Address,
        spot: Address,
        amm: Address,
        perp: Address,
        oracle: Address,
    }

    fn setup() -> TestEnv {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(DeltaNeutralStrategy, ());
        let client = DeltaNeutralStrategyClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);

        // Register SAC tokens
        let usdc = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let spot = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();

        // Register mock contracts
        let amm = env.register(MockAmm, ());
        let perp = env.register(MockPerp, ());
        let oracle = env.register(MockOracle, ());

        client.initialize(&admin, &usdc, &spot, &amm, &perp, &oracle);

        TestEnv { env, client, admin, usdc, spot, amm, perp, oracle }
    }

    fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
        let sac = token::StellarAssetClient::new(env, token);
        sac.mint(to, &amount);
    }

    /// Seed the AMM mock with spot tokens so it can fulfil swaps.
    fn seed_amm(env: &Env, spot: &Address, amm: &Address, amount: i128) {
        let sac = token::StellarAssetClient::new(env, spot);
        sac.mint(amm, &amount);
    }

    // ── Tests ─────────────────────────────────────────────────────────────

    #[test]
    fn test_initialize_success() {
        let t = setup();
        // If we get here without panic, initialize succeeded
        assert_eq!(t.client.get_total_deposited(), 0);
        assert_eq!(t.client.get_rebalance_threshold(), 500);
    }

    #[test]
    fn test_initialize_twice_fails() {
        let t = setup();
        let result = t.client.try_initialize(
            &t.admin,
            &t.usdc,
            &t.spot,
            &t.amm,
            &t.perp,
            &t.oracle,
        );
        assert_eq!(result, Err(Ok(StrategyError::AlreadyInitialized)));
    }

    #[test]
    fn test_open_position_success() {
        let t = setup();
        let user = Address::generate(&t.env);
        let deposit = 2_000_000_i128; // 0.2 USDC (scaled 1e7)

        mint(&t.env, &t.usdc, &user, deposit);
        seed_amm(&t.env, &t.spot, &t.amm, deposit);

        let spot_received = t.client.open_position(&user, &deposit, &0);
        assert!(spot_received > 0);

        let pos = t.client.get_position(&user).unwrap();
        assert!(pos.is_open);
        assert_eq!(pos.usdc_deposited, deposit);
        assert_eq!(pos.spot_amount, spot_received);
        assert_eq!(t.client.get_total_deposited(), deposit);
    }

    #[test]
    fn test_open_position_zero_amount_fails() {
        let t = setup();
        let user = Address::generate(&t.env);
        let result = t.client.try_open_position(&user, &0, &0);
        assert_eq!(result, Err(Ok(StrategyError::ZeroAmount)));
    }

    #[test]
    fn test_open_position_twice_fails() {
        let t = setup();
        let user = Address::generate(&t.env);
        let deposit = 2_000_000_i128;

        mint(&t.env, &t.usdc, &user, deposit * 2);
        seed_amm(&t.env, &t.spot, &t.amm, deposit * 2);

        t.client.open_position(&user, &deposit, &0);

        let result = t.client.try_open_position(&user, &deposit, &0);
        assert_eq!(result, Err(Ok(StrategyError::PositionAlreadyOpen)));
    }

    #[test]
    fn test_close_position_success() {
        let t = setup();
        let user = Address::generate(&t.env);
        let deposit = 2_000_000_i128;

        mint(&t.env, &t.usdc, &user, deposit);
        seed_amm(&t.env, &t.spot, &t.amm, deposit * 2);

        t.client.open_position(&user, &deposit, &0);

        // Seed AMM with USDC so it can pay back on close
        mint(&t.env, &t.usdc, &t.amm, deposit);

        t.client.close_position(&user);

        let pos = t.client.get_position(&user).unwrap();
        assert!(!pos.is_open);
    }

    #[test]
    fn test_close_position_no_position_fails() {
        let t = setup();
        let user = Address::generate(&t.env);
        let result = t.client.try_close_position(&user);
        assert_eq!(result, Err(Ok(StrategyError::NoPosition)));
    }

    #[test]
    fn test_collect_funding_success() {
        let t = setup();
        let user = Address::generate(&t.env);
        let deposit = 2_000_000_i128;

        mint(&t.env, &t.usdc, &user, deposit);
        seed_amm(&t.env, &t.spot, &t.amm, deposit);

        t.client.open_position(&user, &deposit, &0);

        // Seed contract with USDC to pay out funding
        mint(&t.env, &t.usdc, &t.client.address, 1_000_000);

        let funding = t.client.collect_funding(&user);
        assert_eq!(funding, 100_000_i128);
    }

    #[test]
    fn test_collect_funding_no_position_fails() {
        let t = setup();
        let user = Address::generate(&t.env);
        let result = t.client.try_collect_funding(&user);
        assert_eq!(result, Err(Ok(StrategyError::NoPosition)));
    }

    #[test]
    fn test_auto_rebalance_not_needed() {
        let t = setup();
        let user = Address::generate(&t.env);
        let deposit = 2_000_000_i128;

        mint(&t.env, &t.usdc, &user, deposit);
        seed_amm(&t.env, &t.spot, &t.amm, deposit);

        t.client.open_position(&user, &deposit, &0);

        // Price hasn't moved (same oracle), so rebalance should not be needed
        let result = t.client.try_auto_rebalance(&user, &user);
        assert_eq!(result, Err(Ok(StrategyError::RebalanceNotNeeded)));
    }

    #[test]
    fn test_auto_rebalance_with_price_move() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(DeltaNeutralStrategy, ());
        let client = DeltaNeutralStrategyClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);

        let usdc = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let spot = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();

        let amm = env.register(MockAmm, ());
        let perp = env.register(MockPerp, ());
        // Use high-price oracle to simulate a 10% price move
        let oracle = env.register(MockOracleHighPrice, ());

        client.initialize(&admin, &usdc, &spot, &amm, &perp, &oracle);

        let user = Address::generate(&env);
        let deposit = 2_000_000_i128;

        mint(&env, &usdc, &user, deposit);
        seed_amm(&env, &spot, &amm, deposit * 2);

        client.open_position(&user, &deposit, &0);

        // Seed AMM with USDC for the rebalance sell
        mint(&env, &usdc, &amm, deposit);

        // 10% price move exceeds default 5% threshold → rebalance should succeed
        let deviation = client.auto_rebalance(&user, &user);
        assert!(deviation > 0);
    }

    #[test]
    fn test_auto_rebalance_unauthorized() {
        let t = setup();
        let user = Address::generate(&t.env);
        let attacker = Address::generate(&t.env);
        let deposit = 2_000_000_i128;

        mint(&t.env, &t.usdc, &user, deposit);
        seed_amm(&t.env, &t.spot, &t.amm, deposit);

        t.client.open_position(&user, &deposit, &0);

        let result = t.client.try_auto_rebalance(&attacker, &user);
        assert_eq!(result, Err(Ok(StrategyError::Unauthorized)));
    }

    #[test]
    fn test_pause_and_unpause() {
        let t = setup();
        t.client.pause(&t.admin);

        let user = Address::generate(&t.env);
        let result = t.client.try_open_position(&user, &1_000_000, &0);
        assert_eq!(result, Err(Ok(StrategyError::Paused)));

        t.client.unpause(&t.admin);

        // After unpause, operations should work again
        let deposit = 2_000_000_i128;
        mint(&t.env, &t.usdc, &user, deposit);
        seed_amm(&t.env, &t.spot, &t.amm, deposit);
        let spot = t.client.open_position(&user, &deposit, &0);
        assert!(spot > 0);
    }

    #[test]
    fn test_pause_unauthorized() {
        let t = setup();
        let attacker = Address::generate(&t.env);
        let result = t.client.try_pause(&attacker);
        assert_eq!(result, Err(Ok(StrategyError::Unauthorized)));
    }

    #[test]
    fn test_set_rebalance_threshold() {
        let t = setup();
        t.client.set_rebalance_threshold(&t.admin, &300);
        assert_eq!(t.client.get_rebalance_threshold(), 300);
    }

    #[test]
    fn test_set_rebalance_threshold_invalid() {
        let t = setup();
        let result = t.client.try_set_rebalance_threshold(&t.admin, &0);
        assert_eq!(result, Err(Ok(StrategyError::InvalidThreshold)));

        let result2 = t.client.try_set_rebalance_threshold(&t.admin, &10_001);
        assert_eq!(result2, Err(Ok(StrategyError::InvalidThreshold)));
    }

    #[test]
    fn test_set_rebalance_threshold_unauthorized() {
        let t = setup();
        let attacker = Address::generate(&t.env);
        let result = t.client.try_set_rebalance_threshold(&attacker, &300);
        assert_eq!(result, Err(Ok(StrategyError::Unauthorized)));
    }

    #[test]
    fn test_get_position_none_for_new_user() {
        let t = setup();
        let user = Address::generate(&t.env);
        assert!(t.client.get_position(&user).is_none());
    }

    #[test]
    fn test_admin_can_trigger_rebalance() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(DeltaNeutralStrategy, ());
        let client = DeltaNeutralStrategyClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);

        let usdc = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let spot = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();

        let amm = env.register(MockAmm, ());
        let perp = env.register(MockPerp, ());
        let oracle = env.register(MockOracleHighPrice, ());

        client.initialize(&admin, &usdc, &spot, &amm, &perp, &oracle);

        let user = Address::generate(&env);
        let deposit = 2_000_000_i128;

        mint(&env, &usdc, &user, deposit);
        seed_amm(&env, &spot, &amm, deposit * 2);
        client.open_position(&user, &deposit, &0);

        mint(&env, &usdc, &amm, deposit);

        // Admin triggers rebalance on behalf of user
        let deviation = client.auto_rebalance(&admin, &user);
        assert!(deviation > 0);
    }
}
