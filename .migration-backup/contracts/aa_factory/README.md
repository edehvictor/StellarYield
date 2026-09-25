# Account Abstraction Factory

A comprehensive Account Abstraction solution for Soroban that enables gasless transactions and seamless user onboarding through smart contract wallets.

## 🎯 Overview

This crate provides the infrastructure for deploying programmable smart contract wallets that enable:
- **Gasless Transactions**: Users don't need XLM to interact with the protocol
- **WebAuthn/Passkey Authentication**: Sign with Touch ID, Face ID, Windows Hello
- **Transaction Relaying**: StellarYield sponsors gas fees for onboarded users
- **Vault Integration**: Direct interaction with yield vaults through the proxy

## 🏗 Architecture

```
┌─────────────────┐
│   User (EOA)    │
│  Passkey Auth   │
└────────┬────────┘
         │ Signs Intent
         ▼
┌─────────────────┐      ┌─────────────────┐
│  StellarYield   │─────▶│  Proxy Wallet   │
│    Relayer      │ Pays │  (Smart Contract)│
│   (Gas Fees)    │      │                 │
└─────────────────┘      └────────┬────────┘
                                  │
                         ┌────────┴────────┐
                         ▼                 ▼
                  ┌──────────┐      ┌──────────┐
                  │  Vault   │      │ Recovery │
                  │  Deposit │      │ Guardians│
                  └──────────┘      └──────────┘
```

## 📦 Components

### WalletFactory
Deploys and manages proxy wallet contracts for users.

**Key Features:**
- Deterministic proxy address generation
- Track all deployed wallets
- Manage trusted relayers for gas sponsorship

### ProxyWallet
Individual user smart contract wallet with Account Abstraction.

**Key Features:**
- WebAuthn/Passkey signature verification
- Nonce-based replay protection
- Gas sponsorship through transaction relaying
- Direct vault interactions (deposit, withdraw)
- Batch operation support

## 🛠 Technical Details

- **Stack**: Rust, Soroban SDK
- **Location**: `/contracts/aa_factory/`
- **Security**: Strict nonce management and signature validation

## 📋 Quick Start

### Deploy Factory

```rust
let factory_id = env.register(WalletFactory, ());
let factory = WalletFactoryClient::new(&env, &factory_id);

let admin = Address::generate(&env);
let proxy_code_hash = Bytes::from_array(&env, &[0u8; 32]);

factory.initialize(&admin, &proxy_code_hash);
```

### Deploy Proxy Wallet

```rust
let config = DeploymentConfig {
    owner: user_address,
    relayer: Some(stellaryield_relayer),
    salt: unique_salt,
};

let proxy = factory.deploy_proxy(&config);
```

### Register WebAuthn Key

```rust
// User registers their passkey public key
let public_key_x = Bytes::from_array(&env, &x_coords);
let public_key_y = Bytes::from_array(&env, &y_coords);

proxy.register_webauthn_key(&owner, &public_key_x, &public_key_y);
```

### Execute Gasless Transaction

```rust
// User signs intent with passkey
let op = UserOperation {
    sender: proxy,
    nonce: 0,
    call_data: encoded_call,
    call_target: vault_contract,
    signature: user_webauthn_signature,
    max_fee: 1000,
};

// Relayer submits transaction (pays gas)
proxy.execute_user_operation(&op, &relayer);
```

### Deposit to Vault

```rust
// User deposits through proxy (gas sponsored)
let shares = proxy.deposit_to_vault(&vault, &amount, &token);
```

## 🔒 Security Model

### Nonce Management
- Each operation requires a unique nonce
- Prevents replay attacks
- Supports out-of-order execution with tracking

### Signature Verification
- WebAuthn signatures verified using P-256 curve
- Challenge includes nonce for uniqueness
- Domain separation prevents cross-protocol attacks

### Relayer Authorization
- Only trusted relayers can submit operations
- Factory admin manages relayer whitelist
- Per-proxy relayer configuration supported

## 📊 Data Structures

### UserOperation
```rust
pub struct UserOperation {
    pub sender: Address,        // Proxy wallet address
    pub nonce: u64,             // Unique nonce
    pub call_data: Bytes,       // Encoded function call
    pub call_target: Address,   // Target contract
    pub signature: Bytes,       // User's signature
    pub max_fee: i128,          // Maximum fee willing to pay
}
```

### DeploymentConfig
```rust
pub struct DeploymentConfig {
    pub owner: Address,         // Wallet owner
    pub relayer: Option<Address>, // Trusted relayer
    pub salt: u64,              // Address generation salt
}
```

## 🧪 Testing

Run tests with:

```bash
cd contracts
cargo test -p aa_factory
```

### Test Coverage

The module includes 24 comprehensive tests covering:
- Factory initialization and proxy deployment
- Proxy wallet initialization
- WebAuthn key registration
- Nonce management and replay protection
- Relayer authorization
- Vault interactions
- Batch operations

## 📜 API Reference

### Factory Functions

#### `initialize(env, admin, proxy_code_hash)`
Initialize the factory contract.

#### `deploy_proxy(env, config)`
Deploy a new proxy wallet for a user.

#### `deploy_proxy_deterministic(env, owner, salt, relayer)`
Deploy with predictable address.

#### `get_proxy_for_user(env, user)`
Get proxy address for a user.

#### `get_all_proxies(env)`
Get all deployed proxies.

### Proxy Functions

#### `initialize(env, owner, factory, relayer)`
Initialize the proxy wallet.

#### `register_webauthn_key(env, owner, public_key_x, public_key_y)`
Register WebAuthn public key.

#### `execute_user_operation(env, op, relayer)`
Execute a user operation with signature.

#### `execute_batch(env, ops, relayer)`
Execute multiple operations in batch.

#### `deposit_to_vault(env, vault, amount, from_token)`
Deposit to yield vault.

#### `withdraw_from_vault(env, vault, shares)`
Withdraw from yield vault.

#### `get_nonce(env)`
Get current nonce.

## ⚠️ Production Considerations

1. **Contract Deployment**: The current implementation uses a placeholder for contract deployment. In production, use `env.deploy_contract()` with the actual proxy Wasm hash.

2. **WebAuthn Verification**: Full WebAuthn signature verification requires P-256 curve operations. The current implementation provides the framework but needs complete cryptographic verification.

3. **Gas Sponsorship Limits**: Implement rate limiting and sybil resistance for the relayer to prevent abuse.

4. **Recovery Integration**: Integrate with the `aa_recovery` module for account recovery through guardians.

## 🚀 Deployment

```bash
# Build the contracts
cargo build --release -p aa_factory

# The compiled contracts will be at:
# target/wasm32-unknown-unknown/release/aa_factory.wasm
```

## 📄 License

Part of the StellarYield project.
