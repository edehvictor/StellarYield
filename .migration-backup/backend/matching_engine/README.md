# Off-Chain Matching Engine with Libp2p

A high-performance off-chain matching engine for the StellarYield CLMM protocol with Libp2p-based order gossip and atomic on-chain settlement.

## 🎯 Overview

This solution moves the computationally intensive order matching off-chain while maintaining trustless settlement on-chain. This approach:

- **Reduces gas costs**: Only settlement transactions hit the chain
- **Improves performance**: In-memory matching is orders of magnitude faster
- **Enables limit orders**: Price-time priority matching without gas constraints
- **Maintains security**: Joint signatures ensure atomic, verifiable settlement

## 🏗 Architecture

```
┌──────────────┐     Libp2p      ┌──────────────┐
│  Node 1      │◄───────────────►│  Node 2      │
│  Order Book  │   Gossipsub     │  Order Book  │
│  Matcher     │                 │  Matcher     │
└──────┬───────┘                 └──────┬───────┘
       │                                │
       │         Settlement             │
       └────────────┬───────────────────┘
                    │
                    ▼
           ┌─────────────────┐
           │  Soroban Chain  │
           │  Settlement     │
           │  Contract       │
           └─────────────────┘
```

## 📦 Components

### 1. Order Book (`/src/orderbook/`)

In-memory order book with price-time priority:

- **BTreeMap-based** price levels for O(log n) operations
- **FIFO ordering** within price levels
- **Supports** limit orders, market orders, cancellations

```rust
pub struct Order {
    pub id: String,
    pub trader: String,
    pub side: Side,          // Buy or Sell
    pub order_type: OrderType,
    pub price: u128,
    pub amount: u128,
    pub filled: u128,
    pub status: OrderStatus,
    pub timestamp: u64,
    pub signature: String,
}
```

### 2. Matching Engine (`/src/matching/`)

Core matching algorithm with price-time priority:

- **Continuous matching**: Orders match immediately upon submission
- **Partial fills**: Large orders can fill against multiple counterparties
- **Maker-taker model**: Maker's price is used for execution

```rust
pub struct MatchResult {
    pub trades: Vec<Trade>,
    pub remaining_order: Option<Order>,
    pub filled_orders: Vec<String>,
}
```

### 3. Libp2p Network (`/src/network/`)

Peer-to-peer networking for order discovery:

- **Gossipsub**: Efficient order broadcasting to all nodes
- **MDNS**: Automatic local network discovery
- **Noise**: Encrypted peer-to-peer communication
- **Message types**: Orders, cancellations, trade notifications

```rust
pub enum NetworkMessage {
    NewOrder(Order),
    OrderCancelled { order_id: String, signature: String },
    TradeExecuted { trade_id: String, data: String },
    SyncRequest { pair_id: String },
    SyncResponse { pair_id: String, orders: Vec<Order> },
}
```

### 4. Settlement (`/src/settlement/`)

On-chain settlement with joint signatures:

- **Multi-party signatures**: Maker, taker, and matching engine all sign
- **Batch settlement**: Multiple trades settled in one transaction
- **Fee collection**: Automatic fee deduction during settlement
- **Circuit breaker**: Emergency pause functionality

```rust
pub struct SettlementData {
    pub trade_id: String,
    pub maker: Address,
    pub taker: Address,
    pub token0: Address,
    pub token1: Address,
    pub amount0: i128,
    pub amount1: i128,
    pub maker_signature: String,
    pub taker_signature: String,
    pub engine_signature: String,
}
```

## 🔒 Security Model

### Order Authentication
- All orders signed with Ed25519
- Signature includes: order details + timestamp + nonce
- Prevents order spoofing and replay attacks

### Settlement Verification
- **Three-party signatures**: Maker + Taker + Engine must all sign
- **Trade ID tracking**: Prevents double-settlement
- **Atomic execution**: Both token transfers succeed or both fail

### Race Condition Prevention
- **Sequence numbers**: Orders include timestamps for ordering
- **Lock mechanism**: Settlement locks funds during verification
- **Expiry**: Orders can have expiration timestamps

### Network Security
- **Peer authentication**: Libp2p keypair-based identity
- **Message validation**: Strict validation mode for gossipsub
- **Encryption**: Noise protocol for all communications

## 📋 Quick Start

### Running a Matching Engine Node

```bash
cd backend/matching_engine
cargo run --bin matching_engine_node
```

### Submitting an Order

```rust
use matching_engine::{Order, Side, OrderType, MatchingEngine};

let mut engine = MatchingEngine::new();

// Create a limit buy order
let order = Order::new(
    "trader_address".to_string(),
    Side::Buy,
    OrderType::Limit,
    100_000_000,  // Price (with decimals)
    1_000_000_000, // Amount
    "token0_address".to_string(),
    "token1_address".to_string(),
    "signature".to_string(),
);

// Submit and get match result
let result = engine.submit_order(order);
```

### Settling a Trade On-Chain

```rust
use soroban_sdk::{Address, Env};
use settlement::{SettlementContractClient, SettlementData};

let client = SettlementContractClient::new(&env, &contract_id);

let settlement = SettlementData {
    trade_id: "trade_123".to_string(),
    maker: maker_address,
    taker: taker_address,
    token0: token0_address,
    token1: token1_address,
    amount0: 1_000_000_000,
    amount1: 100_000_000,
    maker_signature: maker_sig,
    taker_signature: taker_sig,
    engine_signature: engine_sig,
};

client.settle_trade(&settlement, &maker_sig, &taker_sig, &engine_sig);
```

## 🧪 Testing

### Matching Engine Tests

```bash
cd backend/matching_engine
cargo test
```

### Settlement Contract Tests

```bash
cd contracts/settlement
cargo test
```

### Test Coverage

The implementation includes comprehensive tests for:
- Order book operations (add, remove, cancel)
- Matching algorithm (price-time priority, partial fills)
- Settlement verification (signature validation, double-spend prevention)
- Network messaging (serialization, broadcasting)

## 📊 Performance Considerations

### Order Book
- **Add order**: O(log n) where n is number of price levels
- **Match order**: O(k × log n) where k is number of matched orders
- **Cancel order**: O(1) with HashMap lookup

### Network
- **Order propagation**: O(d) where d is network diameter
- **Peer discovery**: MDNS for local, manual bootstrap for remote

### Settlement
- **Single trade**: ~50k gas (Soroban)
- **Batch settlement**: ~30k gas per trade (economies of scale)

## ⚠️ Production Considerations

1. **Signature Verification**: The current implementation uses simplified signature verification. In production, implement full Ed25519/ECDSA verification using Soroban's cryptographic primitives.

2. **MEV Protection**: Consider implementing commit-reveal schemes or batch auctions to prevent front-running.

3. **Rate Limiting**: Implement rate limiting on order submission to prevent spam attacks.

4. **Monitoring**: Add comprehensive logging and metrics for order flow, match rates, and settlement success.

5. **Redundancy**: Run multiple matching engine nodes for high availability.

## 🚀 Deployment

### Matching Engine Node

```bash
# Build
cargo build --release -p matching_engine

# Run with configuration
RUST_LOG=info ./target/release/matching_engine_node
```

### Settlement Contract

```bash
# Build
cd contracts/settlement
cargo build --release

# Deploy (using Soroban CLI)
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/settlement.wasm \
  --network testnet
```

## 📄 License

Part of the StellarYield project.
