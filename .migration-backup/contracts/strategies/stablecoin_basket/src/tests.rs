#[cfg(test)]
mod stablecoin_basket_tests {
    use soroban_sdk::{testutils::Address as _, Address, Env, Vec};

    use crate::{AssetConfig, BasketError, StablecoinBasketStrategy, StablecoinBasketStrategyClient};

    fn make_config(env: &Env, weight_bps: i128, max_bps: i128) -> AssetConfig {
        AssetConfig {
            token: Address::generate(env),
            weight_bps,
            max_concentration_bps: max_bps,
        }
    }

    fn setup(env: &Env) -> (Address, StablecoinBasketStrategyClient) {
        let contract_id = env.register_contract(None, StablecoinBasketStrategy);
        let client = StablecoinBasketStrategyClient::new(env, &contract_id);
        let admin = Address::generate(env);
        (admin, client)
    }

    // ── Initialization ────────────────────────────────────────────────────────

    #[test]
    fn test_initialize_valid_weights() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let configs = {
            let mut v = Vec::new(&env);
            v.push_back(make_config(&env, 6_000, 7_000)); // 60%
            v.push_back(make_config(&env, 4_000, 5_000)); // 40%
            v
        };
        assert!(client.try_initialize(&admin, &configs, &200).is_ok());
    }

    #[test]
    fn test_initialize_rejects_weight_mismatch() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let configs = {
            let mut v = Vec::new(&env);
            v.push_back(make_config(&env, 5_000, 6_000));
            v.push_back(make_config(&env, 3_000, 4_000)); // sums to 8000 ≠ 10000
            v
        };
        assert_eq!(
            client.try_initialize(&admin, &configs, &200),
            Err(Ok(BasketError::WeightMismatch))
        );
    }

    #[test]
    fn test_initialize_rejects_too_many_assets() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let mut configs = Vec::new(&env);
        for i in 0..11u32 {
            configs.push_back(AssetConfig {
                token: Address::generate(&env),
                weight_bps: if i < 10 { 1_000 } else { 0 },
                max_concentration_bps: 2_000,
            });
        }
        assert_eq!(
            client.try_initialize(&admin, &configs, &200),
            Err(Ok(BasketError::TooManyAssets))
        );
    }

    #[test]
    fn test_double_initialize_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        let configs = {
            let mut v = Vec::new(&env);
            v.push_back(make_config(&env, 10_000, 10_000));
            v
        };
        client.initialize(&admin, &configs, &200);
        assert_eq!(
            client.try_initialize(&admin, &configs, &200),
            Err(Ok(BasketError::AlreadyInitialized))
        );
    }

    // ── Pause / Unpause ───────────────────────────────────────────────────────

    #[test]
    fn test_pause_unpause() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        let configs = {
            let mut v = Vec::new(&env);
            v.push_back(make_config(&env, 10_000, 10_000));
            v
        };
        client.initialize(&admin, &configs, &200);
        assert!(!client.is_paused());
        client.pause();
        assert!(client.is_paused());
        client.unpause();
        assert!(!client.is_paused());
    }

    // ── Allowlist ─────────────────────────────────────────────────────────────

    #[test]
    fn test_allowlist_management() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        let asset = Address::generate(&env);
        let configs = {
            let mut v = Vec::new(&env);
            v.push_back(make_config(&env, 10_000, 10_000));
            v
        };
        client.initialize(&admin, &configs, &200);

        assert!(!client.is_allowed(&asset));
        client.add_to_allowlist(&asset);
        assert!(client.is_allowed(&asset));
        client.remove_from_allowlist(&asset);
        assert!(!client.is_allowed(&asset));
    }

    // ── Allocation math ───────────────────────────────────────────────────────

    #[test]
    fn test_total_deposited_starts_at_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        let configs = {
            let mut v = Vec::new(&env);
            v.push_back(make_config(&env, 10_000, 10_000));
            v
        };
        client.initialize(&admin, &configs, &200);
        assert_eq!(client.total_deposited(), 0);
    }

    #[test]
    fn test_rebalance_returns_not_needed_when_no_deposits() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        let configs = {
            let mut v = Vec::new(&env);
            v.push_back(make_config(&env, 10_000, 10_000));
            v
        };
        client.initialize(&admin, &configs, &200);
        // No deposits → total = 0 → empty deltas → Ok([])
        let deltas = client.compute_rebalance_deltas().unwrap();
        assert_eq!(deltas.len(), 0);
    }
}
