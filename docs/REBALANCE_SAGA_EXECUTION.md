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

The queue processor job now includes saga recovery:

1. `recoverStuckSagas()` is called at the start of each job run.
2. Sagas with expired locks or missing locks in non-terminal states are
   reset to `pending`.
3. The saga `resumeSaga()` method determines which phase to resume from
   based on the last durable checkpoint.

## Tests

- `server/src/__tests__/rebalanceSagaService.test.ts` — 32 tests covering:
  - Saga creation with idempotency keys
  - Lock acquisition, rejection, and stealing
  - Checkpoint idempotency
  - State transitions and terminal states
  - Failure counting and retry limits
  - Phase resumption logic
  - Manual review resolution
  - Error classification
  - Full saga execution flow
  - Simulated timeouts
  - Concurrent worker prevention
  - Duplicate submission detection