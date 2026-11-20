# Optimistic Governance

Optimistic proposals execute after a challenge window unless disputed by a
holder with non-zero veYIELD voting power.

## Challenge-window boundary semantics (#960)

Let `t0` be the ledger timestamp when `propose` succeeds, and
`W` the configured `challenge_window`. Then:

| Instant | Condition | `dispute` | `execute` (if Pending) |
|---------|-----------|-----------|-------------------------|
| Exact start | `now == t0` | allowed | rejected (`ChallengeWindowActive`) |
| Inside window | `t0 <= now < t0+W` | allowed | rejected |
| Exact end | `now == t0+W` (`execution_time`) | rejected (`ChallengeWindowExpired`) | allowed |
| After expiry | `now > t0+W` | rejected | allowed |

State transitions:

- Unchallenged: `Pending` → `Executed` (via `execute` at/after end)
- Challenged: `Pending` → `Disputed` (via `dispute` before end); `execute` forever rejected

Events for indexers (`propose` / `dispute` / `execute`) include proposal id,
status transition codes, and timestamps so history can be rebuilt without
replaying storage.

## Voting weight snapshot (#1513)

`propose` records the ledger timestamp as the proposal's snapshot (`get_proposal_snapshot`). `dispute` checks the disputer's veYIELD power as of that time with `get_voting_power_at`, so tokens withdrawn, moved to another account or newly locked after the proposal was created do not change who can dispute it. Weight is measured at the end of the snapshot second: a lock made in the same second as the proposal counts.

Proposals created before this change have no snapshot and keep using current voting power. The veYIELD contract must expose `get_voting_power_at(user, timestamp)`.
