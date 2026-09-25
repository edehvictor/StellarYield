# Reward Schedule Authoring: Timezone & Weekly Window Expectations

## Overview
Reward schedule windows (`startDate` / `endDate` on `RewardScheduleLike`, see
`docs/reward_registry.md`) drift when local timezones, UTC storage, and
weekly campaign boundaries get mixed up during authoring. This document is
the canonical clock model for anyone entering or editing a schedule window,
and for anyone building tooling that renders one.

Implementation: `backend/rewards/src/scheduleHealth.ts`.
Tests: `backend/rewards/src/__tests__/scheduleHealth.test.ts`.

## The model

1. **Stored windows are always UTC.** A JavaScript `Date` has no attached
   timezone — internally it is always a UTC epoch timestamp. Every
   `startDate` / `endDate` that reaches storage must already be that UTC
   instant. Never store a "local" date string and reinterpret it later.
2. **Timezone conversion happens once, at authoring time.** If a schedule is
   authored as a wall-clock time in a named timezone (e.g. "Monday 00:00 in
   America/New_York"), convert it to UTC immediately with
   `normalizeScheduleWindowToUtc` / `wallClockToUtc` before it is persisted.
   Do not store the timezone name alongside the instant and re-derive UTC
   later — that reintroduces the exact drift this document exists to
   prevent.
3. **Rendering is a pure, non-mutating read.** `renderInTimeZone(utcInstant,
   timeZone)` formats a stored UTC instant for a viewer in any timezone. It
   never changes, and must never be fed back into, the stored window.
4. **Weekly campaign boundaries are defined in UTC, not local time.** "Which
   week does this claim belong to" is answered by `startOfIsoWeekUtc`,
   `endOfIsoWeekUtc`, and `isSameIsoWeekUtc` — Monday 00:00:00.000 UTC
   through the following Monday 00:00:00.000 UTC (exclusive), independent of
   where a schedule was authored or where a claimant is located. Do not
   compute week boundaries from a viewer's local calendar day.

## API summary

| Function | Purpose |
|---|---|
| `wallClockToUtc({ wallClock, timeZone })` | Convert an authored wall-clock moment in a named IANA timezone to its precise UTC instant. Uses live `Intl` timezone rules, so it is correct across DST transitions rather than assuming a fixed offset. |
| `normalizeScheduleWindowToUtc({ start, end })` | Normalize a full authored window (each endpoint either an already-UTC `Date` or a `{ wallClock, timeZone }` pair) to `{ startDate, endDate }` UTC `Date`s. Throws if the normalized end is not strictly after the normalized start. |
| `renderInTimeZone(utcInstant, timeZone)` | Format a stored UTC instant for display in a target timezone. Returns the local ISO string, the timezone name, and the UTC offset (minutes) in effect at that instant. |
| `startOfIsoWeekUtc(instant)` | Monday 00:00:00.000 UTC of the week containing `instant`. |
| `endOfIsoWeekUtc(instant)` | Start of the *next* UTC week — the exclusive end of the current one. |
| `isSameIsoWeekUtc(a, b)` | Whether two instants fall in the same UTC Monday–Sunday week. |

## Authoring checklist

- [ ] If the source material (governance proposal, protocol docs, campaign
      brief) gives a wall-clock time in a specific timezone, capture the
      IANA timezone name (e.g. `"America/New_York"`, not `"EST"` or a raw
      UTC offset — fixed offsets don't account for DST) and pass both
      through `wallClockToUtc` / `normalizeScheduleWindowToUtc` before
      storing.
- [ ] If the source material already gives a UTC or offset-qualified ISO
      string (e.g. `"2026-05-04T04:00:00-04:00"`), `new Date(...)` already
      parses it into the correct UTC instant — no additional conversion
      needed.
- [ ] Never persist a naive `"YYYY-MM-DD HH:mm"` string without an
      accompanying timezone. It is ambiguous by construction and cannot be
      normalized later without guessing.
- [ ] When displaying a stored window to a user, call `renderInTimeZone`
      with their timezone at render time — don't precompute and cache a
      "local" string, since a cached string silently goes stale if the
      viewer's timezone or the display requirements change.
- [ ] When reasoning about "this week's" campaign, use the UTC ISO week
      helpers, not `Date#getDay()` / `Date#getDate()` (which report in the
      host machine's local timezone and will disagree with a server running
      in a different zone).

## Known limits

- Wall-clock times that fall inside a DST "spring forward" gap (a local time
  that never occurs, e.g. 2:30 AM on a spring-forward date in a zone that
  jumps from 2:00 to 3:00) are inherently ambiguous. `wallClockToUtc`
  resolves them by the offset in effect at the initial UTC guess; treat any
  schedule authored in that one-hour gap as needing manual confirmation.
- `wallClockToUtc` / `renderInTimeZone` rely on the JavaScript runtime's
  built-in ICU timezone database (`Intl`). Keep the Node.js version current
  so IANA rule changes (e.g. a country changing its DST policy) are
  reflected.
