# Issue #281: Partial Fill and Deferred Execution Queue for Rebalances

## Overview

The Rebalance Queue System provides a robust infrastructure for managing rebalance operations with support for:
- **Partial execution**: If a full rebalance cannot execute, the system records the partial fill
- **Deferred retry scheduling**: Failed or partially completed rebalances are automatically retried
- **Duplicate prevention**: Intent hashing prevents replay attacks and duplicate submissions
- **Replay prevention**: Stale intents are rejected based on expiry timestamps
- **Audit trail**: All executions are recorded for compliance and debugging

## Architecture

### Data Model

```
RebalanceQueueEntry
├── id: UUID (primary)
├── vaultId: String
├── status: PENDING | PROCESSING | PARTIAL | COMPLETED | FAILED | CANCELLED
├── executionType: FULL | PARTIAL | DEFERRED
├── targetAllocations: JSON (immutable)
├── currentAllocations: JSON
├── executionStrategy: JSON
├── partiallyExecuted: Boolean
├── partialFillAmount: Float
├── intentHash: String (unique per vault)
├── intentValidUntil: DateTime (replay prevention)
├── attemptCount: Int
├── maxRetries: Int
├── nextRetryAt: DateTime (optional)
├── deferredReason: String (optional)
├── deferredUntil: DateTime (optional)
├── followUpEntryId: String (optional, links to follow-up queue)
├── lastError: String (optional)
├── triggeredBy: String (optional)
├── completedAt: DateTime (optional)
└── timestamps: createdAt, updatedAt

RebalanceHistory
├── id: UUID (primary)
├── queueEntryId: String (foreign key, unique)
├── vaultId: String
├── executionType: String
├── executionResult: JSON (details)
├── totalExecuted: Float
├── expectedAmount: Float
├── filledPercentage: Float
├── transactionHash: String (optional)
└── completedAt: DateTime
```

### Queue States and Transitions

```
PENDING (initial)
  ├─→ PROCESSING (during execution)
  │   ├─→ COMPLETED (full success)
  │   ├─→ PARTIAL (partial fill)
  │   │   └─→ PENDING (deferred follow-up)
  │   │       └─→ COMPLETED (eventual success)
  │   └─→ FAILED (below min fill threshold)
  └─→ CANCELLED (manually cancelled)
```

## Core Concepts

### 1. Intent Hashing

Every rebalance request is hashed using SHA256 of `{vaultId, targetAllocations}` to create a unique `intentHash`. This enables:

- **Idempotency**: Same intent cannot be enqueued twice for the same vault
- **Replay Prevention**: Historical intents cannot be replayed after expiry
- **Deduplication**: If a duplicate request arrives during processing, it's rejected with an error pointing to the existing entry

```typescript
const intentHash = SHA256(JSON.stringify({
  vaultId: "vault-123",
  allocations: { BTC: 0.5, ETH: 0.5 }
}));
```

### 2. Retry Strategy

**Exponential Backoff**: Retry delays increase exponentially:
- Attempt 1 → 60 seconds
- Attempt 2 → 120 seconds (2 × 60)
- Attempt 3 → 180 seconds (3 × 60)

**Max Retries**: Default 3, configurable per enqueue. After max retries exceeded, entry is marked FAILED.

**Retry Eligibility**:
- Entry must be in PENDING status
- `nextRetryAt` must be ≤ current time
- `intentValidUntil` must be > current time (prevents replay)

### 3. Partial Execution

Partial execution occurs when less than 100% of the target allocation can be executed immediately. The system supports:

- **Minimum Fill Threshold**: If fill % < threshold (default 50%), entry is marked FAILED
- **Deferral Threshold**: If fill % < deferral threshold (default 75%), a deferred follow-up entry is created

**Follow-up Creation**:
When a partial execution is recorded:
1. Current allocations are updated based on executed amount
2. A new queue entry (DEFERRED type) is created with:
   - Updated currentAllocations
   - Same targetAllocations and executionStrategy
   - deferredUntil = now + retryDelayMs
   - Same intentHash pattern for linkage
3. Original entry's followUpEntryId points to new entry for audit trail

### 4. Conflict Detection

The system prevents conflicting queue entries:

```typescript
// Conflict: Different target allocations for same vault
vault-1: PROCESSING with targets {BTC: 0.5, ETH: 0.5}
vault-1: ENQUEUE with targets {BTC: 0.6, ETH: 0.4} → REJECTED

// No conflict: Different vaults or completed entries
vault-1: COMPLETED with targets {BTC: 0.5}
vault-1: ENQUEUE with targets {BTC: 0.6} → ACCEPTED

vault-2: PROCESSING with targets {BTC: 0.5}
vault-3: ENQUEUE with targets {BTC: 0.5} → ACCEPTED (different vault)
```

## Security Guarantees

### Replay Prevention

**Intent Expiry**: Each intent has an `intentValidUntil` timestamp (default 24 hours):
- Attempts to execute after expiry are rejected
- Error message: "Intent expired - replay prevention triggered"
- Entry is marked FAILED and not retried

**Hash-based Deduplication**:
- Duplicate intents for same vault are detected via `(intentHash, vaultId)` unique constraint
- Prevents accidental double-processing

### Stale Intent Handling

```typescript
// Example: Stale intent caught during retry
queueEntry = {
  id: 'queue-1',
  intentValidUntil: 2024-04-20T10:00:00Z,
  attemptCount: 2
};

// Current time: 2024-04-21T10:00:01Z (past expiry)
recordFailedAttempt('queue-1', error)
  → Status: FAILED
  → LastError: "Intent expired - replay prevention triggered"
  → No further retries
```

### Safeguards

1. **No Concurrent Modifications**: Only one active rebalance per vault
2. **Immutable Intent Hash**: Once enqueued, intent hash cannot change
3. **Audit Trail**: All state transitions recorded in RebalanceHistory

## Queue Processing Job

### Trigger: `rebalanceQueueProcessorJob.ts`

Runs every 30 seconds (configurable) to:

1. **Process Retries**:
   - Find all PENDING entries with `nextRetryAt` ≤ now
   - Mark as PROCESSING
   - Attempt execution
   - Handle success/failure

2. **Process Deferred**:
   - Find all DEFERRED entries with `deferredUntil` ≤ now
   - Attempt execution with updated allocations

3. **Error Handling**:
   - Failed processing recorded via `recordFailedAttempt()`
   - Exponential backoff applied
   - Max retries enforced

### Configuration

```typescript
startRebalanceQueueProcessorJob({
  enabled: true,
  batchSize: 10,              // Process 10 items per run
  enableRetries: true,        // Enable retry processing
  enableDeferredProcessing: true,
  partialFillConfig: {
    minFillPercentage: 50,
    maxRetries: 3,
    retryDelayMs: 60000,      // 1 minute base delay
    deferralThreshold: 75
  },
  logResults: true
});
```

## API Reference

### RebalanceQueueService

#### `enqueueRebalance()`
```typescript
async enqueueRebalance(
  vaultId: string,
  targetAllocations: Record<string, number>,
  currentAllocations: Record<string, number>,
  executionStrategy: Record<string, unknown>,
  options?: {
    triggeredBy?: string;
    intentValidUntil?: Date;      // Default: now + 24h
    maxRetries?: number;          // Default: 3
  }
): Promise<RebalanceQueueEntryDTO>

// Throws if duplicate intent for same vault
// Returns queue entry in PENDING status
```

#### `recordPartialExecution()`
```typescript
async recordPartialExecution(
  queueEntryId: string,
  result: RebalanceExecutionResult,
  config?: Partial<PartialFillConfig>
): Promise<RebalanceQueueEntryDTO>

// Creates RebalanceHistory record
// May create deferred follow-up entry
// Updates status based on fill percentage
```

#### `recordFailedAttempt()`
```typescript
async recordFailedAttempt(
  queueEntryId: string,
  error: string,
  config?: Partial<PartialFillConfig>
): Promise<RebalanceQueueEntryDTO>

// Schedules retry or marks FAILED
// Enforces intent expiry (replay prevention)
// Applies exponential backoff
```

#### `getPendingRetries()`
```typescript
async getPendingRetries(): Promise<RebalanceQueueEntryDTO[]>

// Returns all PENDING entries ready for retry
// Ordered by nextRetryAt ascending
```

#### `getDeferredEntries()`
```typescript
async getDeferredEntries(): Promise<RebalanceQueueEntryDTO[]>

// Returns all DEFERRED entries ready for processing
```

#### `getQueueStatus()`
```typescript
async getQueueStatus(vaultId: string): Promise<{
  pendingCount: number;
  processingCount: number;
  partialCount: number;
  failedCount: number;
  deferredCount: number;
}>
```

## Usage Example

```typescript
import { rebalanceQueueService } from './services/rebalanceQueueService';

// 1. Enqueue rebalance
const entry = await rebalanceQueueService.enqueueRebalance(
  'vault-123',
  { BTC: 0.5, ETH: 0.3, USDC: 0.2 },
  { BTC: 0.6, ETH: 0.2, USDC: 0.2 },
  { slippage: 0.5, gasPrice: 'fast' },
  {
    triggeredBy: 'drift-detection-job',
    intentValidUntil: new Date(Date.now() + 48 * 60 * 60 * 1000) // 48h
  }
);

console.log(`Enqueued: ${entry.id}, Status: ${entry.status}`);

// 2. Mark as processing (typically done by processor job)
await rebalanceQueueService.markAsProcessing(entry.id);

// 3a. Record partial execution
const partialResult = await rebalanceQueueService.recordPartialExecution(
  entry.id,
  {
    queueEntryId: entry.id,
    totalExecuted: 65,
    expectedAmount: 100,
    filledPercentage: 65,
    transactionHash: '0xabc...',
    executionDetails: { /* ... */ }
  },
  { deferralThreshold: 75 }
);

// 3b. Or record failure
const failedResult = await rebalanceQueueService.recordFailedAttempt(
  entry.id,
  'Insufficient liquidity on DEX'
);

// 4. Check retry schedule
const retries = await rebalanceQueueService.getPendingRetries();
console.log(`${retries.length} entries ready for retry`);

// 5. View history
const history = await rebalanceQueueService.getExecutionHistory('vault-123', 50);
```

## Testing

See `__tests__/rebalanceQueue.test.ts` for comprehensive unit tests covering:
- Enqueueing and duplicate prevention
- Retry mechanisms and exponential backoff
- Partial execution handling
- Deferred follow-ups
- Stale intent rejection
- Conflict detection
- Status tracking

## Troubleshooting

### Issue: "Duplicate rebalance intent"
**Cause**: An identical rebalance is already queued for this vault in PENDING status.
**Solution**: Check existing entry status. Either wait for it to complete or cancel it.

### Issue: Entry stuck in PROCESSING
**Cause**: Job crashed or hung during execution.
**Solution**: Manually call `recordFailedAttempt()` to reschedule or mark as FAILED.

### Issue: Never retried despite failures
**Cause**: Intent expired before retry could execute.
**Solution**: Increase `intentValidUntil` when enqueueing, or ensure processor job runs more frequently.
