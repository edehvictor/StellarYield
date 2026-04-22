#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, symbol_short, Address, Env, Symbol, Vec, Val,
};

mod storage;

#[cfg(test)]
mod test;

use storage::{DataKey, Proposal, ProposalStatus};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    ProposalNotFound = 4,
    ChallengeWindowActive = 5,
    ProposalDisputed = 6,
    ProposalAlreadyExecuted = 7,
    InsufficientVotingPower = 8,
    ChallengeWindowExpired = 9,
}

// Interface for ve_tokenomics (veYIELD)
mod ve_yield {
    use soroban_sdk::{contractclient, Address, Env};
    
    #[contractclient(name = "VeYieldClient")]
    pub trait VeYieldInterface {
        fn get_voting_power(env: Env, user: Address) -> i128;
    }
}

#[contract]
pub struct OptimisticGovernance;

#[contractimpl]
impl OptimisticGovernance {
    /// Initialize the contract with an admin and the ve_tokenomics address.
    pub fn initialize(
        env: Env,
        admin: Address,
        ve_yield_token: Address,
        challenge_window: u64,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::IsInitialized) {
            return Err(Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::VeYieldToken, &ve_yield_token);
        env.storage().instance().set(&DataKey::ChallengeWindow, &challenge_window);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage().instance().set(&DataKey::IsInitialized, &true);

        Ok(())
    }

    /// Submit a proposal with a payload to be executed after the challenge window.
    pub fn propose(
        env: Env,
        proposer: Address,
        contract_id: Address,
        function: Symbol,
        args: Vec<Val>,
    ) -> Result<u64, Error> {
        Self::require_init(&env)?;
        proposer.require_auth();

        // Check if proposer is admin
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if proposer != admin {
            return Err(Error::Unauthorized);
        }

        let count: u64 = env.storage().instance().get(&DataKey::ProposalCount).unwrap_or(0);
        let proposal_id = count + 1;

        let challenge_window: u64 = env.storage().instance().get(&DataKey::ChallengeWindow).unwrap();
        let execution_time = env.ledger().timestamp() + challenge_window;

        let proposal = Proposal {
            id: proposal_id,
            proposer: proposer.clone(),
            contract_id,
            function,
            args,
            execution_time,
            status: ProposalStatus::Pending,
        };

        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage().instance().set(&DataKey::ProposalCount, &proposal_id);

        env.events().publish(
            (symbol_short!("propose"), proposer),
            (proposal_id, execution_time),
        );

        Ok(proposal_id)
    }

    /// Dispute a proposal, freezing its execution.
    /// Requires non-zero veYIELD voting power.
    pub fn dispute(env: Env, disputer: Address, proposal_id: u64) -> Result<(), Error> {
        Self::require_init(&env)?;
        disputer.require_auth();

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(Error::ProposalAlreadyExecuted);
        }

        let current_time = env.ledger().timestamp();
        if current_time >= proposal.execution_time {
            return Err(Error::ChallengeWindowExpired);
        }

        // Check veYIELD voting power
        let ve_yield_token: Address = env.storage().instance().get(&DataKey::VeYieldToken).unwrap();
        let client = ve_yield::VeYieldClient::new(&env, &ve_yield_token);
        let voting_power = client.get_voting_power(&disputer);

        if voting_power <= 0 {
            return Err(Error::InsufficientVotingPower);
        }

        proposal.status = ProposalStatus::Disputed;
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("dispute"), disputer),
            (proposal_id,),
        );

        Ok(())
    }

    /// Execute a proposal after the challenge window expires, if not disputed.
    pub fn execute(env: Env, proposal_id: u64) -> Result<Val, Error> {
        Self::require_init(&env)?;

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.status == ProposalStatus::Disputed {
            return Err(Error::ProposalDisputed);
        }

        if proposal.status == ProposalStatus::Executed {
            return Err(Error::ProposalAlreadyExecuted);
        }

        let current_time = env.ledger().timestamp();
        if current_time < proposal.execution_time {
            return Err(Error::ChallengeWindowActive);
        }

        // Execute the payload
        let result: Val = env.invoke_contract(&proposal.contract_id, &proposal.function, proposal.args.clone());

        proposal.status = ProposalStatus::Executed;
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("execute"), proposal_id),
            (proposal.contract_id, proposal.function),
        );

        Ok(result)
    }

    // ── Getters ───────────────────────────────────────────────────

    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<Proposal> {
        env.storage().persistent().get(&DataKey::Proposal(proposal_id))
    }

    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::ProposalCount).unwrap_or(0)
    }

    // ── Internal Helpers ──────────────────────────────────────────

    fn require_init(env: &Env) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::IsInitialized) {
            return Err(Error::NotInitialized);
        }
        Ok(())
    }
}
