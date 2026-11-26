# Alert Preferences Boundary-Value Calculations & Invariants

This document specifies the arithmetic, boundary-value handling, rounding policies, and state preservation invariants implemented for alert preferences across the client and server (Issue #1906).

---

## 1. Scope & Objectives

Alert preferences configure notification channels, trigger cooldowns, quiet hours, and adaptive severity thresholds for APY and risk alerts. Under extreme, zero, minimum, maximum, and near-limit inputs, the preference engine must behave deterministically, safely handle floating point calculations, and preserve existing state on failure.

Key objectives:
- Prevent division-by-zero and `NaN`/`Infinity` propagation in threshold recommendation algorithms.
- Enforce documented half-up rounding and normalize `-0` artifacts.
- Enforce strict integer constraints on cooldown minutes and quiet hours boundaries.
- Preserve existing preferences and audit history whenever validation or execution fails.
- Maintain form inputs in client dialogs to enable safe operator retries without data loss.

---

## 2. Documented Rounding Policies

All numeric values in alert preferences use deterministic half-up rounding (`Math.round((val + Number.EPSILON) * 10^d) / 10^d`) and normalize `-0` to `0`:

| Metric | Decimals | Domain | Rounding Formula | Rationale |
| :--- | :--- | :--- | :--- | :--- |
| `thresholdValue` | 4 | `[0, 1000]` | `roundToDecimals(val, 4)` | Preserves basis point precision for APY thresholds. |
| `severityThreshold` | 2 | `[0, 1000]` | `roundToDecimals(val, 2)` | Standard percent delta precision (e.g. 5.25%). |
| `historicalVolatility` | 2 | `[0, 100]` | `roundToDecimals(val, 2)` | Standard volatility index format. |
| `triggerFrequencyPerHour` | 2 | `[0, 1000]` | `roundToDecimals(val, 2)` | Trigger rate per hour. |
| `noiseIndex` | 4 | `[0, 1]` | `roundToDecimals(val, 4)` | Normalized noise ratio. |
| `apyDispersion` | 2 | `[0, 100]` | `roundToDecimals(val, 2)` | APY dispersion spread. |

---

## 3. Checked Arithmetic & Boundary Limits

### 3.1 Adaptive Threshold Recommendations (`recommendAlertThreshold`)
- **Low Volatility Tightening**:
  $$\text{volTight} = \operatorname{round}\left(\frac{\text{volatilityLowThreshold} - \text{volatility}}{\text{volatilityLowThreshold}} \times 1.5, 2\right)$$
  - *Division-by-Zero Guard*: If `volatilityLowThreshold <= 0`, tightening is safely bypassed.
- **High Volatility Expansion**:
  $$\text{volExp} = \operatorname{round}\left(\frac{\text{volatility} - \text{volatilityHighThreshold}}{\max(1, 100 - \text{volatilityHighThreshold})} \times 5.0, 2\right)$$
  - *Boundary Guard*: Denominator is clamped to at least 1 to prevent division-by-zero when `volatilityHighThreshold === 100`.
- **Burst Trigger Suppression**:
  $$\text{burstMultiplier} = \min\left(4, \left\lfloor\frac{\text{triggerFrequency}}{\max(0.01, \text{frequencyBurstThreshold})}\right\rfloor + 1\right)$$
  - *Boundary Guard*: Guarded against `frequencyBurstThreshold <= 0`.
- **Severity & Cooldown Clamping**:
  - `minSeverityThreshold <= severity <= maxSeverityThreshold`
  - Inverted configuration overrides (`min > max`) are safely normalized before clamping.
  - Reason codes `MIN_SEVERITY_FLOOR` and `MAX_SEVERITY_CEILING` are assigned when unbounded values breach boundaries.

### 3.2 Cooldown & Quiet Hours Suppression (`shouldSuppressAlert`)
- **Cooldown Minutes**:
  - Enforced as integer in `[0, 1440]` (24 hours).
  - A cooldown of `0` immediately disables cooldown suppression (alerts fire whenever triggered).
  - Clock skew protection: If `now.getTime() < previousTriggeredAtMs`, alerts are not suppressed.
  - Invalid or non-positive timestamps (`NaN`, `<= 0`) bypass suppression.
- **Quiet Hours**:
  - Enforced as integers in `[0, 23]`.
  - Overnight windows wrapping across midnight (e.g. 23:00 to 06:00 UTC) are supported.
  - Equal start and end (`quietHoursStart === quietHoursEnd`) disables quiet hours (0-hour window).

---

## 4. State Preservation & Atomicity Invariants

1. **Service Layer Invariant**:
   - `updateAlertPreferences` runs `validateAlertPreferences` prior to state mutation.
   - On boundary or type violation, an error is thrown **before** mutating `alertPreferencesStore` or writing to `alertPreferenceAuditService`. Existing preferences and audit history remain untouched.
2. **HTTP API Invariant**:
   - `PUT /api/alerts/:wallet/preferences/:vaultId` returns HTTP 400 upon boundary violations without updating state.
   - `POST /api/alerts/:wallet/preferences/:vaultId/revert` returns HTTP 404/500 on missing entries without altering stored preferences.
3. **Client UI State Invariant**:
   - `AlertsModal.tsx` validates quiet hours and cooldown integers client-side before calling the API.
   - Form state (`form`) is preserved upon validation error or network failure, allowing safe retry and parameter adjustments.

---

## 5. Verification & Test Coverage

Regression tests enforce these invariants across client and server:

- **Server Test Suites**:
  - `server/src/services/__tests__/alertPreferencesBoundary.test.ts` (19 tests): Division-by-zero resilience, -0 normalization, overnight quiet hours, clock skew, cooldown boundaries, and state preservation.
  - `server/src/services/__tests__/alertsPreferenceRules.test.ts` (43 tests): Deterministic recommendations, jitter normalization, audit trail, and revert flows.
- **Client Test Suites**:
  - `client/src/features/alerts/__tests__/alertPreferencesBoundary.test.tsx` (4 tests): Non-integer cooldown rejection, quiet hours range validation, API failure state retention, and safe retry.
  - `client/src/features/alerts/AlertsModal.test.tsx` (13 tests): Rendering, modal lifecycle, and alert CRUD.
