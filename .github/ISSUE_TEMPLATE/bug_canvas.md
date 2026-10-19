---
name: Bug Investigation Canvas
about: Structured canvas for deep defect triage, root-cause analysis, and invariant verification
title: '[Bug Canvas]: '
labels: ['bug', 'canvas']
assignees: ''
---

# Bug Investigation Canvas: [Issue Summary]

## Overview & Incident Metadata

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Canvas Type** | `Bug & Root Cause Canvas` | Defect triage and root-cause analysis |
| **Issue / PR #** | `Pending` | Associated tracking issue |
| **Investigator** | `@` | Lead investigator |
| **Severity** | `Critical / High / Medium / Low` | Severity rating |
| **Priority** | `P0 / P1 / P2 / P3` | Priority |
| **Status** | `Triaged` | Investigation status |
| **Affected Services** | `Server / Client / Contracts / Indexer` | Affected modules |
| **First Observed** | `YYYY-MM-DD` | Date / release first observed |

---

## Problem Summary & Severity Assessment

Provide a concise summary of the bug and observable symptoms.

> [!CAUTION]
> If user funds, ledger state, or private keys are at risk, immediately trigger the Emergency Runbook (`docs/EMERGENCY_RUNBOOK.md`).

---

## Steps to Reproduce & Minimal Reproduction

1. Go to '...'
2. Trigger action '...'
3. Observe unexpected behavior

```typescript
// Minimal reproducible example or failing test case
```

> [!TIP]
> Add a deterministic unit test in Jest/Vitest or Cargo to prove reproduction before implementing the fix.

---

## Expected vs. Actual Behavior

- **Expected**: System maintains expected invariants and state transitions.
- **Actual**: System returned unexpected error or corrupted state.

---

## Root Cause Analysis (RCA & 5 Whys)

1. **Why did the failure occur?**
2. **Why was that condition met?**
3. **Why did validation fail to catch it?**
4. **Why was there no automated test?**
5. **Root Cause**:

---

## Invariant Assessment

> [!IMPORTANT]
> Verify whether yield balance conservation, authorization checks, or state atomicity were compromised.

---

## Proposed Fix & Regression Prevention

- [ ] New unit test added specifically reproducing this bug.
- [ ] Fix implemented with minimal blast radius.
- [ ] Regression test suite passes in CI.
- [ ] Postmortem authored if severity was Critical or High (`docs/INCIDENT_POSTMORTEM_TEMPLATE.md`).
