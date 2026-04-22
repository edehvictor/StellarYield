//! # Matching Engine
//!
//! Off-chain matching engine with Libp2p networking for the StellarYield CLMM protocol.
//! 
//! This crate provides:
//! - **Order Book**: In-memory order book with price-time priority matching
//! - **Matching Engine**: Core order matching algorithm
//! - **P2P Network**: Libp2p-based order gossip and discovery
//! - **Settlement**: On-chain settlement with joint signatures
//!
//! ## Architecture
//!
//! ```text
//! ┌──────────────┐     Libp2p      ┌──────────────┐
//! │  Node 1      │◄───────────────►│  Node 2      │
//! │  Order Book  │   Gossipsub     │  Order Book  │
//! │  Matcher     │                 │  Matcher     │
//! └──────┬───────┘                 └──────┬───────┘
//!        │                                │
//!        │         Settlement             │
//!        └────────────┬───────────────────┘
//!                     │
//!                     ▼
//!            ┌─────────────────┐
//!            │  Soroban Chain  │
//!            │  Settlement     │
//!            │  Contract       │
//!            └─────────────────┘
//! ```
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use matching_engine::{MatchingEngine, Order, Side, OrderType};
//!
//! // Create matching engine
//! let mut engine = MatchingEngine::new();
//!
//! // Submit orders
//! let sell_order = Order::new(
//!     "trader1".to_string(),
//!     Side::Sell,
//!     OrderType::Limit,
//!     100,
//!     1000,
//!     "token0".to_string(),
//!     "token1".to_string(),
//!     "signature".to_string(),
//! );
//!
//! let result = engine.submit_order(sell_order);
//! ```

pub mod orderbook;
pub mod matching;
pub mod network;
pub mod settlement;
pub mod utils;

// Re-export main types
pub use orderbook::{Order, OrderBook, Side, OrderType, OrderStatus, Trade};
pub use matching::{MatchingEngine, MatchResult};
pub use network::{MatchingEngineNetwork, NetworkConfig, NetworkEvent, NetworkMessage};
pub use settlement::{SettlementPayload, SettlementData, SettlementBatch, SettlementVerifier};
