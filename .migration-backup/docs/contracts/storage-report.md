# Soroban Contract Storage Usage Report

This report lists every storage key used by each StellarYield Soroban contract, the Soroban storage class, the expected TTL/persistence behaviour, and the recommended cleanup strategy.

## Background

Soroban provides three storage classes with distinct TTL semantics:

| Class | Default TTL | Typical use case |
|---|---|---|
| `instance` | Tied to the contract instance | Contract-wide config, global counters |
| `persistent` | Set by the writer; must be bumped proactively | Per-user state, long-lived positions |
| `temporary` | Short-lived; auto-deleted when TTL expires | Caches, nonces, ephemeral flags |

Keys that are not bumped expire silently. Persistent state that has not been accessed for an extended period requires an `extend_ttl` call before it can be read again.

---

## Contracts

### 1. `yield_vault`

**Source:** `contracts/yield_vault/src/lib.rs`

#### Storage class: `instance`

| Key | Type | Description | Cleanup |
|---|---|---|---|
| `Admin` | `Address` | Current contract admin. | Never — persists for contract lifetime. |
| `Token` | `Address` | The vault's deposit/withdraw token. | Never. |
| `TotalShares` | `i128` | Sum of all outstanding vault shares. | Never — global counter updated on every deposit/withdrawal. |
| `TotalAssets` | `i128` | Total tokens held by the vault (AUM). | Never. |
| `Initialized` | `bool` | Prevents re-initialization. | Never. |
| `RewardProtocol` | `String` | Identifier of the protocol supplying yield. | Admin-updatable; never auto-expired. |
| `RewardToken` | `Address` | Token used for reward distribution. | Admin-updatable. |
| `DexRouter` | `Address` | DEX router used during `harvest` swaps. | Admin-updatable. |
| `TotalHarvested` | `i128` | Cumulative amount harvested across all compound cycles. | Never. |
| `Keeper` | `Address` | Keeper bot address authorized to call `harvest`. | Admin-updatable. |
| `Paused` | `bool` | Emergency pause flag. | Cleared on `unpause`. |
| `PendingAdmin` | `Address` | Address pending admin transfer confirmation. | Cleared on `accept_admin`. |
| `Oracle` | `Address` | Price oracle address. | Admin-updatable. |
| `EmergencyPenaltyBps` | `u32` | Haircut in basis points applied to withdrawals during emergency mode. | Cleared when emergency mode ends. |

#### Storage class: `persistent`

| Key | Type | Description | TTL extension | Cleanup |
|---|---|---|---|---|
| `Shares(Address)` | `i128` | Share balance of a specific depositor. | Must be bumped on each deposit, withdrawal, and transfer involving the user. | Remove when user's share balance reaches 0 via full withdrawal. |
| `Timelock(Symbol)` | `u64` (timestamp) | Expiry timestamp for a pending timelocked action identified by name. | N/A — expires naturally when the action is executed or cancelled. | Remove after action execution (`remove(key)`). |

**Cleanup responsibility:** The contract itself clears `Timelock` keys on action execution. `Shares` cleanup requires calling `remove` when a user's balance reaches zero — verify this is done in the `withdraw` path.

---

### 2. `stablecoin_manager`

**Source:** `contracts/stablecoin_manager/src/storage.rs`

#### Storage class: `instance`

| Key | Type | Description | Cleanup |
|---|---|---|---|
| `Admin` | `Address` | Contract admin. | Never. |
| `SUSDToken` | `Address` | The synthetic USD token contract. | Never. |
| `CollateralToken` | `Address` | The SAC (Stellar Asset Contract) used as collateral. | Never. |
| `VaultMetrics` | `Address` | Contract address exposing `total_assets`/`total_shares`. | Never. |
| `Oracle` | `Address` | Price oracle for collateral valuation. | Admin-updatable. |
| `Icr` | `u32` (bps) | Initial Collateralization Ratio. | Admin-updatable. |
| `Mcr` | `u32` (bps) | Maintenance Collateralization Ratio (liquidation threshold). | Admin-updatable. |
| `InterestRate` | `i128` | Per-second interest rate scaled by 1e18. | Admin-updatable. |
| `CumulativeIndex` | `i128` | Running compound interest index. | Updated on every interest accrual. Never removed. |
| `LastUpdate` | `u64` | Ledger timestamp of last interest accrual. | Updated alongside `CumulativeIndex`. |
| `Initialized` | `bool` | Prevents re-initialization. | Never. |

#### Storage class: `persistent`

| Key | Type | Description | TTL extension | Cleanup |
|---|---|---|---|---|
| `Cdp(Address)` | `Cdp { collateral, debt_shares, last_index }` | Per-user collateralised debt position. | Bump on every open, repay, deposit-collateral, and withdraw-collateral call. | Remove when `collateral == 0 && debt_shares == 0` (position fully closed). The liquidation path should also clear the key on full liquidation. |

**Cleanup responsibility:** CDP keys that are fully liquidated or repaid must be removed with `env.storage().persistent().remove(&DataKey::Cdp(user))` to recover ledger rent. Without cleanup, the contract accumulates orphan entries proportional to total historical users.

---

### 3. `ve_tokenomics`

**Source:** `contracts/ve_tokenomics/src/storage.rs`

#### Storage class: `instance`

| Key | Type | Description | Cleanup |
|---|---|---|---|
| `Admin` | `Address` | Contract admin. | Never. |
| `YieldToken` | `Address` | The governance / yield token to lock. | Never. |
| `TotalVotingPower` | `i128` | Global sum of all voting power (placeholder — may be computed dynamically). | Updated on lock/unlock. Never removed. |
| `Initialized` | `bool` | Re-initialization guard. | Never. |

#### Storage class: `persistent`

| Key | Type | Description | TTL extension | Cleanup |
|---|---|---|---|---|
| `UserLock(Address)` | lock struct | A user's locked token amount and unlock timestamp. | Bump on `lock` and `extend_lock`. | Remove when the user calls `unlock` after the lock expires and their balance is withdrawn. |
| `GaugeVote(Address)` | vote allocation map | The user's current gauge vote weights. | Bump on `vote`. | Remove when the user un-votes or when their lock expires. |
| `PoolTotalWeight(Address)` | `i128` | Aggregate voting weight directed at a given pool/gauge. | Bump on `vote`. | Archivable once a pool is deprecated; do not remove while active. |

**Cleanup responsibility:** Expired `UserLock` and `GaugeVote` entries should be removable by anyone after the lock epoch ends (consider a public `cleanup_expired_lock(user)` function to reclaim rent).

---

### 4. `options`

**Source:** `contracts/options/src/storage.rs`

#### Storage class: `instance`

| Key | Type | Description | Cleanup |
|---|---|---|---|
| `Admin` | `Address` | Contract admin. | Never. |
| `Oracle` | `Address` | Price oracle for option valuation. | Admin-updatable. |
| `OptionCounter` | `u32` | Monotonically increasing ID for new options. | Never. |

#### Storage class: `persistent`

| Key | Type | Description | TTL extension | Cleanup |
|---|---|---|---|---|
| `Option(id)` | option struct | Individual option record (strike, expiry, writer, holder, settled). | Bump on write/exercise/settle. | Remove after settlement + a minimum audit retention period (suggested: 30 days in ledgers ≈ ~2.6M ledgers). |

**Cleanup responsibility:** A `settle_and_cleanup(id)` admin function can be added to remove the key after on-chain settlement is confirmed and the audit window has passed.

---

## General TTL Policy

| Storage class | Recommended bump ledger threshold | Bump target |
|---|---|---|
| `instance` | On every mutating call | `MAX_INSTANCE_TTL` (17,280,000 ledgers ≈ ~1 year) |
| `persistent` (user state) | On every read/write involving the user | `MAX_PERSISTENT_TTL` (17,280,000 ledgers) |
| `temporary` | N/A — let expire naturally; only bump if needed within the same tx | Depends on use case |

> Soroban's current `MAX_TTL` is approximately 17,280,000 ledgers on mainnet. TTL constants should be defined as named constants in each contract rather than magic numbers.

---

## Archival & Cleanup Summary

| Contract | Keys with cleanup responsibility | Recommended action |
|---|---|---|
| `yield_vault` | `Shares(Address)` on full withdrawal; `Timelock(Symbol)` after execution | Contract already clears `Timelock` on execution. Verify `Shares` removal on zero-balance withdrawal. |
| `stablecoin_manager` | `Cdp(Address)` on full repay or full liquidation | Add `env.storage().persistent().remove(...)` to the full-repay and full-liquidation code paths. |
| `ve_tokenomics` | `UserLock(Address)`, `GaugeVote(Address)` after lock expiry | Add a permissionless `cleanup_expired_lock(user)` function callable by anyone after the user's unlock timestamp. |
| `options` | `Option(id)` after settlement + audit window | Add `settle_and_cleanup(id)` admin function with a minimum retention guard. |

---

*Last updated: 2026-05-27. Re-run this audit whenever a new contract or `DataKey` variant is added.*
