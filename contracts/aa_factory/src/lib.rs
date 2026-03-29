#![no_std]

//! # Account Abstraction Factory
//!
//! A comprehensive Account Abstraction solution for Soroban that enables
//! gasless transactions and seamless user onboarding through smart contract wallets.
//!
//! ## Overview
//!
//! This crate provides:
//! - **WalletFactory**: Deploys and manages proxy wallet contracts
//! - **ProxyWallet**: Individual user wallets with WebAuthn support
//! - **Gas Sponsorship**: Transaction relaying for fee-less user experience
//! - **Vault Integration**: Direct interaction with yield vaults
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────┐
//! │   User (EOA)    │
//! │  Passkey Auth   │
//! └────────┬────────┘
//!          │ Signs Intent
//!          ▼
//! ┌─────────────────┐      ┌─────────────────┐
//! │  StellarYield   │─────▶│  Proxy Wallet   │
//! │    Relayer      │ Pays │  (Smart Contract)│
//! │   (Gas Fees)    │      │                 │
//! └─────────────────┘      └────────┬────────┘
//!                                   │
//!                          ┌────────┴────────┐
//!                          ▼                 ▼
//!                   ┌──────────┐      ┌──────────┐
//!                   │  Vault   │      │ Recovery │
//!                   │  Deposit │      │ Guardians│
//!                   └──────────┘      └──────────┘
//! ```
//!
//! ## Features
//!
//! - **WebAuthn/Passkey Authentication**: Users sign with Touch ID, Face ID, etc.
//! - **Nonce Management**: Replay protection for all transactions
//! - **Batch Operations**: Execute multiple actions in one transaction
//! - **Gas Sponsorship**: StellarYield pays fees for onboarded users
//! - **Recovery Integration**: Works with aa_recovery for account recovery
//!
//! ## Quick Start
//!
//! ### Deploy Factory
//!
//! ```rust
//! let factory_id = env.register(WalletFactory, ());
//! let factory = WalletFactoryClient::new(&env, &factory_id);
//! factory.initialize(&admin, &proxy_code_hash);
//! ```
//!
//! ### Deploy Proxy Wallet
//!
//! ```rust
//! let config = DeploymentConfig {
//!     owner: user_address,
//!     relayer: Some(stellaryield_relayer),
//!     salt: unique_salt,
//! };
//! let proxy = factory.deploy_proxy(&config);
//! ```
//!
//! ### Execute Gasless Transaction
//!
//! ```rust
//! let op = UserOperation {
//!     sender: proxy,
//!     nonce: 0,
//!     call_data: encoded_call,
//!     call_target: vault_contract,
//!     signature: user_webauthn_signature,
//!     max_fee: 1000,
//! };
//! proxy.execute_user_operation(&op, &relayer);
//! ```

mod factory;
mod proxy_wallet;

pub use factory::{DeploymentConfig, FactoryError, ProxyInfo, WalletFactory, WalletFactoryClient};
pub use proxy_wallet::{
    ExecutionResult, ProxyError, ProxyWallet, ProxyWalletClient, UserOperation, WebAuthnSignature,
};
