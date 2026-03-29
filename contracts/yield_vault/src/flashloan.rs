//! # Flash Loan Module — Uncollateralized Instant Loans
//!
//! Allows developers to borrow vault liquidity within a single transaction,
//! charging a premium fee that accrues to depositors. The loan must be repaid
//! plus fee before the transaction completes, or the entire transaction reverts.

use crate::{DataKey, VaultError, YieldVault};
use soroban_sdk::{contractclient, symbol_short, token, Address, Bytes, Env};

/// Flash loan premium fee in basis points (9 bps = 0.09%)
pub const FLASH_LOAN_FEE_BPS: i128 = 9;

/// Basis points denominator
pub const BPS_DENOMINATOR: i128 = 10_000;

/// Standard interface that flash loan receivers must implement.
#[contractclient(name = "FlashLoanReceiverClient")]
#[allow(dead_code)]
pub trait FlashLoanReceiver {
    /// Execute arbitrary logic with borrowed funds.
    ///
    /// # Arguments
    /// * `initiator` — Address that initiated the flash loan
    /// * `token` — Token address that was borrowed
    /// * `amount` — Amount borrowed
    /// * `fee` — Fee that must be repaid
    /// * `params` — Arbitrary data passed from initiator
    ///
    /// # Returns
    /// Must return true to indicate successful execution
    fn execute_operation(
        env: Env,
        initiator: Address,
        token: Address,
        amount: i128,
        fee: i128,
        params: Bytes,
    ) -> bool;
}

impl YieldVault {
    /// Execute a flash loan.
    ///
    /// # Security Model
    /// 1. Record vault balance before loan
    /// 2. Transfer funds to receiver contract
    /// 3. Call receiver's execute_operation callback
    /// 4. Verify vault balance >= initial + fee
    /// 5. Revert entire transaction if validation fails
    ///
    /// # Arguments
    /// * `initiator` - Address initiating the flash loan (must authorize)
    /// * `receiver`  - Contract address that will receive and repay the loan
    /// * `amount`    - Amount to borrow
    /// * `params`    - Arbitrary data to pass to receiver
    ///
    /// # Returns
    /// The premium fee collected
    ///
    /// # Invariants
    /// balance_after >= balance_before + fee
    pub fn flash_loan_impl(
        env: &Env,
        initiator: &Address,
        receiver: &Address,
        amount: i128,
        params: &Bytes,
    ) -> Result<i128, VaultError> {
        Self::require_init(env)?;

        if amount <= 0 {
            return Err(VaultError::ZeroAmount);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = token::Client::new(env, &token_addr);
        let vault_addr = env.current_contract_address();

        // Step 1: Record balance before loan
        let balance_before = token_client.balance(&vault_addr);

        if balance_before < amount {
            return Err(VaultError::InsufficientShares); // Reusing error for insufficient funds
        }

        // Step 2: Calculate premium fee
        let fee = (amount * FLASH_LOAN_FEE_BPS) / BPS_DENOMINATOR;

        // Step 3: Optimistically transfer funds to receiver
        token_client.transfer(&vault_addr, receiver, &amount);

        // Step 4: Execute receiver's callback
        let receiver_client = FlashLoanReceiverClient::new(env, receiver);
        let success =
            receiver_client.execute_operation(initiator, &token_addr, &amount, &fee, params);

        if !success {
            return Err(VaultError::Unauthorized); // Receiver rejected the operation
        }

        // Step 5: Verify repayment (balance must be >= initial + fee)
        let balance_after = token_client.balance(&vault_addr);

        if balance_after < balance_before + fee {
            return Err(VaultError::InsufficientShares); // Repayment failed
        }

        // Step 6: Update vault accounting (fee increases total assets)
        let total_assets: i128 = env.storage().instance().get(&DataKey::TotalAssets).unwrap();
        env.storage()
            .instance()
            .set(&DataKey::TotalAssets, &(total_assets + fee));

        env.events().publish(
            (symbol_short!("flash"),),
            (initiator.clone(), receiver.clone(), amount, fee),
        );

        Ok(fee)
    }

    /// View function: calculate flash loan fee for a given amount.
    pub fn calc_flash_fee(amount: i128) -> i128 {
        if amount <= 0 {
            return 0;
        }
        (amount * FLASH_LOAN_FEE_BPS) / BPS_DENOMINATOR
    }

    /// View function: get maximum available flash loan amount.
    pub fn max_flash_amount(env: &Env) -> Result<i128, VaultError> {
        Self::require_init(env)?;

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = token::Client::new(env, &token_addr);
        let balance = token_client.balance(&env.current_contract_address());

        Ok(balance)
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{YieldVault, YieldVaultClient};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{contract, contractimpl, Bytes, Env};

    /// Mock flash loan receiver that repays the loan successfully.
    /// This receiver gets the vault address from storage and repays properly.
    #[contract]
    struct MockFlashReceiver;

    #[contractimpl]
    impl MockFlashReceiver {
        /// Store the vault address for later use
        pub fn set_vault(env: Env, vault: Address) {
            env.storage()
                .instance()
                .set(&soroban_sdk::symbol_short!("vault"), &vault);
        }

        pub fn execute_operation(
            env: Env,
            _initiator: Address,
            token: Address,
            amount: i128,
            fee: i128,
            _params: Bytes,
        ) -> bool {
            // Get vault address from storage
            let vault: Address = env
                .storage()
                .instance()
                .get(&soroban_sdk::symbol_short!("vault"))
                .unwrap();

            let receiver_addr = env.current_contract_address();
            let token_client = token::Client::new(&env, &token);

            // Repay loan + fee back to vault
            token_client.transfer(&receiver_addr, &vault, &(amount + fee));

            true
        }
    }

    fn setup_vault() -> (Env, YieldVaultClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let vault_id = env.register(YieldVault, ());
        let client = YieldVaultClient::new(&env, &vault_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();

        client.initialize(&admin, &token_addr);

        (env, client, admin, token_addr, token_admin)
    }

    fn mint_tokens(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
        let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    #[test]
    fn test_flash_loan_successful_repayment() {
        let (env, vault_client, _, token_addr, _token_admin) = setup_vault();

        // Setup: deposit funds into vault
        let depositor = Address::generate(&env);
        mint_tokens(&env, &token_addr, &depositor, 10_000);
        vault_client.deposit(&depositor, &10_000);

        // Register mock receiver and configure it with vault address
        let receiver_id = env.register(MockFlashReceiver, ());
        let receiver_client = MockFlashReceiverClient::new(&env, &receiver_id);
        receiver_client.set_vault(&vault_client.address);

        // Mint tokens to receiver so it can repay the fee (it gets the principal from the loan)
        mint_tokens(&env, &token_addr, &receiver_id, 10); // Extra for fee payment

        let initiator = Address::generate(&env);
        let params = Bytes::new(&env);

        // Execute flash loan
        let fee = vault_client.flash_loan(&initiator, &receiver_id, &5_000, &params);

        // Verify fee was collected (5000 * 0.09% = 4.5 ≈ 4)
        assert!(fee > 0);
        assert_eq!(fee, 4); // (5000 * 9) / 10000 = 4

        // Verify vault assets increased by fee
        assert_eq!(vault_client.total_assets(), 10_004);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_flash_loan_zero_amount_fails() {
        let (_env, vault_client, _, _, _) = setup_vault();

        let receiver = Address::generate(&_env);
        let initiator = Address::generate(&_env);
        let params = Bytes::new(&_env);

        vault_client.flash_loan(&initiator, &receiver, &0, &params);
    }

    #[test]
    fn test_get_flash_loan_fee() {
        let (_env, vault_client, _, _, _) = setup_vault();

        let fee = vault_client.get_flash_loan_fee(&10_000);
        assert_eq!(fee, 9); // (10000 * 9) / 10000 = 9
    }

    #[test]
    fn test_get_max_flash_loan() {
        let (env, vault_client, _, token_addr, _token_admin) = setup_vault();

        let depositor = Address::generate(&env);
        mint_tokens(&env, &token_addr, &depositor, 50_000);
        vault_client.deposit(&depositor, &50_000);

        let max_loan = vault_client.get_max_flash_loan();
        assert_eq!(max_loan, 50_000);
    }
}
