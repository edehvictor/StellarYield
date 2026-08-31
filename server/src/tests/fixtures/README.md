# Test Fixtures

This directory contains deterministic fixtures used by service tests.

## Recommendation timeline fixtures

`recommendationTimelineFixtures.ts` defines:

- Profiles: `conservative`, `balanced`, `aggressive`
- Market states: `normal`, `volatile`, `stale`
- Expected reason-code transitions for each profile across market shifts

## Reallocation timeline fixtures

`reallocationTimelineFixtures.ts` defines scenarios for reallocation planner
sequencing checks (overlapping execution windows, back-to-back windows, and
chronological ordering):

- `SAFE_STAGGERED_PLAN` — steps staggered well past each recovery window (valid)
- `BACK_TO_BACK_PLAN` — each step starts exactly when the previous window closes (valid)
- `OVERLAPPING_WINDOWS_PLAN` — a step starts mid-window of the previous step (invalid)
- `SAME_START_OVERLAP_PLAN` — two steps scheduled at the exact same time (invalid)
- `UNSAFE_SEQUENCE_PLAN` — a step is listed before an earlier-scheduled step (invalid)
- `MIXED_CONFLICT_PLAN` — both an overlap and an ordering violation (invalid)

## How to extend

1. Add or update a scenario in the relevant fixture file.
2. Keep transitions deterministic (no `Math.random` or runtime timestamps in fixture data).
3. For every new scenario, assert the expected outcome (valid vs. rejected) in its test.
4. Run `npm test -- <service>.test.ts` from `server/` to verify the matrix.

## Notes

- The timeline test suite pins time and randomness, so fixture assertions are stable across CI runs.
- Target vault assertions are part of the fixture matrix and should remain part of acceptance checks.
