# Soroban Storage TTL Strategy

This document audits current storage usage and defines lifecycle policy for contract keys.

## Scope

- `contracts/options/src/storage.rs`
- `contracts/stablecoin_manager/src/storage.rs`
- `contracts/ve_tokenomics/src/storage.rs`
- `contracts/strategies/delta_neutral/src/storage.rs`

## Lifecycle Rules

- `instance` storage: configuration and global counters tied to contract lifetime.
- `persistent` storage: user state and long-lived positions that must survive inactivity.
- `temporary` storage: short-lived cache data (not currently used in the audited modules).

## Key Inventory

### `options`

| Key | Class | Intended lifetime | TTL extension needed |
|---|---|---|---|
| `Admin` | instance | contract lifetime | No |
| `Oracle` | instance | contract lifetime | No |
| `OptionCounter` | instance | contract lifetime | No |
| `Option(id)` | persistent | until exercised/expired + post-trade audit period | Yes (recommended) |

Notes:
- `Option(id)` can remain unread for long periods before expiration. Persistent TTL bump policy should be added on read/write paths.

### `stablecoin_manager`

| Key | Class | Intended lifetime | TTL extension needed |
|---|---|---|---|
| `Admin`, `SUSDToken`, `CollateralToken`, `VaultMetrics`, `Oracle` | instance | contract lifetime | No |
| `ICR`, `MCR`, `InterestRate`, `CumulativeIndex`, `LastUpdate`, `Initialized` | instance | contract lifetime | No |
| `CDP(user)` | persistent | user debt position lifetime | Yes (recommended) |

Notes:
- `CDP(user)` should receive TTL bump on updates and critical reads to reduce accidental expiry of active debt records.

### `ve_tokenomics`

| Key | Class | Intended lifetime | TTL extension needed |
|---|---|---|---|
| `Admin`, `YieldToken`, `TotalVotingPower`, `Initialized` | instance | contract lifetime | No |
| `UserLock(user)`, `GaugeVote(user)`, `PoolTotalWeight(pool)` | persistent | until lock expiry and governance accounting finalization | Yes (recommended) |

Notes:
- Voting and lock records are long-lived governance state. Add explicit bumping and cleanup windows after lock expiry.

### `delta_neutral` strategy

| Key | Class | Intended lifetime | TTL extension needed |
|---|---|---|---|
| `Admin`, `UsdcToken`, `SpotToken`, `AmmRouter`, `PerpExchange`, `Oracle`, `Initialized`, `Paused`, `TotalDeposited`, `RebalanceThresholdBps` | instance | contract lifetime | No |
| `Position(user)` | persistent | while position exists and during settlement/audit period | Yes (recommended) |

Notes:
- `Position(user)` should be bumped on open/close/rebalance/funding operations to avoid expiry for low-frequency users.

## Risky Patterns and Follow-up TODOs

- TODO: Standardize a helper for persistent TTL bump operations across contracts.
- TODO: Add explicit bump policy constants (`LOW_WATERMARK_LEDGERS`, `BUMP_LEDGER_AMOUNT`) per contract.
- TODO: Add migration plan for legacy entries that were written before bump logic.
- TODO: Add regression tests validating that critical persistent keys are bumped during write paths.
- TODO: Consider post-expiry cleanup jobs for stale governance/option records to cap state growth.
