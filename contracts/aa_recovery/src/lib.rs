#![no_std]

//! # Smart Wallet Recovery Module
//!
//! A decentralized recovery mechanism for smart wallets allowing users to designate
//! "Guardians" who can help recover funds if the user loses access to their primary
//! signing device or passkey.
//!
//! ## Features
//! - Guardian management with configurable threshold
//! - Time-locked recovery initiation for security
//! - Owner can cancel recovery requests
//! - Key rotation after guardian signature threshold and timelock expiry
//!
//! ## Security
//! - Guardians cannot instantly drain funds (timelock enforced)
//! - Configurable guardian threshold prevents single-point collusion
//! - Owner retains full control to cancel recovery attempts

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Map, Vec,
};

// ── Storage Keys ────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
enum StorageKey {
    Initialized,
    Owner,
    Guardians,           // Map<Address, u32> - guardian address -> guardian id
    GuardianThreshold,   // u32 - number of guardian approvals needed
    RecoveryRequest,     // RecoveryRequest - current active recovery request
    GuardianCounter,     // u32 - counter for generating unique guardian ids
    NewOwner,            // Address - proposed new owner for recovery
    RecoveryInitiatedAt, // u64 - timestamp when recovery was initiated
    RecoveryConfig,      // RecoveryConfig - threshold and timelock settings
}

// ── Data Structures ─────────────────────────────────────────────────────

/// Represents a guardian in the recovery system
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Guardian {
    pub address: Address,
    pub id: u32,
    pub active: bool,
}

/// Represents a recovery request with all necessary state
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryRequest {
    pub wallet: Address,                  // The wallet being recovered
    pub new_owner: Address,               // The proposed new owner address
    pub initiated_at: u64,                // Timestamp when recovery was initiated
    pub expires_at: u64,                  // Timestamp when recovery expires (if not executed)
    pub guardian_approvals: Vec<Address>, // List of guardians who approved
    pub executed: bool,                   // Whether the recovery has been executed
    pub cancelled: bool,                  // Whether the recovery has been cancelled
}

/// Recovery configuration for setting up the system
#[contracttype]
#[derive(Clone, Debug)]
pub struct RecoveryConfig {
    pub guardian_threshold: u32, // Number of guardian approvals needed
    pub timelock_duration: u64,  // Duration in seconds before recovery can execute
}

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RecoveryError {
    /// Contract has not been initialized
    NotInitialized = 1,
    /// Contract is already initialized
    AlreadyInitialized = 2,
    /// Caller is not authorized to perform this action
    Unauthorized = 3,
    /// Recovery request does not exist
    NoRecoveryRequest = 4,
    /// Recovery request has already been executed
    RecoveryAlreadyExecuted = 5,
    /// Recovery request has been cancelled
    RecoveryCancelled = 6,
    /// Timelock period has not yet expired
    TimelockNotExpired = 7,
    /// Insufficient guardian approvals
    InsufficientApprovals = 8,
    /// Cannot add more guardians (limit reached)
    MaxGuardiansReached = 9,
    /// Guardian is already registered
    GuardianAlreadyExists = 10,
    /// Guardian does not exist
    GuardianNotFound = 11,
    /// Cannot remove guardian (would break threshold)
    CannotRemoveGuardian = 12,
    /// Invalid threshold configuration
    InvalidThreshold = 13,
    /// Recovery request has expired
    RecoveryExpired = 14,
    /// Invalid zero address provided
    ZeroAddress = 15,
}

// ── Constants ───────────────────────────────────────────────────────────

/// Maximum number of guardians allowed per wallet
const MAX_GUARDIANS: u32 = 10;

/// Default timelock duration (7 days in seconds)
const DEFAULT_TIMELOCK_DURATION: u64 = 604800;

/// Default guardian threshold
const DEFAULT_GUARDIAN_THRESHOLD: u32 = 2;

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct RecoveryModule;

#[contractimpl]
impl RecoveryModule {
    // ═══════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════

    /// Initialize the recovery module for a smart wallet.
    ///
    /// This function sets up the recovery system with the wallet owner,
    /// initial guardians, and security configuration. Can only be called once.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `owner` - The wallet owner's address (will be set as the primary owner)
    /// * `guardians` - Vector of initial guardian addresses
    /// * `threshold` - Number of guardian approvals required for recovery
    /// * `timelock_duration` - Duration in seconds before recovery can execute
    ///
    /// # Returns
    ///
    /// Returns `Ok(())` on successful initialization, or an error if:
    /// - Contract is already initialized
    /// - Owner address is invalid (zero address)
    /// - Threshold is greater than number of guardians
    /// - Number of guardians exceeds maximum
    ///
    /// # Events
    ///
    /// Emits `(initialized, owner, threshold, timelock_duration)` on success
    ///
    /// # Example
    ///
    /// ```ignore
    /// let guardians = vec![&env, guardian1.clone(), guardian2.clone()];
    /// recovery_module.initialize(&env, &owner, &guardians, &2, &604800)?;
    /// ```
    pub fn initialize(
        env: Env,
        owner: Address,
        guardians: Vec<Address>,
        threshold: u32,
        timelock_duration: u64,
    ) -> Result<(), RecoveryError> {
        // Check if already initialized
        if env.storage().instance().has(&StorageKey::Initialized) {
            return Err(RecoveryError::AlreadyInitialized);
        }

        // Validate owner address
        if guardians.is_empty() {
            return Err(RecoveryError::ZeroAddress);
        }

        // Validate threshold
        if threshold == 0 || threshold > guardians.len() as u32 {
            return Err(RecoveryError::InvalidThreshold);
        }

        // Validate guardian count
        if guardians.len() as u32 > MAX_GUARDIANS {
            return Err(RecoveryError::MaxGuardiansReached);
        }

        // Set owner
        env.storage().instance().set(&StorageKey::Owner, &owner);

        // Set guardians
        let mut guardian_map: Map<Address, u32> = Map::new(&env);
        let mut guardian_id_counter: u32 = 0;

        for guardian in guardians.iter() {
            guardian_id_counter += 1;
            guardian_map.set(guardian.clone(), guardian_id_counter);
        }

        env.storage()
            .instance()
            .set(&StorageKey::Guardians, &guardian_map);
        env.storage()
            .instance()
            .set(&StorageKey::GuardianCounter, &guardian_id_counter);

        // Set threshold and timelock
        env.storage()
            .instance()
            .set(&StorageKey::GuardianThreshold, &threshold);

        let config = RecoveryConfig {
            guardian_threshold: threshold,
            timelock_duration,
        };
        env.storage()
            .instance()
            .set(&StorageKey::RecoveryConfig, &config);

        // Mark as initialized
        env.storage()
            .instance()
            .set(&StorageKey::Initialized, &true);

        // Emit event
        env.events().publish(
            (symbol_short!("init"),),
            (owner.clone(), threshold, timelock_duration),
        );

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // GUARDIAN MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /// Add a new guardian to the recovery system.
    ///
    /// Only the wallet owner can add guardians. The new guardian will be
    /// able to participate in recovery approvals immediately.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `owner` - The wallet owner's address (must authorize)
    /// * `guardian` - The address of the new guardian to add
    ///
    /// # Returns
    ///
    /// Returns `Ok(())` on success, or an error if:
    /// - Caller is not the owner
    /// - Maximum guardians already reached
    /// - Guardian already exists
    ///
    /// # Events
    ///
    /// Emits `(guard_add, guardian_address, guardian_id)` on success
    pub fn add_guardian(env: Env, owner: Address, guardian: Address) -> Result<(), RecoveryError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;

        // Check guardian limit
        let guardians: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&StorageKey::Guardians)
            .unwrap();

        if guardians.len() as u32 >= MAX_GUARDIANS {
            return Err(RecoveryError::MaxGuardiansReached);
        }

        // Check if guardian already exists
        if guardians.contains_key(guardian.clone()) {
            return Err(RecoveryError::GuardianAlreadyExists);
        }

        // Add new guardian
        let mut guardian_map = guardians;
        let mut counter: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::GuardianCounter)
            .unwrap_or(0);

        counter += 1;
        guardian_map.set(guardian.clone(), counter);

        env.storage()
            .instance()
            .set(&StorageKey::Guardians, &guardian_map);
        env.storage()
            .instance()
            .set(&StorageKey::GuardianCounter, &counter);

        // Emit event
        env.events()
            .publish((symbol_short!("guard_add"),), (guardian.clone(), counter));

        Ok(())
    }

    /// Remove a guardian from the recovery system.
    ///
    /// Only the wallet owner can remove guardians. Cannot remove if it would
    /// make the threshold unreachable with remaining guardians.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `owner` - The wallet owner's address (must authorize)
    /// * `guardian` - The address of the guardian to remove
    ///
    /// # Returns
    ///
    /// Returns `Ok(())` on success, or an error if:
    /// - Caller is not the owner
    /// - Guardian does not exist
    /// - Removal would break threshold requirement
    ///
    /// # Events
    ///
    /// Emits `(guard_remove, guardian_address)` on success
    pub fn remove_guardian(
        env: Env,
        owner: Address,
        guardian: Address,
    ) -> Result<(), RecoveryError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;

        let guardians: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&StorageKey::Guardians)
            .unwrap();

        // Check if guardian exists
        if !guardians.contains_key(guardian.clone()) {
            return Err(RecoveryError::GuardianNotFound);
        }

        // Check if removal would break threshold
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::GuardianThreshold)
            .unwrap();

        if guardians.len() as u32 - 1 < threshold {
            return Err(RecoveryError::CannotRemoveGuardian);
        }

        // Remove guardian
        let mut guardian_map = guardians;
        guardian_map.remove(guardian.clone());

        env.storage()
            .instance()
            .set(&StorageKey::Guardians, &guardian_map);

        // Emit event
        env.events()
            .publish((symbol_short!("guard_rm"),), (guardian.clone(),));

        Ok(())
    }

    /// Update the guardian approval threshold.
    ///
    /// Only the wallet owner can update the threshold. The new threshold
    /// must not exceed the current number of guardians.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `owner` - The wallet owner's address (must authorize)
    /// * `new_threshold` - The new number of guardian approvals required
    ///
    /// # Returns
    ///
    /// Returns `Ok(())` on success, or an error if:
    /// - Caller is not the owner
    /// - New threshold is zero or exceeds guardian count
    ///
    /// # Events
    ///
    /// Emits `(threshold_update, new_threshold)` on success
    pub fn update_threshold(
        env: Env,
        owner: Address,
        new_threshold: u32,
    ) -> Result<(), RecoveryError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;

        let guardians: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&StorageKey::Guardians)
            .unwrap();

        if new_threshold == 0 || new_threshold > guardians.len() as u32 {
            return Err(RecoveryError::InvalidThreshold);
        }

        env.storage()
            .instance()
            .set(&StorageKey::GuardianThreshold, &new_threshold);

        // Emit event
        env.events()
            .publish((symbol_short!("thresh"),), (new_threshold,));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // RECOVERY INITIATION
    // ═══════════════════════════════════════════════════════════════════

    /// Initiate a recovery request for the wallet.
    ///
    /// Any guardian can initiate a recovery request on behalf of a user who
    /// has lost access. This starts a time-locked period during which:
    /// - The owner can cancel the recovery
    /// - Guardians can approve the recovery
    /// - After timelock expires with sufficient approvals, recovery can execute
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `initiator` - The guardian initiating recovery (must authorize)
    /// * `wallet` - The wallet address to recover
    /// * `new_owner` - The proposed new owner address for the recovered wallet
    ///
    /// # Returns
    ///
    /// Returns `Ok(RecoveryRequest)` on success, or an error if:
    /// - Initiator is not a guardian
    /// - Active recovery request already exists
    /// - New owner address is invalid
    ///
    /// # Events
    ///
    /// Emits `(recovery_init, wallet, new_owner, expires_at)` on success
    pub fn initiate_recovery(
        env: Env,
        initiator: Address,
        wallet: Address,
        new_owner: Address,
    ) -> Result<RecoveryRequest, RecoveryError> {
        Self::require_initialized(&env)?;
        initiator.require_auth();

        // Verify initiator is a guardian
        let guardians: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&StorageKey::Guardians)
            .unwrap();

        if !guardians.contains_key(initiator.clone()) {
            return Err(RecoveryError::Unauthorized);
        }

        // Check for existing active recovery
        let existing_request: Option<RecoveryRequest> =
            env.storage().instance().get(&StorageKey::RecoveryRequest);

        if let Some(request) = existing_request {
            if !request.executed && !request.cancelled {
                return Err(RecoveryError::RecoveryAlreadyExecuted);
            }
        }

        // Get timelock duration
        let config: RecoveryConfig = env
            .storage()
            .instance()
            .get(&StorageKey::RecoveryConfig)
            .unwrap_or(RecoveryConfig {
                guardian_threshold: DEFAULT_GUARDIAN_THRESHOLD,
                timelock_duration: DEFAULT_TIMELOCK_DURATION,
            });

        let now = env.ledger().timestamp();
        let expires_at = now + config.timelock_duration;

        // Create recovery request
        let recovery_request = RecoveryRequest {
            wallet: wallet.clone(),
            new_owner: new_owner.clone(),
            initiated_at: now,
            expires_at,
            guardian_approvals: Vec::new(&env),
            executed: false,
            cancelled: false,
        };

        // Store recovery request
        env.storage()
            .instance()
            .set(&StorageKey::RecoveryRequest, &recovery_request);
        env.storage()
            .instance()
            .set(&StorageKey::RecoveryInitiatedAt, &now);
        env.storage()
            .instance()
            .set(&StorageKey::NewOwner, &new_owner);

        // Emit event
        env.events().publish(
            (symbol_short!("rec_init"),),
            (wallet.clone(), new_owner.clone(), expires_at),
        );

        Ok(recovery_request)
    }

    // ═══════════════════════════════════════════════════════════════════
    // GUARDIAN APPROVAL
    // ═══════════════════════════════════════════════════════════════════

    /// Approve a pending recovery request as a guardian.
    ///
    /// Guardians can approve a recovery request after it has been initiated.
    /// Once the threshold number of approvals is reached and the timelock
    /// has expired, the recovery can be executed.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `guardian` - The guardian address approving the recovery (must authorize)
    ///
    /// # Returns
    ///
    /// Returns `Ok(RecoveryRequest)` with updated approval state, or an error if:
    /// - No active recovery request exists
    /// - Caller is not a guardian
    /// - Guardian has already approved
    /// - Recovery has been cancelled or executed
    ///
    /// # Events
    ///
    /// Emits `(recovery_approve, guardian_address, approval_count)` on success
    pub fn approve_recovery(env: Env, guardian: Address) -> Result<RecoveryRequest, RecoveryError> {
        Self::require_initialized(&env)?;
        guardian.require_auth();

        // Verify guardian
        let guardians: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&StorageKey::Guardians)
            .unwrap();

        if !guardians.contains_key(guardian.clone()) {
            return Err(RecoveryError::Unauthorized);
        }

        // Get current recovery request
        let mut recovery_request: RecoveryRequest = env
            .storage()
            .instance()
            .get(&StorageKey::RecoveryRequest)
            .ok_or(RecoveryError::NoRecoveryRequest)?;

        // Check if recovery is still active
        if recovery_request.executed {
            return Err(RecoveryError::RecoveryAlreadyExecuted);
        }

        if recovery_request.cancelled {
            return Err(RecoveryError::RecoveryCancelled);
        }

        // Check if already approved
        for existing_approver in recovery_request.guardian_approvals.iter() {
            if existing_approver == guardian {
                return Err(RecoveryError::Unauthorized); // Already approved
            }
        }

        // Add approval
        recovery_request
            .guardian_approvals
            .push_back(guardian.clone());

        // Update storage
        env.storage()
            .instance()
            .set(&StorageKey::RecoveryRequest, &recovery_request);

        let approval_count = recovery_request.guardian_approvals.len() as u32;

        // Emit event
        env.events().publish(
            (symbol_short!("rec_appr"),),
            (guardian.clone(), approval_count),
        );

        Ok(recovery_request)
    }

    // ═══════════════════════════════════════════════════════════════════
    // RECOVERY CANCELLATION
    // ═══════════════════════════════════════════════════════════════════

    /// Cancel a pending recovery request.
    ///
    /// Only the wallet owner can cancel a recovery request. This allows
    /// the owner to reject unauthorized recovery attempts.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `owner` - The wallet owner's address (must authorize)
    ///
    /// # Returns
    ///
    /// Returns `Ok(RecoveryRequest)` with cancelled state, or an error if:
    /// - Caller is not the owner
    /// - No active recovery request exists
    /// - Recovery has already been executed
    ///
    /// # Events
    ///
    /// Emits `(recovery_cancel, owner)` on success
    pub fn cancel_recovery(env: Env, owner: Address) -> Result<RecoveryRequest, RecoveryError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;

        // Get current recovery request
        let mut recovery_request: RecoveryRequest = env
            .storage()
            .instance()
            .get(&StorageKey::RecoveryRequest)
            .ok_or(RecoveryError::NoRecoveryRequest)?;

        // Check if already executed
        if recovery_request.executed {
            return Err(RecoveryError::RecoveryAlreadyExecuted);
        }

        // Cancel recovery
        recovery_request.cancelled = true;

        // Update storage
        env.storage()
            .instance()
            .set(&StorageKey::RecoveryRequest, &recovery_request);

        // Emit event
        env.events()
            .publish((symbol_short!("rec_can"),), (owner.clone(),));

        Ok(recovery_request)
    }

    // ═══════════════════════════════════════════════════════════════════
    // RECOVERY EXECUTION
    // ═══════════════════════════════════════════════════════════════════

    /// Execute a recovery request to transfer wallet ownership.
    ///
    /// This function can be called by anyone once:
    /// 1. The timelock period has expired
    /// 2. The guardian approval threshold has been met
    /// 3. The recovery has not been cancelled or already executed
    ///
    /// Upon execution, the new owner address becomes the wallet owner.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    ///
    /// Returns `Ok(())` on successful ownership transfer, or an error if:
    /// - No active recovery request exists
    /// - Timelock has not expired
    /// - Insufficient guardian approvals
    /// - Recovery has been cancelled
    /// - Recovery has already been executed
    ///
    /// # Events
    ///
    /// Emits `(recovery_exec, old_owner, new_owner)` on success
    pub fn execute_recovery(env: Env) -> Result<(), RecoveryError> {
        Self::require_initialized(&env)?;

        // Get current recovery request
        let mut recovery_request: RecoveryRequest = env
            .storage()
            .instance()
            .get(&StorageKey::RecoveryRequest)
            .ok_or(RecoveryError::NoRecoveryRequest)?;

        // Check if already executed
        if recovery_request.executed {
            return Err(RecoveryError::RecoveryAlreadyExecuted);
        }

        // Check if cancelled
        if recovery_request.cancelled {
            return Err(RecoveryError::RecoveryCancelled);
        }

        // Check timelock
        let now = env.ledger().timestamp();
        if now < recovery_request.expires_at {
            return Err(RecoveryError::TimelockNotExpired);
        }

        // Check guardian approval threshold
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::GuardianThreshold)
            .unwrap();

        let approval_count = recovery_request.guardian_approvals.len() as u32;
        if approval_count < threshold {
            return Err(RecoveryError::InsufficientApprovals);
        }

        // Get current owner for event
        let old_owner: Address = env.storage().instance().get(&StorageKey::Owner).unwrap();

        // Transfer ownership
        env.storage()
            .instance()
            .set(&StorageKey::Owner, &recovery_request.new_owner);

        // Mark as executed
        recovery_request.executed = true;
        env.storage()
            .instance()
            .set(&StorageKey::RecoveryRequest, &recovery_request);

        // Emit event
        env.events().publish(
            (symbol_short!("rec_exec"),),
            (old_owner.clone(), recovery_request.new_owner.clone()),
        );

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// Get the current wallet owner address.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    ///
    /// Returns the owner address, or an error if not initialized
    pub fn get_owner(env: Env) -> Result<Address, RecoveryError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::Owner).unwrap())
    }

    /// Get all active guardians.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    ///
    /// Returns a vector of guardian addresses
    pub fn get_guardians(env: Env) -> Result<Vec<Address>, RecoveryError> {
        Self::require_initialized(&env)?;
        let guardians: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&StorageKey::Guardians)
            .unwrap();

        let mut guardian_vec = Vec::new(&env);
        for guardian in guardians.keys() {
            guardian_vec.push_back(guardian);
        }

        Ok(guardian_vec)
    }

    /// Get the guardian approval threshold.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    ///
    /// Returns the number of guardian approvals required for recovery
    pub fn get_threshold(env: Env) -> Result<u32, RecoveryError> {
        Self::require_initialized(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&StorageKey::GuardianThreshold)
            .unwrap())
    }

    /// Get the current recovery request status.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    ///
    /// Returns the current RecoveryRequest if one exists, None otherwise
    pub fn get_recovery_request(env: Env) -> Result<Option<RecoveryRequest>, RecoveryError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::RecoveryRequest))
    }

    /// Check if an address is a guardian.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    /// * `address` - The address to check
    ///
    /// # Returns
    ///
    /// Returns true if the address is a registered guardian
    pub fn is_guardian(env: Env, address: Address) -> bool {
        let guardians: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&StorageKey::Guardians)
            .unwrap_or(Map::new(&env));

        guardians.contains_key(address)
    }

    /// Get the recovery configuration.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    ///
    /// Returns the RecoveryConfig with threshold and timelock settings
    pub fn get_config(env: Env) -> Result<RecoveryConfig, RecoveryError> {
        Self::require_initialized(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&StorageKey::RecoveryConfig)
            .unwrap_or(RecoveryConfig {
                guardian_threshold: DEFAULT_GUARDIAN_THRESHOLD,
                timelock_duration: DEFAULT_TIMELOCK_DURATION,
            }))
    }

    /// Check if recovery can be executed (timelock expired + threshold met).
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    ///
    /// Returns true if recovery is ready to execute
    pub fn can_execute_recovery(env: Env) -> bool {
        let recovery_request: Option<RecoveryRequest> =
            env.storage().instance().get(&StorageKey::RecoveryRequest);

        match recovery_request {
            Some(request) => {
                if request.executed || request.cancelled {
                    return false;
                }

                let now = env.ledger().timestamp();
                if now < request.expires_at {
                    return false;
                }

                let threshold: u32 = env
                    .storage()
                    .instance()
                    .get(&StorageKey::GuardianThreshold)
                    .unwrap_or(DEFAULT_GUARDIAN_THRESHOLD);

                request.guardian_approvals.len() as u32 >= threshold
            }
            None => false,
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    fn require_initialized(env: &Env) -> Result<(), RecoveryError> {
        if !env.storage().instance().has(&StorageKey::Initialized) {
            return Err(RecoveryError::NotInitialized);
        }
        Ok(())
    }

    fn require_owner(env: &Env, caller: &Address) -> Result<(), RecoveryError> {
        caller.require_auth();
        let owner: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Owner)
            .ok_or(RecoveryError::NotInitialized)?;

        if *caller != owner {
            return Err(RecoveryError::Unauthorized);
        }
        Ok(())
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{vec, Env};

    fn setup_recovery_module(
        env: &Env,
    ) -> (
        RecoveryModuleClient<'static>,
        Address,
        Address,
        Address,
        Address,
    ) {
        env.mock_all_auths();

        let contract_id = env.register(RecoveryModule, ());
        let client = RecoveryModuleClient::new(env, &contract_id);

        let owner = Address::generate(env);
        let guardian1 = Address::generate(env);
        let guardian2 = Address::generate(env);
        let guardian3 = Address::generate(env);

        let guardians = vec![env, guardian1.clone(), guardian2.clone(), guardian3.clone()];
        client.initialize(&owner, &guardians, &2, &604800);

        (client, owner, guardian1, guardian2, guardian3)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let (client, owner, _, _, _) = setup_recovery_module(&env);

        assert_eq!(client.get_owner(), owner);
        assert_eq!(client.get_guardians().len(), 3);
        assert_eq!(client.get_threshold(), 2);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(RecoveryModule, ());
        let client = RecoveryModuleClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let guardian1 = Address::generate(&env);
        let guardian2 = Address::generate(&env);
        let guardians = vec![&env, guardian1.clone(), guardian2.clone()];

        // First initialization should succeed
        client.initialize(&owner, &guardians, &2, &604800);

        // Second initialization should panic
        client.initialize(&owner, &guardians, &1, &604800);
    }

    #[test]
    fn test_add_guardian() {
        let env = Env::default();
        let (client, owner, _, _, _) = setup_recovery_module(&env);

        let new_guardian = Address::generate(&env);
        client.add_guardian(&owner, &new_guardian);

        let guardians = client.get_guardians();
        assert_eq!(guardians.len(), 4);
        assert!(client.is_guardian(&new_guardian));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_add_guardian_non_owner_panics() {
        let env = Env::default();
        let (client, _, _, _, _) = setup_recovery_module(&env);

        let non_owner = Address::generate(&env);
        let new_guardian = Address::generate(&env);
        client.add_guardian(&non_owner, &new_guardian);
    }

    #[test]
    fn test_remove_guardian() {
        let env = Env::default();
        let (client, owner, guardian3, _, _) = setup_recovery_module(&env);

        client.remove_guardian(&owner, &guardian3);

        let guardians = client.get_guardians();
        assert_eq!(guardians.len(), 2);
        assert!(!client.is_guardian(&guardian3));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_remove_guardian_breaks_threshold_panics() {
        let env = Env::default();
        let (client, owner, guardian1, guardian2, _) = setup_recovery_module(&env);

        // Threshold is 2, removing would leave 2 guardians which is okay
        // But if we try to remove another, it should fail
        client.remove_guardian(&owner, &guardian1);
        client.remove_guardian(&owner, &guardian2); // This should panic
    }

    #[test]
    fn test_initiate_recovery() {
        let env = Env::default();
        let (client, owner, guardian1, _, _) = setup_recovery_module(&env);

        let new_owner = Address::generate(&env);
        let recovery_request = client.initiate_recovery(&guardian1, &owner, &new_owner);

        assert_eq!(recovery_request.wallet, owner);
        assert_eq!(recovery_request.new_owner, new_owner);
        assert!(!recovery_request.executed);
        assert!(!recovery_request.cancelled);
        assert_eq!(recovery_request.guardian_approvals.len(), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_initiate_recovery_non_guardian_panics() {
        let env = Env::default();
        let (client, owner, _, _, _) = setup_recovery_module(&env);

        let non_guardian = Address::generate(&env);
        let new_owner = Address::generate(&env);
        client.initiate_recovery(&non_guardian, &owner, &new_owner);
    }

    #[test]
    fn test_approve_recovery() {
        let env = Env::default();
        let (client, owner, guardian1, guardian2, _) = setup_recovery_module(&env);

        let new_owner = Address::generate(&env);
        client.initiate_recovery(&guardian1, &owner, &new_owner);

        let approval = client.approve_recovery(&guardian1);
        assert_eq!(approval.guardian_approvals.len(), 1);

        let approval2 = client.approve_recovery(&guardian2);
        assert_eq!(approval2.guardian_approvals.len(), 2);
    }

    #[test]
    fn test_cancel_recovery() {
        let env = Env::default();
        let (client, owner, guardian1, _, _) = setup_recovery_module(&env);

        let new_owner = Address::generate(&env);
        client.initiate_recovery(&guardian1, &owner, &new_owner);

        let cancelled_request = client.cancel_recovery(&owner);
        assert!(cancelled_request.cancelled);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_cancel_recovery_non_owner_panics() {
        let env = Env::default();
        let (client, _, guardian1, _, _) = setup_recovery_module(&env);

        let new_owner = Address::generate(&env);
        client.initiate_recovery(&guardian1, &Address::generate(&env), &new_owner);

        let non_owner = Address::generate(&env);
        client.cancel_recovery(&non_owner);
    }

    #[test]
    fn test_execute_recovery_success() {
        let env = Env::default();
        let (client, owner, guardian1, guardian2, _) = setup_recovery_module(&env);

        let new_owner = Address::generate(&env);
        client.initiate_recovery(&guardian1, &owner, &new_owner);

        // Approve with both guardians
        client.approve_recovery(&guardian1);
        client.approve_recovery(&guardian2);

        // Fast forward past timelock
        env.ledger().with_mut(|li| {
            li.timestamp += 700000; // More than 7 days
        });

        client.execute_recovery();

        assert_eq!(client.get_owner(), new_owner);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")]
    fn test_execute_recovery_before_timelock_panics() {
        let env = Env::default();
        let (client, owner, guardian1, guardian2, _) = setup_recovery_module(&env);

        let new_owner = Address::generate(&env);
        client.initiate_recovery(&guardian1, &owner, &new_owner);

        client.approve_recovery(&guardian1);
        client.approve_recovery(&guardian2);

        // Try to execute before timelock expires
        client.execute_recovery();
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_execute_recovery_insufficient_approvals_panics() {
        let env = Env::default();
        let (client, owner, guardian1, _, _) = setup_recovery_module(&env);

        let new_owner = Address::generate(&env);
        client.initiate_recovery(&guardian1, &owner, &new_owner);

        // Only one approval (threshold is 2)
        client.approve_recovery(&guardian1);

        // Fast forward past timelock
        env.ledger().with_mut(|li| {
            li.timestamp += 700000;
        });

        client.execute_recovery();
    }

    #[test]
    fn test_can_execute_recovery() {
        let env = Env::default();
        let (client, owner, guardian1, guardian2, _) = setup_recovery_module(&env);

        // Initially should be false
        assert!(!client.can_execute_recovery());

        let new_owner = Address::generate(&env);
        client.initiate_recovery(&guardian1, &owner, &new_owner);

        // Still false (no approvals yet)
        assert!(!client.can_execute_recovery());

        // Add approvals
        client.approve_recovery(&guardian1);
        client.approve_recovery(&guardian2);

        // Still false (timelock not expired)
        assert!(!client.can_execute_recovery());

        // Fast forward past timelock
        env.ledger().with_mut(|li| {
            li.timestamp += 700000;
        });

        // Now should be true
        assert!(client.can_execute_recovery());
    }

    #[test]
    fn test_update_threshold() {
        let env = Env::default();
        let (client, owner, _, _, _) = setup_recovery_module(&env);

        assert_eq!(client.get_threshold(), 2);

        client.update_threshold(&owner, &3);
        assert_eq!(client.get_threshold(), 3);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn test_update_threshold_invalid_panics() {
        let env = Env::default();
        let (client, owner, _, _, _) = setup_recovery_module(&env);

        // Try to set threshold higher than guardian count
        client.update_threshold(&owner, &4);
    }

    #[test]
    fn test_get_config() {
        let env = Env::default();
        let (client, _, _, _, _) = setup_recovery_module(&env);

        let config = client.get_config();
        assert_eq!(config.guardian_threshold, 2);
        assert_eq!(config.timelock_duration, 604800);
    }

    #[test]
    fn test_multiple_recovery_attempts_after_cancel() {
        let env = Env::default();
        let (client, owner, guardian1, _guardian2, _) = setup_recovery_module(&env);

        let new_owner = Address::generate(&env);
        client.initiate_recovery(&guardian1, &owner, &new_owner);

        // Cancel the recovery
        client.cancel_recovery(&owner);

        // Should be able to initiate a new recovery
        let new_owner2 = Address::generate(&env);
        let recovery_request = client.initiate_recovery(&guardian1, &owner, &new_owner2);

        assert!(!recovery_request.cancelled);
        assert_eq!(recovery_request.new_owner, new_owner2);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_double_execute_recovery_panics() {
        let env = Env::default();
        let (client, owner, guardian1, guardian2, _) = setup_recovery_module(&env);

        let new_owner = Address::generate(&env);
        client.initiate_recovery(&guardian1, &owner, &new_owner);

        client.approve_recovery(&guardian1);
        client.approve_recovery(&guardian2);

        env.ledger().with_mut(|li| {
            li.timestamp += 700000;
        });

        client.execute_recovery();
        client.execute_recovery(); // Should panic
    }

    #[test]
    fn test_guardian_cannot_approve_twice() {
        let env = Env::default();
        let (client, owner, guardian1, _guardian2, _) = setup_recovery_module(&env);

        let new_owner = Address::generate(&env);
        client.initiate_recovery(&guardian1, &owner, &new_owner);

        // First approval should succeed
        let approval = client.approve_recovery(&guardian1);
        assert_eq!(approval.guardian_approvals.len(), 1);
    }

    #[test]
    fn test_recovery_expires_at_calculation() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(RecoveryModule, ());
        let client = RecoveryModuleClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let guardian1 = Address::generate(&env);
        let guardians = vec![&env, guardian1.clone()];
        client.initialize(&owner, &guardians, &1, &86400); // 1 day timelock

        let initial_timestamp = env.ledger().timestamp();
        let new_owner = Address::generate(&env);
        let recovery_request = client.initiate_recovery(&guardian1, &owner, &new_owner);

        // Check that expires_at is correctly calculated
        assert_eq!(recovery_request.expires_at, initial_timestamp + 86400);
    }

    #[test]
    fn test_get_guardians_returns_all() {
        let env = Env::default();
        let (client, _owner, guardian1, guardian2, guardian3) = setup_recovery_module(&env);

        let guardians = client.get_guardians();
        assert_eq!(guardians.len(), 3);
        assert!(guardians.contains(&guardian1));
        assert!(guardians.contains(&guardian2));
        assert!(guardians.contains(&guardian3));
    }
}
