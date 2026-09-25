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

## Local Test

```bash
cd contracts
cargo test -p ve_tokenomics
```

## Integration Notes

- Designed to feed emission/gauge weighting logic in tokenomics flows.
