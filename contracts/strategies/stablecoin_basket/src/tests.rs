#[cfg(test)]
mod stablecoin_basket_tests {
    use soroban_sdk::{testutils::Address as _, token, Address, Env, Vec};

    use crate::{
        AssetConfig, BasketError, StablecoinBasketStrategy, StablecoinBasketStrategyClient,
    };

    fn make_config(env: &Env, weight_bps: i128, max_bps: i128) -> AssetConfig {
        AssetConfig {
            token: Address::generate(env),
            weight_bps,
            max_concentration_bps: max_bps,
        }
    }

    fn setup<'a>(env: &'a Env) -> (Address, StablecoinBasketStrategyClient<'a>) {
        let contract_id = env.register(StablecoinBasketStrategy, ());
        let client = StablecoinBasketStrategyClient::new(env, &contract_id);
        let admin = Address::generate(env);
        (admin, client)
    }

    fn create_sac_token<'a>(
        env: &'a Env,
    ) -> (Address, token::StellarAssetClient<'a>, token::Client<'a>) {
        let admin = Address::generate(env);
        let token_addr = env.register_stellar_asset_contract_v2(admin).address();
        let sac_client = token::StellarAssetClient::new(env, &token_addr);
        let token_client = token::Client::new(env, &token_addr);
        (token_addr, sac_client, token_client)
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
        let deltas = client.compute_rebalance_deltas();
        assert_eq!(deltas.len(), 0);
    }

    // ── Uneven Decimals & Proportional Redemption (#1683) ─────────────────────

    #[test]
    fn test_one_shot_vs_split_redemption_exact_proportions() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        // Assets with uneven decimal representations:
        // Asset 0: 6-decimal USDC representation (10_000 USDC = 10_000_000_000 raw units)
        // Asset 1: 7-decimal XLM representation (10_000 XLM = 100_000_000_000 raw units)
        // Asset 2: 18-decimal DAI representation (10_000 DAI = 10_000_000_000_000_000_000_000 raw units)
        let (tok0, sac0, client0) = create_sac_token(&env);
        let (tok1, sac1, client1) = create_sac_token(&env);
        let (tok2, sac2, client2) = create_sac_token(&env);

        let mut configs = Vec::new(&env);
        configs.push_back(AssetConfig {
            token: tok0.clone(),
            weight_bps: 4_000,
            max_concentration_bps: 5_000,
        });
        configs.push_back(AssetConfig {
            token: tok1.clone(),
            weight_bps: 3_000,
            max_concentration_bps: 5_000,
        });
        configs.push_back(AssetConfig {
            token: tok2.clone(),
            weight_bps: 3_000,
            max_concentration_bps: 5_000,
        });

        client.initialize(&admin, &configs, &200);

        let raw_amt0: i128 = 10_000_000_000;
        let raw_amt1: i128 = 100_000_000_000;
        let raw_amt2: i128 = 10_000_000_000_000_000_000_000;

        sac0.mint(&client.address, &raw_amt0);
        sac1.mint(&client.address, &raw_amt1);
        sac2.mint(&client.address, &raw_amt2);

        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);

        // Mint 500 shares each (total 1000 shares)
        client.mint_shares(&user1, &500);
        client.mint_shares(&user2, &500);

        assert_eq!(client.get_total_shares(), 1000);
        assert_eq!(client.get_user_shares(&user1), 500);
        assert_eq!(client.get_user_shares(&user2), 500);

        // 1. One-shot redemption: user1 redeems 500 shares at once
        let redemptions1 = client.redeem(&user1, &500);
        assert_eq!(redemptions1.len(), 3);

        let p1_0 = client0.balance(&user1);
        let p1_1 = client1.balance(&user1);
        let p1_2 = client2.balance(&user1);

        assert_eq!(p1_0, raw_amt0 / 2);
        assert_eq!(p1_1, raw_amt1 / 2);
        assert_eq!(p1_2, raw_amt2 / 2);

        assert_eq!(client.get_total_shares(), 500);
        assert_eq!(client.get_user_shares(&user1), 0);

        // 2. Split redemption: user2 redeems in two splits of 250 shares
        let red_split1 = client.redeem(&user2, &250);
        assert_eq!(red_split1.len(), 3);
        assert_eq!(client.get_total_shares(), 250);
        assert_eq!(client.get_user_shares(&user2), 250);

        let red_split2 = client.redeem(&user2, &250);
        assert_eq!(red_split2.len(), 3);
        assert_eq!(client.get_total_shares(), 0);
        assert_eq!(client.get_user_shares(&user2), 0);

        let p2_0 = client0.balance(&user2);
        let p2_1 = client1.balance(&user2);
        let p2_2 = client2.balance(&user2);

        // Under exact proportions, one-shot and split redemptions match identically
        assert_eq!(p1_0, p2_0);
        assert_eq!(p1_1, p2_1);
        assert_eq!(p1_2, p2_2);

        // Contract balances strictly 0 after full redemption
        assert_eq!(client0.balance(&client.address), 0);
        assert_eq!(client1.balance(&client.address), 0);
        assert_eq!(client2.balance(&client.address), 0);
    }

    #[test]
    fn test_compare_oneshot_vs_split_redemption_uneven_decimals_with_dust() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let (tok0, sac0, client0) = create_sac_token(&env);
        let (tok1, sac1, client1) = create_sac_token(&env);
        let (tok2, sac2, client2) = create_sac_token(&env);

        let mut configs = Vec::new(&env);
        configs.push_back(AssetConfig {
            token: tok0.clone(),
            weight_bps: 4_000,
            max_concentration_bps: 5_000,
        });
        configs.push_back(AssetConfig {
            token: tok1.clone(),
            weight_bps: 3_000,
            max_concentration_bps: 5_000,
        });
        configs.push_back(AssetConfig {
            token: tok2.clone(),
            weight_bps: 3_000,
            max_concentration_bps: 5_000,
        });

        client.initialize(&admin, &configs, &200);

        // Prime numbers and uneven scales that cause fractional remainders
        let raw_amt0: i128 = 100_000_003;
        let raw_amt1: i128 = 1_000_000_007;
        let raw_amt2: i128 = 999_999_999_999_999_999_999;

        // User A tests one-shot on a fresh basket with these exact amounts
        // User B tests split on a fresh basket with identical starting amounts
        // We compare User A (one-shot 333 shares) vs User B (split 111 + 111 + 111 shares)
        let user_a = Address::generate(&env);
        let user_b = Address::generate(&env);

        // Setup separate basket instances for fair comparison
        let contract_b_id = env.register(StablecoinBasketStrategy, ());
        let client_b = StablecoinBasketStrategyClient::new(&env, &contract_b_id);
        client_b.initialize(&admin, &configs, &200);

        // Fund Basket A
        sac0.mint(&client.address, &raw_amt0);
        sac1.mint(&client.address, &raw_amt1);
        sac2.mint(&client.address, &raw_amt2);
        client.mint_shares(&user_a, &1000);

        // Fund Basket B identically
        sac0.mint(&client_b.address, &raw_amt0);
        sac1.mint(&client_b.address, &raw_amt1);
        sac2.mint(&client_b.address, &raw_amt2);
        client_b.mint_shares(&user_b, &1000);

        // User A: One-shot redemption of 333 shares
        let oneshot_res = client.redeem(&user_a, &333);
        assert_eq!(oneshot_res.len(), 3);

        // User B: Split redemption in 3 chunks of 111 shares
        let split1 = client_b.redeem(&user_b, &111);
        let split2 = client_b.redeem(&user_b, &111);
        let split3 = client_b.redeem(&user_b, &111);

        assert_eq!(split1.len(), 3);
        assert_eq!(split2.len(), 3);
        assert_eq!(split3.len(), 3);

        // Verify remainders are explicitly reported and non-zero
        assert!(oneshot_res.get(0).unwrap().remainder > 0);
        assert!(oneshot_res.get(1).unwrap().remainder > 0);
        assert!(oneshot_res.get(2).unwrap().remainder > 0);

        // Compare total payouts per asset
        let bal_a0 = client0.balance(&user_a);
        let bal_a1 = client1.balance(&user_a);
        let bal_a2 = client2.balance(&user_a);

        let bal_b0 = client0.balance(&user_b);
        let bal_b1 = client1.balance(&user_b);
        let bal_b2 = client2.balance(&user_b);

        // Asset Conservation Invariant: Split redemptions strictly conserve assets (never overdraw).
        // Total payout of splits <= one-shot payout due to floor division per split.
        assert!(bal_b0 <= bal_a0);
        assert!(bal_b1 <= bal_a1);
        assert!(bal_b2 <= bal_a2);

        // Truncation bound: The difference between one-shot and 3-way split is strictly bounded
        // by the number of splits (at most 3 raw units per asset)
        assert!(bal_a0 - bal_b0 <= 3);
        assert!(bal_a1 - bal_b1 <= 3);
        assert!(bal_a2 - bal_b2 <= 3);

        // Vault reserves remain strictly positive and solvent
        assert!(client0.balance(&client_b.address) > 0);
        assert!(client1.balance(&client_b.address) > 0);
        assert!(client2.balance(&client_b.address) > 0);
    }

    #[test]
    fn test_final_redemption_sweeps_remaining_dust() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let (tok0, sac0, client0) = create_sac_token(&env);
        let (tok1, sac1, client1) = create_sac_token(&env);

        let mut configs = Vec::new(&env);
        configs.push_back(AssetConfig {
            token: tok0.clone(),
            weight_bps: 5_000,
            max_concentration_bps: 6_000,
        });
        configs.push_back(AssetConfig {
            token: tok1.clone(),
            weight_bps: 5_000,
            max_concentration_bps: 6_000,
        });

        client.initialize(&admin, &configs, &200);

        sac0.mint(&client.address, &1_000_003);
        sac1.mint(&client.address, &10_000_007);

        let user = Address::generate(&env);
        client.mint_shares(&user, &100);

        // Partial redemption of 50 shares (50/100 = 1/2, remainder = 50/100)
        let res_partial = client.redeem(&user, &50);
        assert_eq!(res_partial.get(0).unwrap().remainder, 50);
        assert_eq!(res_partial.get(1).unwrap().remainder, 50);

        // Final redemption of remaining 50 shares
        let res_final = client.redeem(&user, &50);
        assert_eq!(res_final.get(0).unwrap().remainder, 0);
        assert_eq!(res_final.get(1).unwrap().remainder, 0);

        // Entire contract balance is swept, 0 dust locked
        assert_eq!(client0.balance(&client.address), 0);
        assert_eq!(client1.balance(&client.address), 0);
        assert_eq!(client.get_total_shares(), 0);
        assert_eq!(client.get_user_shares(&user), 0);
    }

    #[test]
    fn test_boundary_zero_or_negative_shares_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        let (tok0, _sac0, _) = create_sac_token(&env);

        let mut configs = Vec::new(&env);
        configs.push_back(AssetConfig {
            token: tok0.clone(),
            weight_bps: 10_000,
            max_concentration_bps: 10_000,
        });
        client.initialize(&admin, &configs, &200);

        let user = Address::generate(&env);
        client.mint_shares(&user, &100);

        // Zero shares
        assert_eq!(
            client.try_redeem(&user, &0),
            Err(Ok(BasketError::ZeroAmount))
        );
        // Negative shares
        assert_eq!(
            client.try_redeem(&user, &-10),
            Err(Ok(BasketError::ZeroAmount))
        );

        // State preserved
        assert_eq!(client.get_total_shares(), 100);
        assert_eq!(client.get_user_shares(&user), 100);
    }

    #[test]
    fn test_boundary_empty_basket_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        let (tok0, _sac0, _) = create_sac_token(&env);

        let mut configs = Vec::new(&env);
        configs.push_back(AssetConfig {
            token: tok0.clone(),
            weight_bps: 10_000,
            max_concentration_bps: 10_000,
        });
        client.initialize(&admin, &configs, &200);

        let user = Address::generate(&env);
        assert_eq!(client.get_total_shares(), 0);

        assert_eq!(
            client.try_redeem(&user, &50),
            Err(Ok(BasketError::EmptyBasket))
        );
    }

    #[test]
    fn test_boundary_insufficient_shares_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        let (tok0, _sac0, _) = create_sac_token(&env);

        let mut configs = Vec::new(&env);
        configs.push_back(AssetConfig {
            token: tok0.clone(),
            weight_bps: 10_000,
            max_concentration_bps: 10_000,
        });
        client.initialize(&admin, &configs, &200);

        let user = Address::generate(&env);
        client.mint_shares(&user, &50);

        assert_eq!(
            client.try_redeem(&user, &51),
            Err(Ok(BasketError::InsufficientShares))
        );
        // State preserved
        assert_eq!(client.get_user_shares(&user), 50);
        assert_eq!(client.get_total_shares(), 50);
    }

    #[test]
    fn test_boundary_paused_redemption_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        let (tok0, _sac0, _) = create_sac_token(&env);

        let mut configs = Vec::new(&env);
        configs.push_back(AssetConfig {
            token: tok0.clone(),
            weight_bps: 10_000,
            max_concentration_bps: 10_000,
        });
        client.initialize(&admin, &configs, &200);

        let user = Address::generate(&env);
        client.mint_shares(&user, &100);

        client.pause();
        assert_eq!(client.try_redeem(&user, &50), Err(Ok(BasketError::Paused)));

        // Unpause allows redemption again
        client.unpause();
        assert!(client.try_redeem(&user, &50).is_ok());
    }

    #[test]
    fn test_preview_redeem_matches_execution() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        let (tok0, sac0, _) = create_sac_token(&env);

        let mut configs = Vec::new(&env);
        configs.push_back(AssetConfig {
            token: tok0.clone(),
            weight_bps: 10_000,
            max_concentration_bps: 10_000,
        });
        client.initialize(&admin, &configs, &200);

        sac0.mint(&client.address, &1_000_000);
        let user = Address::generate(&env);
        client.mint_shares(&user, &100);

        let preview = client.preview_redeem(&40);
        assert_eq!(preview.len(), 1);
        assert_eq!(preview.get(0).unwrap().amount, 400_000);
        assert_eq!(preview.get(0).unwrap().remainder, 0);

        // Preview made zero state changes
        assert_eq!(client.get_user_shares(&user), 100);
        assert_eq!(client.get_total_shares(), 100);

        // Actual execution produces exact same numbers
        let executed = client.redeem(&user, &40);
        assert_eq!(executed.get(0).unwrap().amount, 400_000);
        assert_eq!(executed.get(0).unwrap().remainder, 0);
    }
}
