# Yield normalization contract

Every yield number that crosses a module boundary — market-feed ingestion,
portfolio summaries, deposit simulations, API responses — is governed by this
contract. Feed ingestion and portfolio summaries are written by different
people at different times, and the only thing that keeps them agreeing is a
single definition of *what unit this is* and *how many digits it carries*.

Canonical definition: [`server/src/utils/yieldNormalizationContract.ts`](../src/utils/yieldNormalizationContract.ts).
Enforcement: [`server/src/__tests__/yieldNormalization.test.ts`](../src/__tests__/yieldNormalization.test.ts)
and `GET /api/yields/parity`.

**Contract version: 1.0.0.**

## The four rules

### R1 — Units

| Quantity | Unit at rest | Unit on the wire | Never |
| --- | --- | --- | --- |
| APY | percent (`6.75` means 6.75 %) | percent | basis points, fractions (`0.0675`) |
| USD amounts | dollars | dollars | cents, stroops |
| Weights / shares | percent (`90` means 90 %) | percent | fractions |
| Fee assumptions | basis points | basis points | percent |

Upstream feeds publish APY in basis points. Convert **once**, at the ingestion
boundary, with `bpsToApyPercent()`. Never divide by `100` inline — an inline
factor is invisible to the parity checker and is the single most common way a
summary ends up 100× off.

```ts
import { bpsToApyPercent } from "../utils/yieldNormalizationContract";

const apyPercent = bpsToApyPercent(rawYield.apyBps); // exact, unrounded
```

### R2 — Precision

APY and USD are emitted at **2 decimals** (`APY_DECIMALS`, `USD_DECIMALS`).
Anything with more decimals has not been normalized.

```ts
normalizeApyPercent(6.7512); // 6.75
normalizeUsd(12_500_000.567); // 12500000.57
```

`isAtApyPrecision()` / `isAtUsdPrecision()` answer "has this been normalized?"
for assertions and guards.

### R3 — Rounding: half away from zero, once, at emit

`roundTo()` is the only rounding function permitted for these quantities. It
differs from a bare `Math.round(v * 100) / 100` in two ways that matter:

1. **Ties go away from zero.** `Math.round` breaks ties towards `+Infinity`, so
   `0.125 → 0.13` but `-0.125 → -0.12`. A summary that negates a feed value —
   an outflow, a drawdown, an APY delta — then disagrees with the feed by a
   full unit in the last place. Under this contract `round(-x) === -round(x)`.
2. **Binary representation is corrected first.** `1.005 * 100` is
   `100.49999999999999` in IEEE-754, which rounds *down*. `roundTo()` re-reads
   the scaled value at 15 significant digits before deciding the tie.

**Round once.** Intermediate arithmetic stays at full precision; rounding is the
last thing that happens before a value is emitted. Rounding an already-rounded
value is what makes two paths that "do the same thing" disagree in the second
decimal:

```ts
// WRONG — the parts are rounded, then the rounded parts are summed and rounded
const apy = normalizeApyPercent(basePrecise);
const rewardApy = normalizeApyPercent(rewardPrecise);
const totalApy = normalizeApyPercent(apy + rewardApy); // 6.75 + 1.00 = 7.75

// RIGHT — sum at full precision, round once
const totalApy = normalizeApyPercent(basePrecise + rewardPrecise); // 7.758 -> 7.76
```

Weighted blends go through `blendApyPercent()`, which normalizes the weights,
accumulates at full precision, and rounds once at the end.

### R4 — Derive from the emitted value

Downstream derivations start from the value the feed **emitted**, not from a
privately recomputed intermediate.

`GET /api/yields` re-derives net yield from the emitted `totalApy`. So does
`normalizeYield()`. If the normalizer derived it from `apy + rewardApy`
instead, the same protocol would carry two different `netApy` values depending
on which path a consumer read — which is exactly what happened before this
contract existed.

## Checking parity

`checkYieldParity(feed, summary)` compares two snapshots field by field and
classifies each disagreement. The classification is the point: a unit slip and
a double-rounding slip look identical in a diff but have completely different
fixes.

| Code | Means | Usual fix |
| --- | --- | --- |
| `UNIT_MISMATCH` | one side is in bps or a fraction | convert at the boundary with `bpsToApyPercent()` |
| `PRECISION_MISMATCH` | a value carries more than 2 decimals | pass it through `normalizeApyPercent()` / `normalizeUsd()` |
| `ROUNDING_MISMATCH` | values differ by exactly one ulp | aggregate at full precision, round once (R3) |
| `VALUE_MISMATCH` | values differ by more than one ulp | the two paths compute different quantities — check the snapshot and the fee/reward components |
| `NON_FINITE` | `NaN` / `Infinity` on one side | guard the division; a zero TVL or empty position set is the usual cause |
| `MISSING_IN_FEED` / `MISSING_IN_SUMMARY` | protocol on one side only | reconcile the protocol set before comparing |

Every issue carries `message` (what disagrees, with both values) and
`remediation` (what to change). `formatParityReport()` renders a report as an
assertion message, so a failing parity test names the protocol, the field, both
values and the fix instead of printing `expected true, received false`.

### From a test

```ts
const report = await getYieldParityReport();
expect(formatParityReport(report)).toContain("Yield parity OK");
```

### From the outside

```console
$ curl -s localhost:4000/api/yields/parity | jq '{inParity, issueCount, issues}'
{
  "inParity": true,
  "issueCount": 0,
  "issues": []
}
```

Weight the summary by a real portfolio with
`?positions=Blend:9000,Soroswap:1000`. The endpoint always returns 200 — it is
a diagnostic report, not a request that can fail validation. Alert on
`inParity: false`.

## Adding a new yield consumer

1. Take APY in percent and USD in dollars. Do not accept bps past the boundary.
2. Compute at full precision; call `normalizeApyPercent()` / `normalizeUsd()`
   exactly once, where the value leaves your module.
3. Do not write a local `round2` — import `roundTo` (or a `normalize*` helper).
   Local copies are how the rounding rule drifts.
4. If your module produces something comparable to a feed entry, expose it as a
   `ComparableYield` and add it to a parity test. A consumer that is never
   compared is a consumer that will drift.

## Changing the contract

Bump `YIELD_NORMALIZATION_CONTRACT.version` and say what changed here. The
version is echoed in every parity report and in the `/api/yields/parity`
response, so a snapshot captured under an old contract is identifiable.
