# Bug Investigation Canvas: [Issue Summary]

> **Template Instructions**: Use this canvas for investigating, reproducing, root-causing, and resolving complex bugs, regressions, data discrepancies, or invariant violations.

---

## Overview & Incident Metadata

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Canvas Type** | `Bug & Root Cause Canvas` | Defect triage and root-cause analysis |
| **Issue / PR #** | `#[Issue Number]` | Associated GitHub issue |
| **Investigator** | `@[GitHub Handle]` | Lead investigator / engineer |
| **Severity** | `Critical` / `High` / `Medium` / `Low` | Impact on users, data, or funds |
| **Priority** | `P0 (Urgent)` / `P1 (High)` / `P2 (Normal)` / `P3 (Low)` | Execution priority |
| **Status** | `Triaged` / `Reproduced` / `Fix Identified` / `In Review` / `Resolved` | Current investigation state |
| **Affected Services** | `[e.g. Server, Client, Indexer, Vault Contract]` | Impacted modules |
| **First Observed** | `[Date / Commit Hash / Release Tag]` | When regression was introduced |

---

## Problem Summary & Severity Assessment

### Defect Description
Provide a concise, high-level summary of the bug and its observable symptoms.

### Severity Justification
Explain the business, operational, or security impact justifying the assigned severity rating.

> [!CAUTION]
> If user funds, ledger state, or private keys are at risk, immediately trigger the Emergency Runbook (`docs/EMERGENCY_RUNBOOK.md`) and notify core maintainers.

---

## Environment & Affected Versions

- **Environment**: `Local` / `Testnet` / `Futurenet` / `Mainnet` / `Staging`
- **Node Version**: `v20.x+`
- **Browser (if client bug)**: `Chrome / Firefox / Safari / Edge [Version]`
- **OS**: `macOS / Linux / Windows`
- **Release / Commit**: `commit sha [xxxxxxx]`

---

## Reproduction Steps & Minimal Reproduction

### Steps to Reproduce
1. Step 1: Navigate to `[URL or Route]`
2. Step 2: Perform action `[e.g. Deposit 100 USDC into Vault A]`
3. Step 3: Trigger condition `[e.g. Fast refresh or network throttling]`
4. Step 4: Observe error or inconsistent behavior

### Minimal Reproducible Example
```typescript
// Include minimal code snippet, cURL command, or test case demonstrating the bug
```

> [!TIP]
> Prefer crafting a deterministic unit test in Jest/Vitest or Cargo to prove reproduction before implementing the fix.

---

## Expected vs. Actual Behavior

### Expected Behavior
Describe what the system should have done under standard operational parameters.

### Actual Behavior
Describe what actually occurred (include exact error messages, HTTP status codes, or stack traces).

```text
[Paste relevant error logs or console output here]
```

---

## Root Cause Analysis (RCA & 5 Whys)

1. **Why did the failure occur?**
   - Answer:
2. **Why was that condition met?**
   - Answer:
3. **Why did the validation / check fail to catch it?**
   - Answer:
4. **Why was there no automated test for this case?**
   - Answer:
5. **Root Cause**:
   - The fundamental architectural, logical, or environmental flaw:

---

## Invariant & Financial Impact Assessment

> [!IMPORTANT]
> Verify whether any of the following protocol invariants were compromised:

- [ ] **Yield Balance Conservation**: Did calculated yield diverge from actual vault balances?
- [ ] **Authorization Invariant**: Did unauthorized callers gain access to restricted functions?
- [ ] **State Atomicity**: Were partial database writes committed during a failed transaction?
- [ ] **Data Drift**: Did the indexer record state that conflicts with on-chain ledger records?

---

## Proposed Solution & Alternative Approaches

### Primary Fix
Explain the recommended fix, including specific code changes, migrations, or architectural corrections.

### Alternative Options Considered
| Option | Pros | Cons | Reason Rejected |
| :--- | :--- | :--- | :--- |
| **Option A (Quick Patch)** | Fast to ship | High technical debt | Does not address root cause |
| **Option B (Full Refactor)** | Clean architecture | High regression risk | Too broad for patch release |

---

## Regression Prevention & Test Plan

```bash
# Command to run new regression test
npm test -- -t "should prevent duplicate withdrawal queue insertion"
```

- [ ] New unit test added specifically reproducing this bug.
- [ ] Integration test covering edge cases and invalid inputs.
- [ ] Invariant check added to runtime assertions.

---

## Verification & Sign-off Checklist

- [ ] Root cause identified and validated with deterministic test case.
- [ ] Fix implemented with minimal blast radius.
- [ ] Regression tests pass locally and in CI.
- [ ] No unintended side effects across dependent packages.
- [ ] Postmortem document authored if severity was `Critical` or `High` (`docs/INCIDENT_POSTMORTEM_TEMPLATE.md`).
- [ ] Reviewed and signed off by codeowners.
