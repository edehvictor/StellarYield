#![no_std]

//! # Optimistic Governance
//!
//! Proposals submitted by approved proposers become executable after a fixed
//! **3-day challenge window** unless a veYIELD holder disputes them. A dispute
//! freezes execution until the configured DAO resolver records the outcome of a
//! full DAO vote.

use soroban_sdk::{
    contract, contracterror, contractimpl, contractmeta, contracttype, symbol_short,
    vec as soroban_vec, Address, Env, IntoVal, Map, Symbol, Val, Vec,
};

contractmeta!(key = "name", val = "Optimistic Governance");
contractmeta!(key = "version", val = "0.1.0");
contractmeta!(
    key = "description",
    val = "Optimistic execution with challenge window, veYIELD disputes, and DAO resolution."
);

/// Challenge period in seconds (3 days). Fixed on-chain so it cannot be shortened by config.
pub const CHALLENGE_WINDOW_SECS: u64 = 3 * 24 * 60 * 60;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Initialized,
    RootAdmin,
    /// VeTokenomics-style contract implementing `get_voting_power(user) -> i128`.
    VeYield,
    /// Address allowed to report the outcome of the full DAO vote after a dispute.
    DaoResolver,
    NextProposalId,
    /// Set of addresses allowed to submit proposals.
    Proposers,
    Proposal(u32),
    /// Invocation arguments for `Proposal(id)` (stored separately — `Vec<Val>` is not allowed inside `#[contracttype]` structs).
    ProposalArgs(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    /// In challenge window (undisputed) or past window, not yet executed.
    Pending,
    /// Disputed during the window; execution frozen until DAO resolution.
    Disputed,
    /// Successfully invoked.
    Executed,
    /// Rejected by DAO vote after dispute.
    Cancelled,
    /// DAO vote approved the payload after a dispute; may be executed without waiting again.
    ApprovedAfterVote,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub proposer: Address,
    pub target: Address,
    pub func: Symbol,
    pub submitted_at: u64,
    pub status: ProposalStatus,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GovError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    NotProposer = 4,
    ProposalNotFound = 5,
    InvalidStatus = 6,
    ChallengeWindowNotOver = 7,
    ChallengeWindowOver = 8,
    NoVotingPower = 9,
    ProposalDisputed = 10,
    AlreadyExecuted = 11,
    NotDaoResolver = 12,
}

#[contract]
pub struct OptimisticGovernance;

#[contractimpl]
impl OptimisticGovernance {
    /// One-time setup: root admin, veYIELD contract for dispute checks, and DAO vote resolver.
    ///
    /// `root_admin` may add or remove proposers and is itself a proposer.
    /// `ve_yield` must expose `get_voting_power(user: Address) -> i128` (e.g. VeTokenomics).
    /// `dao_resolver` is the only address that may call [`resolve_dispute`](Self::resolve_dispute).
    pub fn initialize(
        env: Env,
        root_admin: Address,
        ve_yield: Address,
        dao_resolver: Address,
    ) -> Result<(), GovError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(GovError::AlreadyInitialized);
        }
        root_admin.require_auth();

        let mut proposers: Map<Address, bool> = Map::new(&env);
        proposers.set(root_admin.clone(), true);

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage()
            .instance()
            .set(&DataKey::RootAdmin, &root_admin);
        env.storage().instance().set(&DataKey::VeYield, &ve_yield);
        env.storage()
            .instance()
            .set(&DataKey::DaoResolver, &dao_resolver);
        env.storage()
            .instance()
            .set(&DataKey::NextProposalId, &1u32);
        env.storage()
            .instance()
            .set(&DataKey::Proposers, &proposers);

        env.events().publish(
            (symbol_short!("og_init"),),
            (root_admin, ve_yield, dao_resolver),
        );
        Ok(())
    }

    /// Add a proposer. Root admin only.
    pub fn add_proposer(env: Env, root_admin: Address, proposer: Address) -> Result<(), GovError> {
        Self::require_init(&env)?;
        Self::ensure_root_admin(&env, &root_admin)?;
        root_admin.require_auth();

        let mut m: Map<Address, bool> = env.storage().instance().get(&DataKey::Proposers).unwrap();
        m.set(proposer.clone(), true);
        env.storage().instance().set(&DataKey::Proposers, &m);

        env.events()
            .publish((symbol_short!("og_addp"),), (proposer,));
        Ok(())
    }

    /// Remove a proposer. Root admin only.
    pub fn remove_proposer(
        env: Env,
        root_admin: Address,
        proposer: Address,
    ) -> Result<(), GovError> {
        Self::require_init(&env)?;
        Self::ensure_root_admin(&env, &root_admin)?;
        root_admin.require_auth();

        let mut m: Map<Address, bool> = env.storage().instance().get(&DataKey::Proposers).unwrap();
        m.set(proposer.clone(), false);
        env.storage().instance().set(&DataKey::Proposers, &m);

        env.events()
            .publish((symbol_short!("og_remp"),), (proposer,));
        Ok(())
    }

    /// Submit an execution intent. Only registered proposers may call.
    ///
    /// The payload is executed later via [`execute`](Self::execute) after the challenge window,
    /// unless the proposal is disputed.
    ///
    /// `call_args` is the argument list passed to `invoke_contract` on `target` (same shape as other Soroban contracts).
    pub fn submit_proposal(
        env: Env,
        proposer: Address,
        target: Address,
        func: Symbol,
        call_args: Vec<Val>,
    ) -> Result<u32, GovError> {
        Self::require_init(&env)?;
        proposer.require_auth();
        Self::ensure_proposer(&env, &proposer)?;

        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextProposalId)
            .unwrap();
        let submitted_at = env.ledger().timestamp();
        let target_evt = target.clone();

        let proposal = Proposal {
            proposer: proposer.clone(),
            target,
            func,
            submitted_at,
            status: ProposalStatus::Pending,
        };

        env.storage()
            .instance()
            .set(&DataKey::Proposal(id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalArgs(id), &call_args);
        env.storage()
            .instance()
            .set(&DataKey::NextProposalId, &(id + 1));

        env.events().publish(
            (symbol_short!("og_sub"),),
            (id, proposer, target_evt, submitted_at),
        );
        Ok(id)
    }

    /// Dispute a proposal during the challenge window. Requires positive veYIELD voting power
    /// from `ve_yield` via `get_voting_power(disputer)`. Freezes execution until DAO resolution.
    pub fn dispute(env: Env, disputer: Address, proposal_id: u32) -> Result<(), GovError> {
        Self::require_init(&env)?;
        disputer.require_auth();

        let ve: Address = env.storage().instance().get(&DataKey::VeYield).unwrap();
        let vp = Self::read_voting_power(&env, &ve, &disputer);
        if vp <= 0 {
            return Err(GovError::NoVotingPower);
        }

        let mut p: Proposal = Self::load_proposal(&env, proposal_id)?;
        if p.status != ProposalStatus::Pending {
            return Err(GovError::InvalidStatus);
        }

        let now = env.ledger().timestamp();
        if now >= p.submitted_at.saturating_add(CHALLENGE_WINDOW_SECS) {
            return Err(GovError::ChallengeWindowOver);
        }

        p.status = ProposalStatus::Disputed;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &p);

        env.events()
            .publish((symbol_short!("og_dis"),), (proposal_id, disputer));
        Ok(())
    }

    /// Record the outcome of the full DAO vote for a disputed proposal. Only `dao_resolver` may call.
    ///
    /// `approved == true` allows execution via [`execute`](Self::execute). `false` cancels the proposal.
    pub fn resolve_dispute(
        env: Env,
        resolver: Address,
        proposal_id: u32,
        approved: bool,
    ) -> Result<(), GovError> {
        Self::require_init(&env)?;
        resolver.require_auth();

        let expected: Address = env.storage().instance().get(&DataKey::DaoResolver).unwrap();
        if resolver != expected {
            return Err(GovError::NotDaoResolver);
        }

        let mut p: Proposal = Self::load_proposal(&env, proposal_id)?;
        if p.status != ProposalStatus::Disputed {
            return Err(GovError::InvalidStatus);
        }

        p.status = if approved {
            ProposalStatus::ApprovedAfterVote
        } else {
            ProposalStatus::Cancelled
        };
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &p);

        env.events()
            .publish((symbol_short!("og_res"),), (proposal_id, approved));
        Ok(())
    }

    /// Execute the proposal payload. Callable by anyone once undisputed proposals pass the timelock,
    /// or after DAO approval following a dispute.
    ///
    /// Re-entrancy: status is set to [`ProposalStatus::Executed`] before the external call.
    pub fn execute(env: Env, proposal_id: u32) -> Result<(), GovError> {
        Self::require_init(&env)?;

        let mut p: Proposal = Self::load_proposal(&env, proposal_id)?;

        match p.status {
            ProposalStatus::Executed => return Err(GovError::AlreadyExecuted),
            ProposalStatus::Cancelled => return Err(GovError::InvalidStatus),
            ProposalStatus::Disputed => return Err(GovError::ProposalDisputed),
            ProposalStatus::Pending => {
                let now = env.ledger().timestamp();
                let unlock = p.submitted_at.saturating_add(CHALLENGE_WINDOW_SECS);
                if now < unlock {
                    return Err(GovError::ChallengeWindowNotOver);
                }
            }
            ProposalStatus::ApprovedAfterVote => {}
        }

        p.status = ProposalStatus::Executed;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &p);

        let target = p.target.clone();
        let func = p.func.clone();
        let call_args: Vec<Val> = Self::load_proposal_args(&env, proposal_id)?;
        env.invoke_contract::<()>(&target, &func, call_args);

        env.events()
            .publish((symbol_short!("og_exec"),), (proposal_id,));
        Ok(())
    }

    // --- Views ---

    /// Returns the fixed challenge window length in seconds (3 days).
    pub fn challenge_window_secs(_env: Env) -> u64 {
        CHALLENGE_WINDOW_SECS
    }

    pub fn get_proposal(env: Env, proposal_id: u32) -> Result<Proposal, GovError> {
        Self::require_init(&env)?;
        Self::load_proposal(&env, proposal_id)
    }

    /// Returns the stored `invoke_contract` argument vector for this proposal.
    pub fn get_proposal_args(env: Env, proposal_id: u32) -> Result<Vec<Val>, GovError> {
        Self::require_init(&env)?;
        Self::load_proposal_args(&env, proposal_id)
    }

    pub fn is_proposer(env: Env, addr: Address) -> bool {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return false;
        }
        let m: Map<Address, bool> = env.storage().instance().get(&DataKey::Proposers).unwrap();
        m.get(addr).unwrap_or(false)
    }

    fn require_init(env: &Env) -> Result<(), GovError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(GovError::NotInitialized);
        }
        Ok(())
    }

    fn ensure_root_admin(env: &Env, who: &Address) -> Result<(), GovError> {
        let a: Address = env.storage().instance().get(&DataKey::RootAdmin).unwrap();
        if who != &a {
            return Err(GovError::Unauthorized);
        }
        Ok(())
    }

    fn ensure_proposer(env: &Env, who: &Address) -> Result<(), GovError> {
        let m: Map<Address, bool> = env.storage().instance().get(&DataKey::Proposers).unwrap();
        if !m.get(who.clone()).unwrap_or(false) {
            return Err(GovError::NotProposer);
        }
        Ok(())
    }

    fn load_proposal(env: &Env, id: u32) -> Result<Proposal, GovError> {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(id))
            .ok_or(GovError::ProposalNotFound)
    }

    fn load_proposal_args(env: &Env, id: u32) -> Result<Vec<Val>, GovError> {
        env.storage()
            .instance()
            .get(&DataKey::ProposalArgs(id))
            .ok_or(GovError::ProposalNotFound)
    }

    fn read_voting_power(env: &Env, ve: &Address, user: &Address) -> i128 {
        let sym = Symbol::new(env, "get_voting_power");
        // `env` is already `&Env`; do not pass `&env` (that would be `&&Env` and breaks `into_val`).
        let args = soroban_vec![env, user.clone().into_val(env)];
        env.invoke_contract::<i128>(ve, &sym, args)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{contract, contractimpl};

    #[contract]
    pub struct MockVeYield;

    #[contractimpl]
    impl MockVeYield {
        pub fn get_voting_power(env: Env, user: Address) -> i128 {
            env.storage().instance().get(&user).unwrap_or(0i128)
        }

        pub fn set_vp(env: Env, user: Address, power: i128) {
            env.storage().instance().set(&user, &power);
        }
    }

    #[contract]
    pub struct MockCallee;

    #[contractimpl]
    impl MockCallee {
        pub fn bump(env: Env) {
            let k = symbol_short!("hits");
            let c: u32 = env.storage().instance().get(&k).unwrap_or(0);
            env.storage().instance().set(&k, &(c + 1));
        }

        pub fn hit_count(env: Env) -> u32 {
            let k = symbol_short!("hits");
            env.storage().instance().get(&k).unwrap_or(0)
        }
    }

    fn empty_call_args(env: &Env) -> Vec<Val> {
        Vec::new(env)
    }

    fn setup_env() -> (
        Env,
        Address,
        Address,
        Address,
        OptimisticGovernanceClient<'static>,
        MockVeYieldClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let root = Address::generate(&env);
        let dao = Address::generate(&env);
        let ve_id = env.register(MockVeYield, ());
        let ve_client = MockVeYieldClient::new(&env, &ve_id);

        let gov_id = env.register(OptimisticGovernance, ());
        let client = OptimisticGovernanceClient::new(&env, &gov_id);

        client.initialize(&root, &ve_id, &dao);
        (env, root, dao, ve_id, client, ve_client)
    }

    #[test]
    fn initialize_sets_state() {
        let (_, root, _, _, client, _) = setup_env();
        assert_eq!(client.challenge_window_secs(), CHALLENGE_WINDOW_SECS);
        assert!(client.is_proposer(&root));
        assert!(client.try_get_proposal(&1).is_err());
    }

    #[test]
    fn double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let root = Address::generate(&env);
        let ve = env.register(MockVeYield, ());
        let dao = Address::generate(&env);
        let gov_id = env.register(OptimisticGovernance, ());
        let client = OptimisticGovernanceClient::new(&env, &gov_id);
        client.initialize(&root, &ve, &dao);
        assert!(client.try_initialize(&root, &ve, &dao).is_err());
    }

    #[test]
    fn non_proposer_cannot_submit() {
        let (env, _, _, _, client, _) = setup_env();
        let bad = Address::generate(&env);
        let target = Address::generate(&env);
        assert!(client
            .try_submit_proposal(
                &bad,
                &target,
                &Symbol::new(&env, "bump"),
                &empty_call_args(&env),
            )
            .is_err());
    }

    #[test]
    fn submit_and_execute_after_window() {
        let (env, root, _, _, client, _) = setup_env();
        let callee_id = env.register(MockCallee, ());

        let id = client.submit_proposal(
            &root,
            &callee_id,
            &Symbol::new(&env, "bump"),
            &empty_call_args(&env),
        );

        env.ledger().set_timestamp(0);
        let prop = client.get_proposal(&id);
        assert_eq!(prop.status, ProposalStatus::Pending);

        assert!(client.try_execute(&id).is_err());

        env.ledger()
            .set_timestamp(CHALLENGE_WINDOW_SECS + prop.submitted_at);

        client.execute(&id);
        let c = MockCalleeClient::new(&env, &callee_id);
        assert_eq!(c.hit_count(), 1u32);

        let p2 = client.get_proposal(&id);
        assert_eq!(p2.status, ProposalStatus::Executed);

        assert!(client.try_execute(&id).is_err());
    }

    #[test]
    fn dispute_freezes_until_resolution() {
        let (env, root, dao, _, client, ve_client) = setup_env();
        let callee_id = env.register(MockCallee, ());
        let disputer = Address::generate(&env);

        ve_client.set_vp(&disputer, &1i128);

        let id = client.submit_proposal(
            &root,
            &callee_id,
            &Symbol::new(&env, "bump"),
            &empty_call_args(&env),
        );

        env.ledger().set_timestamp(10);
        client.dispute(&disputer, &id);

        assert_eq!(client.get_proposal(&id).status, ProposalStatus::Disputed);

        env.ledger().set_timestamp(10 + CHALLENGE_WINDOW_SECS);
        assert!(client.try_execute(&id).is_err());

        assert!(client
            .try_resolve_dispute(&Address::generate(&env), &id, &true)
            .is_err());

        client.resolve_dispute(&dao, &id, &false);
        assert_eq!(client.get_proposal(&id).status, ProposalStatus::Cancelled);
        assert!(client.try_execute(&id).is_err());
    }

    #[test]
    fn dispute_after_window_fails() {
        let (env, root, _, _, client, ve_client) = setup_env();
        let callee_id = env.register(MockCallee, ());
        let disputer = Address::generate(&env);

        ve_client.set_vp(&disputer, &100i128);

        let id = client.submit_proposal(
            &root,
            &callee_id,
            &Symbol::new(&env, "bump"),
            &empty_call_args(&env),
        );

        let prop = client.get_proposal(&id);
        env.ledger()
            .set_timestamp(prop.submitted_at + CHALLENGE_WINDOW_SECS);

        assert!(client.try_dispute(&disputer, &id).is_err());
    }

    #[test]
    fn dispute_without_power_fails() {
        let (env, root, _, _, client, _) = setup_env();
        let callee_id = env.register(MockCallee, ());
        let disputer = Address::generate(&env);

        let id = client.submit_proposal(
            &root,
            &callee_id,
            &Symbol::new(&env, "bump"),
            &empty_call_args(&env),
        );

        env.ledger().set_timestamp(5);
        assert!(client.try_dispute(&disputer, &id).is_err());
    }

    #[test]
    fn resolve_approve_then_execute() {
        let (env, root, dao, _, client, ve_client) = setup_env();
        let callee_id = env.register(MockCallee, ());
        let disputer = Address::generate(&env);

        ve_client.set_vp(&disputer, &1i128);

        let id = client.submit_proposal(
            &root,
            &callee_id,
            &Symbol::new(&env, "bump"),
            &empty_call_args(&env),
        );

        env.ledger().set_timestamp(1);
        client.dispute(&disputer, &id);
        client.resolve_dispute(&dao, &id, &true);

        client.execute(&id);
        let c = MockCalleeClient::new(&env, &callee_id);
        assert_eq!(c.hit_count(), 1u32);
    }

    #[test]
    fn add_remove_proposer() {
        let (env, root, _, _, client, _) = setup_env();
        let p = Address::generate(&env);
        client.add_proposer(&root, &p);
        assert!(client.is_proposer(&p));
        client.remove_proposer(&root, &p);
        assert!(!client.is_proposer(&p));
    }

    #[test]
    fn non_root_cannot_add_proposer() {
        let (env, _, _, _, client, _) = setup_env();
        let other = Address::generate(&env);
        let p = Address::generate(&env);
        assert!(client.try_add_proposer(&other, &p).is_err());
    }

    #[test]
    fn cannot_dispute_twice() {
        let (env, root, _, _, client, ve_client) = setup_env();
        let callee_id = env.register(MockCallee, ());
        let d1 = Address::generate(&env);
        let d2 = Address::generate(&env);

        ve_client.set_vp(&d1, &1i128);
        ve_client.set_vp(&d2, &1i128);

        let id = client.submit_proposal(
            &root,
            &callee_id,
            &Symbol::new(&env, "bump"),
            &empty_call_args(&env),
        );

        env.ledger().set_timestamp(2);
        client.dispute(&d1, &id);
        assert!(client.try_dispute(&d2, &id).is_err());
    }

    #[test]
    fn resolve_wrong_status_fails() {
        let (env, root, dao, _, client, _) = setup_env();
        let callee_id = env.register(MockCallee, ());

        let id = client.submit_proposal(
            &root,
            &callee_id,
            &Symbol::new(&env, "bump"),
            &empty_call_args(&env),
        );

        assert!(client.try_resolve_dispute(&dao, &id, &true).is_err());
    }

    #[test]
    fn get_proposal_missing() {
        let (_, _, _, _, client, _) = setup_env();
        assert!(client.try_get_proposal(&99).is_err());
    }

    #[test]
    fn not_initialized_views() {
        let env = Env::default();
        let gov_id = env.register(OptimisticGovernance, ());
        let client = OptimisticGovernanceClient::new(&env, &gov_id);
        assert!(!client.is_proposer(&Address::generate(&env)));
        assert!(client.try_get_proposal(&1).is_err());
    }
}
