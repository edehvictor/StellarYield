# Idempotent Rebalance Execution Saga (Issue #184)

## Overview

The rebalance execution pipeline now runs through an idempotent saga state machine
with durable checkpoints. This ensures that retried, timed-out, or interrupted
rebalance jobs can safely resume from their last checkpoint without duplicating
on-chain actions.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    RebalanceSagaExecutor                          │
│                                                                  │
│  QUOTE → APPROVAL → SUBMIT → CONFIRM → SNAPSHOT → COMPLETE      │
│     │       │          │         │          │                    │
│     ▼       ▼          ▼         ▼          ▼                    │
│  idempotency keys + durable checkpoints in PostgreSQL            │
└──────────────────────────────────────────────────────────────────┘
```

## State Machine

Each saga transitions through the following states:

| State | Description |
|-------|-------------|
| `pending` | Saga created, not yet started |
| `simulated` | Quote/dry-run phase completed successfully |
| `submitted` | Transaction submitted to the network |
| `confirmed` | Transaction confirmed on-chain (terminal) |
| `failed` | Unrecoverable failure after max retries (terminal) |
| `cancelled` | Cancelled by operator (terminal) |
| `requires_manual_review` | Needs human intervention (terminal until resolved) |

## Phases & Idempotency Keys

Each phase has a unique idempotency key generated at saga creation:

| Phase | Idempotency Key | Purpose |
|-------|----------------|---------|
| `QUOTE` | `quoteKey` | Dry-run validation, allocation checks |
| `APPROVAL` | `approvalKey` | Intent validation, expiry check |
| `SUBMIT` | `submissionKey` | Transaction building & submission |
| `CONFIRM` | `confirmationKey` | On-chain confirmation poll |
| `SNAPSHOT` | `snapshotKey` | Post-execution portfolio snapshot |

Checkpoints are stored in `RebalanceSagaCheckpoint` with a unique
`(sagaId, idempotencyKey)` constraint, preventing duplicate phase execution.

## Concurrency Safety

- Distributed lock on `RebalanceSaga` prevents concurrent workers from
  processing the same queue item.
- Locks expire after 5 minutes (`lockExpiresAt`), allowing recovery of
  interrupted executions.
- In-process lock (`isLocked`) in `RebalanceExecutorService` prevents
  duplicate submissions within the same worker process.
- `recoverStuckSagas()` finds sagas with expired locks and resets them
  to `pending` for reprocessing.

## Failure Handling

Errors are classified into:

| Class | Retryable | Action |
|-------|-----------|--------|
| `TRANSIENT` | Yes | Backoff and retry |
| `FEE_SEQUENCE` | Yes | Refresh and retry |
| `CONSTRAINT` | No | Manual review required |
| `STALE_INTENT` | No | Mark failed |
| `PERMANENT` | No | Manual review required |

After `maxRetries` failures, the saga transitions to `failed` or
`requires_manual_review` based on failure class.

## Admin Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/admin/rebalance-sagas` | List sagas with filters |
| `GET /api/admin/rebalance-sagas/:sagaId` | Saga detail with checkpoints & retries |
| `POST /api/admin/rebalance-sagas/:sagaId/cancel` | Cancel a saga |
| `POST /api/admin/rebalance-sagas/:sagaId/resolve-review` | Resolve manual review (retry/cancel) |
| `POST /api/admin/rebalance-sagas/recover` | Recover stuck sagas |

## Data Model

```prisma
model RebalanceSaga {
  id                  String   @id @default(uuid())
  queueEntryId        String   @unique
  vaultId             String
  state               String   // pending, simulated, submitted, confirmed, failed, cancelled, requires_manual_review
  quoteKey            String?
  approvalKey         String?
  submissionKey       String?
  confirmationKey     String?
  snapshotKey         String?
  checkpoint          Json?
  currentPhase        String   // INIT, QUOTE, APPROVAL, SUBMIT, CONFIRM, SNAPSHOT, COMPLETE
  transactionHash     String?
  feeBumpHash         String?
  innerTxXdr          String?
  lockedBy            String?
  lockedAt            DateTime?
  lockExpiresAt       DateTime?
  failureClass        String?
  failureReason       String?
  failureCount        Int      @default(0)
  maxRetries          Int      @default(3)
  reviewRequired      Boolean  @default(false)
  reviewReason        String?
  reviewedAt          DateTime?
  reviewedBy          String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  completedAt         DateTime?
  checkpoints         RebalanceSagaCheckpoint[]
  retries             RebalanceSagaRetry[]
}

model RebalanceSagaCheckpoint {
  id              String   @id @default(uuid())
  sagaId          String
  phase           String
  idempotencyKey  String
  status          String   // PENDING, COMPLETED, FAILED, SKIPPED
  payload         Json?
  error           String?
  createdAt       DateTime @default(now())
  completedAt     DateTime?
  @@unique([sagaId, idempotencyKey])
}

model RebalanceSagaRetry {
  id              String   @id @default(uuid())
  sagaId          String
  attemptNumber   Int
  phase           String
  reason          String
  failureClass    String?
  error           String?
  createdAt       DateTime @default(now())
}
```

## Recovery

The queue processor job now includes phase-aware saga recovery:

1. `recoverStuckSagas()` is called at the start of each job run and on the
   admin recovery endpoint.
2. Sagas with expired locks or missing locks in non-terminal states are
   examined phase-by-phase before any reset occurs:

   - **`SUBMITTED` with a persisted `transactionHash`** — the recovery
     worker polls that exact hash on-chain:
     - If confirmed → the saga is advanced to `confirmed` (terminal) and the
       queue entry is marked `COMPLETED`.
     - If still pending / not found / RPC error → the saga is **left in
       `SUBMITTED`** so the next execution resumes from the `CONFIRM` phase
       and re-polls the same hash. It is NEVER reset to `pending`, which
       would cause a duplicate on-chain rebalance.
   - **`SUBMITTED` with no persisted hash and phase `INIT`** — safe to reset
     to `pending`; the relayer was never contacted.
   - **`PENDING` / `SIMULATED` with no transaction hash** — safe to reset to
     `pending` (no on-chain action has occurred).
   - **Any saga holding a `transactionHash`** is treated conservatively and
     is never reset to a re-submittable state.
3. The saga `resumeSaga()` method determines which phase to resume from
   based on the last completed checkpoint.

## Queue-Entry Sync on Terminal States

When a saga reaches a terminal state, the linked `RebalanceQueueEntry` is
synced so failures never silently disappear from the queue:

| Saga state | Queue entry status | Queue `lastError` |
|------------|-------------------|-------------------|
| `confirmed` | `COMPLETED` | `null` |
| `failed` | `FAILED` | saga `failureReason` |
| `cancelled` | `CANCELLED` | cancellation reason |
| `requires_manual_review` | `FAILED` | review reason |

Resolving a manual review also syncs the queue:

- **Retry** → queue entry returns to `PENDING` with `nextRetryAt` set so the
  processor picks it back up.
- **Cancel** → queue entry becomes terminal `CANCELLED` and stays out of the
  retry pool.

## Tests

- `server/src/__tests__/rebalanceSagaService.test.ts` — 38 tests covering:
  - Saga creation with idempotency keys
  - Lock acquisition, rejection, and stealing
  - Checkpoint idempotency
  - State transitions and terminal states
  - Terminal queue-entry sync (confirmed / failed / review)
  - Failure counting and retry limits
  - Phase resumption logic
  - Manual review resolution + queue-entry sync (retry/cancel)
  - Error classification
  - Full saga execution flow
  - Simulated timeouts
  - Concurrent worker prevention
  - Duplicate submission detection
  - Phase-aware recovery of SUBMITTED sagas (never re-submits)
