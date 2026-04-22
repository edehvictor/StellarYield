# Smart Wallet Recovery Module

A decentralized recovery mechanism for Soroban smart wallets allowing users to designate "Guardians" who can help recover funds if the user loses access to their primary signing device or passkey.

## 🎯 Features

- **Guardian Management**: Wallet owners can add/remove trusted guardians (up to 10)
- **Configurable Threshold**: Set the number of guardian approvals required for recovery
- **Time-Locked Recovery**: Security delay prevents instant fund drainage
- **Owner Cancellation**: Wallet owners can cancel unauthorized recovery attempts
- **Key Rotation**: Automatic ownership transfer after threshold + timelock expiry

## 🛠 Technical Details

- **Stack**: Rust, Soroban SDK
- **Location**: `/contracts/aa_recovery/`
- **Security**: Critical - Guardians cannot collude to instantly drain funds

## 📋 Quick Start

### Initialization

```rust
// Initialize the recovery module with 3 guardians and a threshold of 2
let guardians = vec![&env, guardian1, guardian2, guardian3];
client.initialize(&owner, &guardians, &2, &604800); // 7-day timelock
```

### Adding a Guardian

```rust
// Only the wallet owner can add guardians
client.add_guardian(&owner, &new_guardian);
```

### Initiating Recovery

```rust
// Any guardian can initiate recovery on behalf of a user who lost access
let recovery_request = client.initiate_recovery(&guardian, &wallet, &new_owner);
```

### Approving Recovery

```rust
// Guardians approve the recovery request
client.approve_recovery(&guardian1);
client.approve_recovery(&guardian2);
```

### Executing Recovery

```rust
// After timelock expires and threshold is met, anyone can execute
client.execute_recovery();
```

### Cancelling Recovery

```rust
// The wallet owner can cancel any pending recovery
client.cancel_recovery(&owner);
```

## 🔒 Security Model

### Guardian Threshold
- Configurable threshold (1 to number of guardians)
- Prevents single-point collusion
- Default recommendation: 2 out of 3 guardians

### Time-Lock
- Default duration: 7 days (604,800 seconds)
- Configurable during initialization
- Provides window for owner to cancel unauthorized attempts

### Owner Controls
- Owner can add/remove guardians at any time
- Owner can update the threshold
- Owner can cancel any pending recovery request

## 📊 Storage Structure

```rust
enum StorageKey {
    Initialized,
    Owner,
    Guardians,              // Map<Address, u32>
    GuardianThreshold,      // u32
    RecoveryRequest,        // RecoveryRequest struct
    GuardianCounter,        // u32
    NewOwner,               // Address
    RecoveryInitiatedAt,    // u64
    RecoveryConfig,         // RecoveryConfig struct
}
```

## 🧪 Testing

Run tests with:

```bash
cd contracts
cargo test -p aa_recovery
```

### Test Coverage

The module includes 23 comprehensive tests covering:
- Initialization and validation
- Guardian management (add/remove/update threshold)
- Recovery initiation and approval flow
- Timelock enforcement
- Cancellation mechanics
- Execution conditions
- Edge cases and error handling

## 📜 API Reference

### Initialization

#### `initialize(env, owner, guardians, threshold, timelock_duration)`
Initialize the recovery module for a smart wallet.

**Parameters:**
- `owner`: The wallet owner's address
- `guardians`: Vector of initial guardian addresses
- `threshold`: Number of guardian approvals required
- `timelock_duration`: Duration in seconds before recovery can execute

**Errors:**
- `AlreadyInitialized`: Contract already initialized
- `InvalidThreshold`: Threshold is 0 or exceeds guardian count
- `MaxGuardiansReached`: More than 10 guardians provided

### Guardian Management

#### `add_guardian(env, owner, guardian)`
Add a new guardian to the recovery system.

#### `remove_guardian(env, owner, guardian)`
Remove a guardian from the recovery system.

#### `update_threshold(env, owner, new_threshold)`
Update the guardian approval threshold.

### Recovery Flow

#### `initiate_recovery(env, initiator, wallet, new_owner)`
Initiate a recovery request for the wallet.

#### `approve_recovery(env, guardian)`
Approve a pending recovery request as a guardian.

#### `cancel_recovery(env, owner)`
Cancel a pending recovery request.

#### `execute_recovery(env)`
Execute a recovery request to transfer wallet ownership.

### View Functions

#### `get_owner(env)` → `Address`
Get the current wallet owner address.

#### `get_guardians(env)` → `Vec<Address>`
Get all active guardians.

#### `get_threshold(env)` → `u32`
Get the guardian approval threshold.

#### `get_recovery_request(env)` → `Option<RecoveryRequest>`
Get the current recovery request status.

#### `is_guardian(env, address)` → `bool`
Check if an address is a guardian.

#### `get_config(env)` → `RecoveryConfig`
Get the recovery configuration.

#### `can_execute_recovery(env)` → `bool`
Check if recovery can be executed (timelock expired + threshold met).

## ⚠️ Security Considerations

1. **Guardian Selection**: Choose guardians you trust but who are unlikely to collude
2. **Threshold Configuration**: Set threshold high enough to prevent collusion but low enough for availability
3. **Timelock Duration**: Balance between security (longer) and accessibility (shorter)
4. **Owner Responsibility**: Monitor for unauthorized recovery attempts and cancel promptly

## 📝 Events

The contract emits the following events:
- `(init, owner, threshold, timelock_duration)` - Initialization
- `(guard_add, guardian, id)` - Guardian added
- `(guard_rm, guardian)` - Guardian removed
- `(thresh, new_threshold)` - Threshold updated
- `(rec_init, wallet, new_owner, expires_at)` - Recovery initiated
- `(rec_appr, guardian, approval_count)` - Recovery approved
- `(rec_can, owner)` - Recovery cancelled
- `(rec_exec, old_owner, new_owner)` - Recovery executed

## 🚀 Deployment

```bash
# Build the contract
cargo build --release -p aa_recovery

# The compiled contract will be at:
# target/wasm32-unknown-unknown/release/aa_recovery.wasm
```

## 📄 License

Part of the StellarYield project.
