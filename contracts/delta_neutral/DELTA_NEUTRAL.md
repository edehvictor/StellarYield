# Delta-Neutral Rebalance Guard

This document describes how the delta-neutral strategy ensures that a rebalance is driven by a coherent market snapshot and not by a mixture of stale or mismatched inputs.

## Overview

A rebalance needs four inputs:

- **Spot** — the spot price of the base asset.
- -*Perpetual** — the perp price of the same asset.
- -*Funding** — the current funding rate applied to the perp leg.
- **Hedge** — the price of the hedging instrument (e.g. a futures contract).

Each input is produced by a distinct feed. To avoid combining inconsistent data, the strategy assembles the feed values into a immutable [`MarketSnapshot`](./MarketSnapshot.sol) and validates it with [RebalanceGuard`](./RebalanceGuard.sol) before any state changes occur.

## MarketSnapshot

A successfully constructed `MarketSnapshot` is immutable and carries:

- `spotFeedId`, `perpFeedId`, `fundingFeedId`, `hedgeFeedId` — the feed identifiers for each leg.
- `ledgerId` — the canonical ledger identifier the snapshot belongs to.
- `timestamp` — the Unix timestamp at which the snapshot was assembled.
- `spotPrice`, `perpPrice`, `fundingRate`, `hedgePrice` — the feed values.

The constructor rejects any zero identifier, zero timestamp, or zero price. This is a defensive boundary: a snapshot that cannot be interpreted is never created.

## RebalanceGuard

The guard exposes a single function:

```solidity
function validate(
    MarketSnapshot snapshot,
    LegTimestamps callmostLegs,
    bytes32 expectedSpotFeed,
    bytes32 expectedPerpFeed,
    bytes32 expectedFundingFeed,
    bytes32 expectedHedgeFeed,
    bytes32 expectedLedger,
    Bounds callmostBounds,
    uint64 now
) external view returns (bool);
```

It checks, in order:

1. **Source identifiers** are non-zero and match the values carried by the snapshot.
2. **Ledger coherence** — the snapshot's `ledgerId` must equal `expectedLedger`.
3. **Snapshot recency** — the snapshot timestamp must not be in the future and must be within `maxSnapshotAge`.
4. **Leg recency** — each leg timestamp must not be in the future and must be within `maxSourceAge`.
5. **Skew** — every pair of timestamps (including the snapshot timestamp) must differ by at most `maxSkew`.

If any check fails, the function reverts with a dedicated error and no state is modified.

## Boundary Behavior

The guard is purely validational and is designed to be called **fail-fast** before any state-changing operation. Boundaries are inclusive:

| Condition                            | Result                                                                 |
|-------------------------------------|----------------------------------------------------------------------------|
| `age <= maxAge`                       | accepted                                                                  |
| `age > maxAge`                        | revert `StaleSource` / `StaleSnapshot`                                        |
| `skew <= maxSkew`                      | accepted                                                                  |
| `skew > maxSkew`                       | revert `SkewExceeded`                                                         |
| `timestamp > now`                       | revert `SourceInFuture`                                                         |
| `sourceId == 0`                        | revert `InvalidSourceIdentifier`                                               |
| `ledgerId != expectedLedger`          | revert `LedgerMismatch(expected, actual)`                                    |

All reverts preserve state. The guard itself has no storage and never writes.

## Errors

| Error                             | Meaning                                                                 |
|-----------------------------------|----------------------------------------------------------------------------|
| `InvalidSourceIdentifier()`          | A feed identifier is zero or does not match the snapshot.                           |
| `LedgerMismatch(expected, actual)`   | The snapshot belongs to a different ledger than the one being rebalanced.             |
| `SnapshotInFuture(ts, now)`         | The snapshot timestamp is after `now`.                                         |
| `SourceInFuture(ts, now)`           | A leg timestamp is after `now`.                                               |
| `StaleSource(ts, now, maxAge)`      | A leg timestamp is older than `maxSourceAge`.                                   |
| `SkewExceeded(earlier, later, max)` | Two timestamps differ by more than `maxSkew`.                                  |
| `StaleSnapshot(ts, now, maxAge)`   | The snapshot timestamp is older than `maxSnapshotAge`.                           |

## Integration Pattern

```solidity
RebalanceGuard.Bounds memory bounds = RebalanceGuard.Bounds({
    maxSourceAge: 60,
    maxSnapshotAge: 60,
    maxSkew: 30
});

RebalanceGuard.LegTimestamps memory legs = RebalanceGuard.LegTimestamps({
    spot: spotTs,
    perp: perpTs,
    funding: fundingTs,
    hedge: hedgeTs
});

rebalanceGuard.validate(snapshot, legs, spotFeed, perpFeed, fundingFeed, hedgeFeed, ledger, bounds, now);
// ... proceed with the rebalance only after validation succeeds

```

## Testing

Focused regression tests cover:

- **Stale legs** — any leg older than `maxSourceAge` reverts with `StaleSource`.
- **Mismatched ledgers** — a snapshot whose `ledgerId` differs from the expected one reverts with `LedgerMismatch`.
- **Coherent snapshots** — a snapshot and leg set within all bounds passes and returns `true`.
- Exact-boundary cases (age == maxAge, skew == maxSkew) are accepted.
