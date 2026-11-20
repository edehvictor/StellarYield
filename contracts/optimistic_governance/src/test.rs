use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, Env, IntoVal, Symbol,
};

// Mock Target Contract for execution
#[contract]
pub struct TargetContract;

#[contractimpl]
impl TargetContract {
    pub fn action(_env: Env, value: i128) -> i128 {
        value + 1
    }
}

mod mock_ve_yield {
    use soroban_sdk::{contract, contractimpl, Address, Env};
    #[contract]
    pub struct MockVeYield;

    #[contractimpl]
    impl MockVeYield {
        pub fn get_voting_power(_env: Env, _user: Address) -> i128 {
            100
        }

        pub fn get_voting_power_at(_env: Env, _user: Address, _timestamp: u64) -> i128 {
            100
        }
    }
}
use mock_ve_yield::MockVeYield;

mod no_power_ve_yield {
    use soroban_sdk::{contract, contractimpl, Address, Env};
    #[contract]
    pub struct NoPowerVeYield;

    #[contractimpl]
    impl NoPowerVeYield {
        pub fn get_voting_power(_env: Env, _user: Address) -> i128 {
            0
        }

        pub fn get_voting_power_at(_env: Env, _user: Address, _timestamp: u64) -> i128 {
            0
        }
    }
}
use no_power_ve_yield::NoPowerVeYield;

#[test]
fn test_governance_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());

    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window = 3 * 24 * 60 * 60; // 3 days
    client.initialize(&admin, &ve_yield, &challenge_window);

    // 1. Propose
    let args: Vec<Val> = vec![&env, 10i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    assert_eq!(proposal_id, 1);
    let proposal = client.get_proposal(&1).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Pending);

    // 2. Try execute early (should fail)
    let result = client.try_execute(&1);
    assert!(result.is_err());

    // 3. Fast forward time
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window + 1);

    // 4. Execute
    let val = client.execute(&1);
    let result_val: i128 = val.into_val(&env);
    assert_eq!(result_val, 11);

    let proposal = client.get_proposal(&1).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Executed);
}

#[test]
fn test_dispute() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());

    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);

    // Propose
    let args: Vec<Val> = vec![&env, 10i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    // Dispute
    let disputer = Address::generate(&env);
    client.dispute(&disputer, &proposal_id);

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Disputed);

    // Fast forward
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window + 1);

    // Try execute (should fail)
    let result = client.try_execute(&proposal_id);
    assert!(result.is_err());
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #8)")] // InsufficientVotingPower
fn test_dispute_no_power() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let ve_yield = env.register(NoPowerVeYield, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    client.initialize(&admin, &ve_yield, &(3 * 24 * 60 * 60));

    let target = Address::generate(&env);
    let args: Vec<Val> = vec![&env, 0i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    let disputer = Address::generate(&env);
    client.dispute(&disputer, &proposal_id);
}

// ── Challenge-window boundary tests (#875) ────────────────────────────

#[test]
fn test_execute_at_exact_boundary() {
    // execute is accepted when timestamp equals execution_time exactly
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 5i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    // execution_time = 0 (initial timestamp) + challenge_window
    env.ledger().with_mut(|li| li.timestamp = challenge_window);

    let val = client.execute(&proposal_id);
    let result: i128 = val.into_val(&env);
    assert_eq!(result, 6); // 5 + 1

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Executed);
}

#[test]
fn test_execute_one_second_before_boundary_fails() {
    // execute must be rejected when timestamp is still inside the challenge window
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 0i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    // one second before the window closes
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window - 1);

    let result = client.try_execute(&proposal_id);
    assert!(result.is_err(), "execute must fail while window is open");
}

#[test]
fn test_dispute_at_last_second_inside_window() {
    // dispute is valid right up to execution_time - 1
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 0i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    // last valid second to dispute
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window - 1);

    let disputer = Address::generate(&env);
    client.dispute(&disputer, &proposal_id);

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Disputed);
}

#[test]
fn test_dispute_at_exact_boundary_fails() {
    // disputing at execution_time is too late — window is closed
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 0i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    env.ledger().with_mut(|li| li.timestamp = challenge_window);

    let disputer = Address::generate(&env);
    let result = client.try_dispute(&disputer, &proposal_id);
    assert!(
        result.is_err(),
        "dispute must fail once the window has closed"
    );
}

// ── Post-resolution storage cleanup tests (#875) ──────────────────────

#[test]
fn test_proposal_record_persists_after_execution() {
    // After execution the proposal record is still readable with Executed status.
    // This verifies the record is updated in place (not deleted) on resolution.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 1i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window + 1);
    client.execute(&proposal_id);

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Executed);
    assert_eq!(proposal.id, proposal_id);
}

#[test]
fn test_double_execute_fails() {
    // Executing an already-executed proposal must return ProposalAlreadyExecuted.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 0i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window + 1);
    client.execute(&proposal_id);

    // second execute must be rejected
    let result = client.try_execute(&proposal_id);
    assert!(
        result.is_err(),
        "re-executing a resolved proposal must fail"
    );
}

#[test]
fn test_expired_uncleared_proposal_still_executable() {
    // A proposal well past its execution time that was never executed
    // should still be executable — no phantom cleanup removes it.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 7i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    // jump far into the future — 10× the window — without executing
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window * 10);

    // proposal record is still accessible and Pending
    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Pending);

    // and it can still be executed
    let val = client.execute(&proposal_id);
    let result: i128 = val.into_val(&env);
    assert_eq!(result, 8); // 7 + 1
}

// ── Challenge-window boundary coverage (#960) ─────────────────────────
//
// Boundary semantics (document for indexers / callers):
// - Window START = propose timestamp (inclusive): dispute OK, execute FAIL
// - Window END   = execution_time (inclusive for execute): dispute FAIL, execute OK
// - Before start is not reachable after propose (window opens immediately)
// - After expiry  = timestamp > execution_time: dispute FAIL, execute OK if Pending

#[test]
fn test_boundary_at_exact_window_start() {
    // At propose time (window start): dispute allowed, execute rejected
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 0i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    // Still at start of window (timestamp unchanged after propose)
    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Pending);
    assert!(client.try_execute(&proposal_id).is_err());

    let disputer = Address::generate(&env);
    client.dispute(&disputer, &proposal_id);
    assert_eq!(
        client.get_proposal(&proposal_id).unwrap().status,
        ProposalStatus::Disputed
    );
}

#[test]
fn test_unchallenged_transitions_pending_to_executed_at_end() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 100;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 2i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);
    assert_eq!(
        client.get_proposal(&proposal_id).unwrap().status,
        ProposalStatus::Pending
    );

    // Exact end of window
    env.ledger().with_mut(|li| li.timestamp = challenge_window);
    let val = client.execute(&proposal_id);
    let result: i128 = val.into_val(&env);
    assert_eq!(result, 3);
    assert_eq!(
        client.get_proposal(&proposal_id).unwrap().status,
        ProposalStatus::Executed
    );
}

#[test]
fn test_challenged_stays_disputed_after_expiry() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 100;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 0i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    let disputer = Address::generate(&env);
    client.dispute(&disputer, &proposal_id);

    // After expiry — still Disputed, execute rejected
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window + 50);
    assert!(client.try_execute(&proposal_id).is_err());
    assert_eq!(
        client.get_proposal(&proposal_id).unwrap().status,
        ProposalStatus::Disputed
    );
    // Dispute also rejected after expiry
    let other = Address::generate(&env);
    assert!(client.try_dispute(&other, &proposal_id).is_err());
}

#[test]
fn test_before_start_execute_fails_and_after_expiry_execute_ok() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 50;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 9i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    // Before end (= still inside window / "before executable")
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window - 1);
    assert!(client.try_execute(&proposal_id).is_err());

    // After expiry
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window + 1);
    let val = client.execute(&proposal_id);
    let result: i128 = val.into_val(&env);
    assert_eq!(result, 10);
    assert_eq!(
        client.get_proposal(&proposal_id).unwrap().status,
        ProposalStatus::Executed
    );
}

// ── Execution readiness checks (#1327) ─────────────────────────────────

#[test]
fn test_is_execution_ready_true_after_window_elapses() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 100;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 1i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    env.ledger().with_mut(|li| li.timestamp = challenge_window);

    let readiness = client.is_execution_ready(&proposal_id);
    assert!(readiness.is_ready);
    assert!(readiness.blocking_reasons.is_empty());
}

#[test]
fn test_is_execution_ready_reports_challenge_window_active() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 100;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 1i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    // still inside the challenge window
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window - 1);

    let readiness = client.is_execution_ready(&proposal_id);
    assert!(!readiness.is_ready);
    assert_eq!(readiness.blocking_reasons.len(), 1);
    assert_eq!(
        readiness.blocking_reasons.get(0),
        Some(Error::ChallengeWindowActive as u32)
    );
}

#[test]
fn test_is_execution_ready_reports_disputed() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 100;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 1i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    let disputer = Address::generate(&env);
    client.dispute(&disputer, &proposal_id);

    // even after the window elapses, a disputed proposal is still blocked
    env.ledger().with_mut(|li| li.timestamp = challenge_window);

    let readiness = client.is_execution_ready(&proposal_id);
    assert!(!readiness.is_ready);
    assert_eq!(
        readiness.blocking_reasons.get(0),
        Some(Error::ProposalDisputed as u32)
    );
}

#[test]
fn test_is_execution_ready_reports_already_executed() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 100;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 1i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    env.ledger().with_mut(|li| li.timestamp = challenge_window);
    client.execute(&proposal_id);

    let readiness = client.is_execution_ready(&proposal_id);
    assert!(!readiness.is_ready);
    assert_eq!(
        readiness.blocking_reasons.get(0),
        Some(Error::ProposalAlreadyExecuted as u32)
    );
}

#[test]
fn test_is_execution_ready_unknown_proposal_errors() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 100;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let result = client.try_is_execution_ready(&999);
    assert!(result.is_err());
}

#[test]
fn test_execute_and_is_execution_ready_agree_on_blocking_reason() {
    // The first reason execute() reverts with must match the first entry
    // is_execution_ready() reports, since both share the same check order.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window: u64 = 100;
    client.initialize(&admin, &ve_yield, &challenge_window);

    let args: Vec<Val> = vec![&env, 1i128.into_val(&env)];
    let proposal_id = client.propose(&admin, &target, &Symbol::new(&env, "action"), &args);

    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window - 1);

    let readiness = client.is_execution_ready(&proposal_id);
    let execute_result = client.try_execute(&proposal_id);

    let execute_error = match execute_result {
        Err(Ok(e)) => e as u32,
        other => panic!("expected a contract error, got {:?}", other),
    };

    assert_eq!(readiness.blocking_reasons.get(0), Some(execute_error));
}

// ── Voting weight is frozen when a proposal is created (#1513) ────────────

mod snapshot_weight {
    use super::*;
    use soroban_sdk::token;
    use ve_tokenomics::{VeTokenomics, VeTokenomicsClient};

    const START: u64 = 1_000_000;
    const WEEK: u64 = 7 * 24 * 60 * 60;
    const LOCKED: i128 = 10_000_000_000;

    struct Setup<'a> {
        env: Env,
        admin: Address,
        target: Address,
        gov: OptimisticGovernanceClient<'a>,
        ve: VeTokenomicsClient<'a>,
        token: token::StellarAssetClient<'a>,
    }

    fn setup<'a>() -> Setup<'a> {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(START);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_addr = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token = token::StellarAssetClient::new(&env, &token_addr);

        let ve_id = env.register(VeTokenomics, ());
        let ve = VeTokenomicsClient::new(&env, &ve_id);
        ve.initialize(&admin, &token_addr);

        let target = env.register(TargetContract, ());
        let gov_id = env.register(OptimisticGovernance, ());
        let gov = OptimisticGovernanceClient::new(&env, &gov_id);
        // A long window so tokens can unlock and move while the proposal is open.
        gov.initialize(&admin, &ve_id, &(4 * WEEK));

        Setup {
            env,
            admin,
            target,
            gov,
            ve,
            token,
        }
    }

    impl Setup<'_> {
        fn lock(&self, user: &Address, amount: i128, weeks: u64) {
            self.token.mint(user, &amount);
            let unlock = self.env.ledger().timestamp() + weeks * WEEK;
            self.ve.create_lock(user, &amount, &unlock);
        }

        fn propose(&self) -> u64 {
            let args: Vec<Val> = vec![&self.env, 1i128.into_val(&self.env)];
            self.gov.propose(
                &self.admin,
                &self.target,
                &Symbol::new(&self.env, "action"),
                &args,
            )
        }

        fn advance_to(&self, timestamp: u64) {
            self.env.ledger().set_timestamp(timestamp);
        }
    }

    #[test]
    fn test_proposal_records_the_time_its_weight_is_measured_at() {
        let t = setup();
        let id = t.propose();
        assert_eq!(t.gov.get_proposal_snapshot(&id), Some(START));
        assert_eq!(t.gov.get_proposal_snapshot(&99), None);

        t.advance_to(START + 500);
        let later = t.propose();
        assert_eq!(t.gov.get_proposal_snapshot(&later), Some(START + 500));
        // The first proposal keeps its own snapshot.
        assert_eq!(t.gov.get_proposal_snapshot(&id), Some(START));
    }

    #[test]
    fn test_unlocking_and_withdrawing_after_the_snapshot_keeps_the_right_to_dispute() {
        let t = setup();
        let holder = Address::generate(&t.env);
        t.lock(&holder, LOCKED, 2);
        let id = t.propose();

        // The lock expires and the holder takes the tokens out.
        t.advance_to(START + 2 * WEEK + 10);
        t.ve.withdraw(&holder);
        assert_eq!(t.ve.get_voting_power(&holder), 0);

        // Their weight when the proposal was created still counts.
        assert!(t.ve.get_voting_power_at(&holder, &START) > 0);
        t.gov.dispute(&holder, &id);
        assert_eq!(
            t.gov.get_proposal(&id).unwrap().status,
            ProposalStatus::Disputed
        );
    }

    #[test]
    fn test_tokens_moved_to_another_account_after_the_snapshot_give_it_no_say() {
        let t = setup();
        let original = Address::generate(&t.env);
        let recipient = Address::generate(&t.env);
        t.lock(&original, LOCKED, 2);
        let id = t.propose();

        // The tokens unlock, move to another account and are locked again.
        t.advance_to(START + 2 * WEEK + 10);
        t.ve.withdraw(&original);
        let token = token::Client::new(&t.env, &t.token.address);
        token.transfer(&original, &recipient, &LOCKED);
        let unlock = t.env.ledger().timestamp() + 2 * WEEK;
        t.ve.create_lock(&recipient, &LOCKED, &unlock);

        // The recipient holds weight now but held none when the proposal began.
        assert!(t.ve.get_voting_power(&recipient) > 0);
        assert_eq!(
            t.gov.try_dispute(&recipient, &id),
            Err(Ok(Error::InsufficientVotingPower))
        );
        assert_eq!(
            t.gov.get_proposal(&id).unwrap().status,
            ProposalStatus::Pending
        );

        // The original holder can still dispute.
        t.gov.dispute(&original, &id);
    }

    #[test]
    fn test_locking_after_the_proposal_was_created_does_not_grant_weight() {
        let t = setup();
        let id = t.propose();

        t.advance_to(START + 60);
        let latecomer = Address::generate(&t.env);
        t.lock(&latecomer, LOCKED, 52);

        assert_eq!(
            t.gov.try_dispute(&latecomer, &id),
            Err(Ok(Error::InsufficientVotingPower))
        );
    }

    #[test]
    fn test_locking_in_the_same_second_as_the_proposal_counts() {
        let t = setup();
        let holder = Address::generate(&t.env);
        t.lock(&holder, LOCKED, 2);
        let id = t.propose();

        t.gov.dispute(&holder, &id);
    }

    #[test]
    fn test_adding_to_a_lock_after_the_snapshot_does_not_raise_the_weight() {
        let t = setup();
        let holder = Address::generate(&t.env);
        t.lock(&holder, LOCKED, 4);
        let id = t.propose();
        let snapshot = t.gov.get_proposal_snapshot(&id).unwrap();
        let before = t.ve.get_voting_power_at(&holder, &snapshot);

        t.advance_to(START + 60);
        t.token.mint(&holder, &LOCKED);
        t.ve.increase_amount(&holder, &LOCKED);

        assert_eq!(t.ve.get_voting_power_at(&holder, &snapshot), before);
        assert!(t.ve.get_voting_power_at(&holder, &(START + 60)) > before);
    }

    #[test]
    fn test_proposals_without_a_snapshot_fall_back_to_current_power() {
        let t = setup();
        let id = t.propose();
        // A proposal stored before snapshots were recorded has no entry.
        t.env.as_contract(&t.gov.address, || {
            t.env
                .storage()
                .persistent()
                .remove(&DataKey::ProposalSnapshot(id));
        });
        assert_eq!(t.gov.get_proposal_snapshot(&id), None);

        t.advance_to(START + 60);
        let holder = Address::generate(&t.env);
        t.lock(&holder, LOCKED, 4);
        t.gov.dispute(&holder, &id);
    }

    #[test]
    fn test_each_proposal_uses_its_own_snapshot() {
        let t = setup();
        let first = t.propose();

        t.advance_to(START + 60);
        let holder = Address::generate(&t.env);
        t.lock(&holder, LOCKED, 4);
        let second = t.propose();

        assert_eq!(
            t.gov.try_dispute(&holder, &first),
            Err(Ok(Error::InsufficientVotingPower))
        );
        t.gov.dispute(&holder, &second);
    }
}
