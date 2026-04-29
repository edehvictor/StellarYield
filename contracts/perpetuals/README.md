# Perpetual Futures vAMM Exchange

A decentralized perpetual futures exchange powered by a Virtual AMM (vAMM), allowing users to trade with leverage without requiring actual underlying liquidity pools.

## Overview

This contract implements a perpetual futures trading system with the following key features:

- **Virtual AMM Pricing**: Uses a constant product curve (x*y=k) on virtual reserves to calculate trading prices
- **Leveraged Trading**: Supports up to 20x leverage for both long and short positions
- **Funding Rate Mechanism**: Automatic funding payments between longs and shorts to balance open interest
- **Liquidation System**: Automated liquidation of undercollateralized positions with incentives
- **Risk Management**: Configurable margin ratios and leverage limits

## Architecture

### Core Components

1. **vAMM Pricing Engine**
   - Constant product formula: `x * y = k`
   - Mark price = virtual_quote / virtual_base
   - Dynamic pricing based on trade size (slippage)

2. **Position Management**
   - Long/Short positions tracked per trader
   - Collateral-based margin system
   - Unrealized and realized PnL tracking

3. **Funding Rate System**
   - Time-weighted funding payments
   - Rate based on open interest skew: `(long_oi - short_oi) / total_oi`
   - Positive rate = longs pay shorts, negative = shorts pay longs

4. **Liquidation Engine**
   - Maintenance margin requirement: 6.25% default
   - Liquidator incentives: 5% fee
   - Automated position closure at liquidation price

## Public API

### Initialization

```rust
fn initialize(
    env: Env,
    admin: Address,
    oracle: Address,
    index_token: Address,
    quote_token: Address,
    virtual_base: i128,
    virtual_quote: i128,
    max_leverage: u32,
    protocol_fee_recipient: Address,
) -> Result<(), PerpetualError>
```

### Trading

```rust
fn open_position(
    env: Env,
    trader: Address,
    params: TradeParams,
    is_long: bool,
    margin: i128,
) -> Result<Position, PerpetualError>

fn close_position(
    env: Env,
    trader: Address,
    size_to_close: i128,  // 0 for full close
) -> Result<i128, PerpetualError>  // Returns PnL
```

### Margin Management

```rust
fn deposit_margin(env: Env, trader: Address, amount: i128) -> Result<(), PerpetualError>
fn withdraw_margin(env: Env, trader: Address, amount: i128) -> Result<(), PerpetualError>
fn get_margin_balance(env: Env, trader: Address) -> Result<i128, PerpetualError>
```

### Liquidation

```rust
fn liquidate(env: Env, liquidator: Address, trader: Address) -> Result<i128, PerpetualError>
fn is_liquidatable(env: Env, trader: Address) -> Result<bool, PerpetualError>
```

### View Functions

```rust
fn get_mark_price(env: Env) -> Result<i128, PerpetualError>
fn get_execution_price(env: Env, size: i128, is_long: bool) -> Result<i128, PerpetualError>
fn get_position(env: Env, trader: Address) -> Option<Position>
fn get_market_state(env: Env) -> Result<MarketState, PerpetualError>
fn calculate_funding_rate(env: Env) -> Result<i128, PerpetualError>
fn get_unrealized_pnl(env: Env, trader: Address) -> Result<i128, PerpetualError>
```

## Data Structures

### Position

```rust
struct Position {
    owner: Address,
    side: PositionSide,           // Long or Short
    size: i128,                   // Position size in base tokens
    entry_price: i128,              // Entry price (1e7 precision)
    margin: i128,                   // Collateral deposited
    last_cumulative_funding: i128,  // For funding payment tracking
    liquidation_price: i128,        // Liquidation threshold
    open_time: u64,
}
```

### TradeParams

```rust
struct TradeParams {
    size: i128,          // Position size (base tokens)
    leverage: u32,       // Leverage multiplier (e.g., 10 = 10x)
    max_slippage: i128,  // Max acceptable slippage (bps)
}
```

## Risk Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Min Margin Ratio | 5% | Minimum margin before liquidation warning |
| Maintenance Margin | 6.25% | Margin level at which liquidation occurs |
| Max Leverage | 20x | Maximum allowed leverage |
| Liquidation Fee | 5% | Fee paid to liquidators |
| Trading Fee | 0.3% | Fee on each trade |
| Funding Interval | 1 hour | Time between funding payments |

## Events

- `init` - Contract initialization
- `deposit` - Margin deposit
- `withdraw` - Margin withdrawal
- `open` - Position opened
- `close` - Position closed
- `funding` - Funding rate update
- `liquidate` - Position liquidated
- `pause` / `unpause` - Emergency controls

## Security Considerations

1. **Funding Rate Manipulation**: The funding rate is based on OI skew and time-weighted to prevent flash loan attacks.

2. **Price Oracle Risk**: Liquidations rely on mark price. Integration with a robust oracle is critical.

3. **Insolvency Cascades**: Large liquidations can cause reserve imbalance. The system includes:
   - Maintenance margin buffer
   - Protocol fee reserve
   - Circuit breaker (pause functionality)

4. **vAMM Invariant**: The constant product (k) should be maintained across trades. Any deviation indicates a problem.

## Testing

Run tests with:

```bash
cd contracts
cargo test -p perpetuals
```

For coverage:

```bash
cargo tarpaulin -p perpetuals --out Html
```

## Example Usage

```rust
// Initialize exchange
client.initialize(
    admin,
    oracle,
    index_token,  // e.g., BTC
    quote_token,  // e.g., USDC
    1_000_000_000,       // 1000 BTC virtual base
    50_000_000_000_000,  // $50M virtual quote
    20,                  // 20x max leverage
    fee_recipient,
);

// Deposit margin
client.deposit_margin(&trader, &10_000_000_000); // $10,000

// Open 10x long position for 0.5 BTC
let params = TradeParams {
    size: 500_000,    // 0.5 BTC
    leverage: 10,
    max_slippage: 100, // 1%
};
let position = client.open_position(&trader, &params, &true, &2_500_000_000);

// Check unrealized PnL
let pnl = client.get_unrealized_pnl(&trader);

// Close position
let realized_pnl = client.close_position(&trader, &0); // Full close
```

## Integration Notes

- **Oracle Integration**: Currently uses internal vAMM price. For production, integrate with external oracle for index price.
- **Token Standards**: Uses Soroban token interface for all token transfers.
- **Keeper Integration**: Funding updates happen automatically on trades. Can be triggered manually via `update_funding`.

## References

- Perpetual Protocol vAMM design
- dYdX perpetual mechanics
- Synthetix funding rate implementation
