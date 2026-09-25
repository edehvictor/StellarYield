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
