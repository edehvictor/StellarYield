# Alert Preferences Resilience & Recovery Architecture

## Overview

Issue #1907 strengthens alert preference management across client and server against partial completion, network interruption, and unsafe retry attempts. This document details the operational lifecycle, boundary validation guarantees, snapshot recovery mechanisms, and client-side checkpointing semantics.

---

## 1. Operation Lifecycle

Alert preference mutations can be staged and executed as managed multi-step operations to survive network failures and partial writes:

```
[staged] ---> [applied] ---> [audited] ---> [succeeded]
   |             |              |
   v             v              v
[failed]      [failed]       [failed]
   |             |              |
   +-------------+--------------+
                 |
                 v
           [rolled_back]
```

### Operation States

| State | Description | Can Resume? | Can Rollback? |
|---|---|---|---|
| `staged` | Input validated at boundary; initial snapshot captured. | Yes | Yes |
| `applied` | State updated in storage, pending audit or downstream sync. | Yes | Yes |
| `audited` | Audit event recorded for tracking. | Yes | Yes |
| `succeeded` | Operation finished and terminal. | No | No |
| `failed` | Failure recorded with error details and stage checkpoint. | Yes | Yes |
| `rolled_back` | Reverted to snapshot preferences captured before operation. | No | No |

---

## 2. API Endpoints

### Direct Resilient Update
- **`PUT /api/alerts/preferences`**
  - **Headers**: Supports `X-Operation-Id` (or body `operationIdentity`).
  - **Boundary Validation**: Validates all untrusted fields before state modification. Invalid inputs immediately return HTTP 400 without mutating stored preferences.
  - **Safe Retry / Idempotency**:
    - Retrying with identical parameters returns the existing preference record with header `X-Idempotent-Replayed: true`.
    - Retrying with the same operation ID but conflicting payload returns HTTP 409 (`Operation identity conflict`).

### Managed Operation Lifecycle
- **`POST /api/alerts/preferences/operations`**
  - Staged operation initialization.
  - Optional `autoExecute: true` automatically runs through `staged` → `applied` → `audited` → `succeeded`.
- **`GET /api/alerts/preferences/operations/:operationId`**
  - Retrieves operation status, target preferences, snapshot (`previousPreferences`), and error message.
- **`POST /api/alerts/preferences/operations/:operationId/resume`**
  - Resumes an interrupted or failed operation from its last completed step.
- **`POST /api/alerts/preferences/operations/:operationId/rollback`**
  - Restores `previousPreferences` (or deletes the record if it did not previously exist), marking status `rolled_back`.

---

## 3. Boundary Validation & State Preservation

Untrusted inputs are validated at the perimeter before any mutations or store access occur:

- **Email Format**: RFC 5322 validation when `emailAlertsEnabled` is active.
- **Cooldown Limits**: Range checked to `[1, 1440]` minutes.
- **Severity Threshold**: Enum checked (`low`, `medium`, `high`, `critical`).
- **Quiet Hours**: Validated format `HH:MM` and logical pairing.

### Invariant:
If any parameter fails validation, the request returns HTTP 400 typed error (`AlertPreferenceValidationError`) and the existing database/in-memory state is guaranteed untouched.

---

## 4. Client Checkpointing (`client/src/features/alerts`)

The frontend persists operation checkpoints to browser storage (`localStorage`):

- **Key Format**: `stellar-yield.alert-pref-checkpoint.<walletAddress>.<vaultId>`
- **Checkpoint Data**: Stores `operationId`, `walletAddress`, `vaultId`, `targetPreferences`, `previousPreferences`, and status.
- **Crash Recovery**: If the user's browser closes or the network drops during submission, `canResumeCheckpoint()` and `canRollbackCheckpoint()` determine whether the modal prompts to retry or revert on reconnection.
- **Auto-Cleanup**: Checkpoint records are cleared upon successful operation completion (`status === "succeeded"`).
