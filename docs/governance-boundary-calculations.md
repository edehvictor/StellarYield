# Governance Boundary-Value Calculations & Invariants

This document specifies the arithmetic, boundary-value handling, rounding policies, and state preservation invariants implemented across the StellarYield governance interface (Issue #1898).

---

## 1. Scope & Objectives

Governance operations—including parameter impact forecasting, multi-sig signer quorum progress evaluation, and proposal transaction construction—must behave deterministically and securely under extreme, zero, minimum, maximum, and near-limit inputs.

Key objectives:
- Prevent integer overflows, truncation artifacts, division-by-zero, and `NaN`/`Infinity` propagation.
- Guarantee documented, uniform rounding behavior across client and server.
- Prevent premature quorum indication (e.g. 999/1000 signatures displaying 100% before quorum is met).
- Preserve existing proposal, signature, and balance state on any validation or execution failure.
- Ensure all forms and builders support safe retries without losing user state.

---

## 2. Documented Rounding Policies

### 2.1 Governance Impact Forecast (`/api/governance/forecast`)

All forecast deltas use deterministic half-up rounding (`Math.round((val + Number.EPSILON) * 10^d) / 10^d`) and normalize `-0` to `0`:

| Metric | Decimals | Clamped Domain | Rounding Formula | Rationale |
| :--- | :--- | :--- | :--- | :--- |
| `yieldPctDelta` | 4 | `[-100, 1000]` | `roundToDecimals(val, 4)` | Preserves basis point precision (0.0001% = 0.01 bps). |
| `exposurePctDelta` | 4 | `[-100, 100]` | `roundToDecimals(val, 4)` | Bounded by maximum portfolio allocation (0–100%). |
| `feeRevenueDeltaUsd` | 2 | None (`Number.isFinite`) | `roundToDecimals(val, 2)` | Reflects standard USD currency denomination (cents). |
| `riskScoreDelta` | 2 | `[-100, 100]` | `roundToDecimals(val, 2)` | Standardized risk index range. |

### 2.2 Signer Quorum Progress (`/api/governance/quorum-progress`)

Quorum progress displays the percentage of required signatures collected for a multi-sig action:

$$\text{progressPct} = \begin{cases} 100 & \text{if } met = \text{true} \\ \min(99, \max(0, \operatorname{round}(\frac{signed}{required} \times 100))) & \text{if } met = \text{false} \end{cases}$$

#### Boundary Rules:
- **Quorum Met Invariant**: `progressPct` reaches `100` **if and only if** `met === true` (`signed >= required`).
- **Near-Quorum Cap**: If `signed < required`, `progressPct` is strictly capped at `99%`. For example, $999 / 1000$ signatures evaluates to `99%` rather than rounding up to a misleading `100%`.
- **Standard Fractional Progress**: For ordinary fractions where quorum is not reached (such as 2 out of 3 signers), standard rounding applies ($2 / 3 \approx 66.67\% \to 67\%$).
- **Zero Threshold**: If `threshold === 0`, quorum is immediately satisfied (`met: true`, `progressPct: 100`, `remaining: 0`).
- **Threshold Exceeding Signers**: If `threshold > signers.length`, `required` is safely capped at `signers.length`.

---

## 3. Checked Arithmetic & Boundary Limits

### 3.1 Stroop & Token Amounts
- **Type**: 128-bit signed integer (`i128`), represented as integer strings on the wire.
- **Range**: `[1, 2^127 - 1]` (`1` to `170141183460469231731687303715884105727`).
- **Enforcement**:
  - Fractional stroop values (e.g. `"100.5"`) are rejected before BigInt conversion.
  - Non-numeric strings, negative amounts, and zero amounts are rejected.
  - Overflow beyond `I128_MAX` is rejected with `AMOUNT_OVERFLOW`.

### 3.2 Basis Points (`bps`)
- **Range**: `[0, 10000]` integer.
- **Enforcement**:
  - Decimals (e.g. `12.5` bps) are strictly rejected.
  - Negative values and values $> 10000$ (100%) are rejected.
  - For ranged fees: `min_bps <= max_bps` is strictly enforced.

### 3.3 Protocol TVL & Forecast Parameters
- **TVL Domain**: `[0, Number.MAX_SAFE_INTEGER]`. Negative TVL is rejected at route validation.
- **Extreme / Zero TVL**: Zero TVL safely produces zero fee revenue delta (`0.00`) without division-by-zero errors.
- **Finite Check**: All baseline metrics (`tvlUsd`, `yieldPct`, `feeRatePct`, `exposurePct`, `riskScore`) and proposal parameters must satisfy `Number.isFinite(v)`. `NaN`, `+Infinity`, and `-Infinity` are rejected.

---

## 4. State Preservation & Atomicity Invariants

1. **Read-Only Invariant**:
   - `POST /api/governance/forecast` and `POST /api/governance/quorum-progress` are deterministic and purely computational. They perform zero state mutations, zero database writes, and zero blockchain transactions.
2. **Failure Transparency**:
   - On input rejection, endpoints return HTTP 400 with `error: "VALIDATION_FAILED"` and diagnostic metadata including `code: "STATE_PRESERVED"`.
   - Raw stack traces, SQL errors, or sensitive payload details are never leaked.
3. **Client Form State Preservation**:
   - Validation failures in `GovernanceForecast.tsx` and `TransactionBuilder.tsx` do not clear or reset user inputs.
   - Users can safely correct boundary errors and retry submission without losing context.

---

## 5. Verification & Regression Tests

Regression tests enforce these invariants across client and server:

- **Server Test Suites**:
  - `server/src/__tests__/governanceBoundary.test.ts`: 19 tests validating zero, min, max, near-limit TVL, rounding precision, quorum progress near-limits, API schema validation, and state preservation diagnostics.
  - `server/src/__tests__/governanceForecast.test.ts`: 16 tests covering proposal forecast models.
  - `server/src/__tests__/signerQuorum.test.ts`: 10 tests covering multi-sig threshold calculation.
- **Client Test Suites**:
  - `client/src/pages/governance/governanceBoundary.test.ts`: 20 tests validating i128 stroop boundaries, integer bps constraints, 999/1000 quorum progress capping, cross-field fee checks, and form state preservation on retry.
  - `client/src/pages/governance/validation.test.ts`: 50 tests validating Stellar address schemas, signer sets, and threshold validation.
