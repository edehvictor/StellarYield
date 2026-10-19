# veTokenomics Contract

## Purpose

`ve_tokenomics` manages vote-escrowed token locks and gauge voting power for governance-driven emissions weighting.

## Public API

- `initialize(admin, yield_token)`
- `create_lock(from, amount, unlock_time)`
- `increase_amount(from, amount)`
- `increase_unlock_time(from, unlock_time)`
- `withdraw(from)`
- `vote(from, pool, weight)`
- `get_voting_power(user)`

## Events

Lock, unlock, and vote events are emitted for governance analytics.

## Errors

`Error` enum covers init/auth/amount/lock-state/unlock-time/voting validation.

## Storage Model

- Instance: admin/config/global counters.
- Persistent: `UserLock`, `GaugeVote`, `PoolTotalWeight`.

## Lock history and voting-power snapshots

Every change to a lock (create, add tokens, extend, withdraw) and to the total locked amount is checkpointed with its ledger timestamp, so past state can be read back:

- `get_lock_at(user, timestamp)`, `get_voting_power_at(user, timestamp)`, `get_total_locked_at(timestamp)`.
- The answer is the state at the end of that second. Changes made later (more tokens, a longer lock, a withdrawal) never alter it. `timestamp` must not be in the future (`FutureTimestamp`).
- Governance uses `get_voting_power_at` with a proposal's creation time. Delegation is not part of this figure.
- Locks made before checkpoints existed report their current lock until they next change; that first change records what came before it.

## Fee distribution

Lockers share the $YIELD fees deposited for an epoch (one week, `timestamp / 604800`).

- `deposit_fees(from, amount)` adds fees to the current epoch.
- An account's share of an epoch is `fees * amount_locked_at_epoch_start / total_locked_at_epoch_start`, rounded down, so locking after an epoch has begun earns nothing from it and the shares never exceed the deposit. The weight is the locked amount rather than the decaying voting power, so locks that have expired but have not been withdrawn still count; withdraw them.
- `claim_fees(user, start_epoch, end_epoch)` pays every unclaimed epoch in the range (at most `MAX_CLAIM_EPOCHS`, all of them ended). An epoch pays an account once: epochs already claimed are skipped, so overlapping or repeated ranges never pay twice. It fails with `NothingToClaim` when nothing new is owed.
- Views: `get_unclaimed_fees`, `get_claimed_fees`, `has_claimed_fees`, `get_epoch_fees`, `get_epoch_fees_claimed`, `get_current_epoch`.

## Local Test

```bash
cd contracts
cargo test -p ve_tokenomics
```

## Integration Notes

- Designed to feed emission/gauge weighting logic in tokenomics flows.
