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
