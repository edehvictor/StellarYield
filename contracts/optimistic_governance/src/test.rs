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
