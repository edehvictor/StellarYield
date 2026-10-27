# Integration Guide: Rebalance Queue + Strategy Versioning

This document explains how the Rebalance Queue System (#281) and Strategy Snapshot Versioning System (#282) work together to provide a complete, auditable rebalancing workflow.

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│         Strategy Snapshot Versioning System (#282)          │
│                                                             │
│  Maintains immutable strategy configurations and          │
│  tracks which version was active for each decision        │
└─────────────────────────────────────────────────────────────┘
                          ↑                    ↓
                    Links to               Validates
                        ↓                      ↑
┌─────────────────────────────────────────────────────────────┐
│           Rebalance Queue System (#281)                     │
│                                                             │
│  Manages deferred execution, partial fills, and retries   │
│  of rebalance operations with full audit trail            │
└─────────────────────────────────────────────────────────────┘
```

## Complete Rebalance Workflow

### Phase 1: Strategy Decision

```
1. Strategy Engine evaluates market conditions
   ↓
2. Creates new Strategy Snapshot (version)
   └─ Immutable keyWeights, riskParameters, constraints frozen
   └─ Previous version superseded
   └─ Change logged in StrategyVersionHistory
   ↓
3. Version is ACTIVE and ready to use
```

**Code Example**:
```typescript
import { strategySnapshotVersioningService } from './services/strategySnapshotVersioningService';

const newStrategy = await strategySnapshotVersioningService.createSnapshot(
  'vault-strategy-1',
  'Q2 2024 Rebalance',
  { BTC: 0.45, ETH: 0.35, USDC: 0.20 },
  { volatility: 0.28, sharpeRatio: 1.8 },
  { minAllocation: 0.05, maxAllocation: 0.50 },
  {
    changeReason: 'Market volatility increased, reduced equity exposure',
    changeAuthor: 'strategy-optimizer'
  }
);

console.log(`Strategy v${newStrategy.version} created and ACTIVE`);
```

### Phase 2: Recommendation Generation

```
1. Recommendation Engine uses active strategy version
   ↓
2. Generates specific rebalance recommendations
   └─ e.g., "Reduce BTC from 0.5 to 0.45"
   ↓
3. Link recommendation to the strategy version used
   └─ Audit: "This recommendation was made with strategy v2"
   ↓
4. Store recommendation in database
```

**Code Example**:
```typescript
import { strategySnapshotVersioningService } from './services/strategySnapshotVersioningService';

// Get current strategy version
const activeStrategy = await strategySnapshotVersioningService
  .getActiveVersion('vault-strategy-1');

// Generate recommendation based on this version
const recommendation = await recommendationEngine.generate(
  vaultId,
  activeStrategy.keyWeights,
  marketData
);

// Link recommendation to the strategy version
await strategySnapshotVersioningService.linkRecommendation(
  activeStrategy.id,
  recommendation.id,
  'recommendation-engine'
);

console.log(`Recommendation ${recommendation.id} linked to strategy v${activeStrategy.version}`);
```

### Phase 3: Rebalance Enqueue

```
1. User/system decides to execute rebalance
   ↓
2. Extract target allocations from recommendation/strategy
   ↓
3. Enqueue rebalance with:
   - targetAllocations (from strategy)
   - currentAllocations (market data)
   - executionStrategy (slippage, gas params, etc.)
   └─ Intent hash generated: SHA256({vaultId, targetAllocations})
   └─ Intent expires in 24 hours
   ↓
4. Rebalance entry created in PENDING status
   └─ Duplicate check: No other PENDING entry with same intent
   └─ Conflict check: No overlapping allocations in progress
   ↓
5. Link rebalance to strategy version
   └─ Audit: "This rebalance was executed with strategy v2"
```

**Code Example**:
```typescript
import { rebalanceQueueService } from './services/rebalanceQueueService';
import { strategySnapshotVersioningService } from './services/strategySnapshotVersioningService';

// Get active strategy
const activeStrategy = await strategySnapshotVersioningService
  .getActiveVersion('vault-strategy-1');

// Validate no conflicting rebalances
const hasConflict = !(await rebalanceQueueService.validateNoConflictingEntries(
  vaultId,
  activeStrategy.keyWeights
));

if (hasConflict) {
  throw new Error('Conflicting rebalance already in progress');
}

// Enqueue the rebalance
const queueEntry = await rebalanceQueueService.enqueueRebalance(
  vaultId,
  activeStrategy.keyWeights,      // Target allocations from strategy
  currentAllocations,              // Current market state
  { slippage: 0.5, gasPrice: 'standard' },
  {
    triggeredBy: 'manual-user-request',
    intentValidUntil: new Date(Date.now() + 48 * 60 * 60 * 1000) // 48h
  }
);

// Link rebalance to strategy version for audit
await strategySnapshotVersioningService.linkRebalance(
  activeStrategy.id,
  queueEntry.id,
  'rebalance-enqueue'
);

console.log(`Rebalance ${queueEntry.id} queued with strategy v${activeStrategy.version}`);
```

### Phase 4: Execution and Processing

#### 4a. Full Execution Success

```
1. Processor job finds PENDING queue entry
   ↓
2. Attempts execution via contract/relayer
   ├─ Sends all target allocations
   ├─ Monitors blockchain confirmation
   ├─ Validates post-execution state
   ↓
3. Records execution result
   └─ filledPercentage: 100%
   └─ transactionHash: 0xabc...
   ↓
4. Updates entry to COMPLETED
   └─ RebalanceHistory record created
   └─ Audit trail complete
```

**Code Example**:
```typescript
import { rebalanceQueueService } from './services/rebalanceQueueService';

const queueEntry = await queueService.getPendingRetries()[0]; // Get entry to process

// Mark as processing
await rebalanceQueueService.markAsProcessing(queueEntry.id);

// Execute rebalance on-chain
const { txHash, amounts } = await executeRebalanceOnChain(
  vaultId,
  queueEntry.targetAllocations,
  queueEntry.executionStrategy
);

// Record successful execution
const result = await rebalanceQueueService.markAsCompleted(
  queueEntry.id,
  txHash
);

console.log(`Rebalance completed: ${result.id} → ${result.status}`);
```

#### 4b. Partial Execution

```
1. Execution attempt gets only 70% of intended allocation
   ├─ Market conditions prevent full execution
   ├─ Liquidity constraints
   ├─ MEV protection triggers
   ↓
2. Processor records partial result
   └─ filledPercentage: 70%
   └─ partialFillAmount: 70
   ├─ Check against threshold (75%)
   ├─ Below threshold? → Create deferred follow-up
   ↓
3. Original entry → PARTIAL status
   └─ Stores: partialFillAmount = 70
   └─ Stores: followUpEntryId = queue-2
   ↓
4. New deferred entry created (queue-2)
   └─ Status: PENDING
   └─ ExecutionType: DEFERRED
   └─ deferredUntil: now + 1 hour
   └─ Updated currentAllocations
   └─ Same intentHash pattern for linkage
   ↓
5. Audit trail
   └─ RebalanceHistory shows filledPercentage: 70
   └─ Parent entry links to follow-up entry
   └─ Strategy version still applies to follow-up
```

**Code Example**:
```typescript
import { rebalanceQueueService } from './services/rebalanceQueueService';

const queueEntry = await queueService.getPendingRetries()[0];

// Mark as processing
await rebalanceQueueService.markAsProcessing(queueEntry.id);

try {
  // Attempt execution
  const result = await executeRebalanceOnChain(
    vaultId,
    queueEntry.targetAllocations,
    queueEntry.executionStrategy
  );

  // Record partial result
  const partialResult = await rebalanceQueueService.recordPartialExecution(
    queueEntry.id,
    {
      queueEntryId: queueEntry.id,
      totalExecuted: 70,
      expectedAmount: 100,
      filledPercentage: 70,
      transactionHash: result.txHash,
      executionDetails: result
    },
    {
      minFillPercentage: 50,
      deferralThreshold: 75,
      retryDelayMs: 60000 // 1 minute
    }
  );

  console.log(`Partial execution: ${partialResult.id}`);
  if (partialResult.followUpEntryId) {
    console.log(`Follow-up created: ${partialResult.followUpEntryId}`);
  }
} catch (error) {
  // Record failure - will be retried
  await rebalanceQueueService.recordFailedAttempt(
    queueEntry.id,
    `Execution failed: ${error.message}`
  );
}
```

#### 4c. Failed Execution with Retry

```
1. Execution attempt fails (insufficient liquidity, etc.)
   ↓
2. Processor records failure
   └─ Check intent expiry (prevent replay)
   ├─ If expired → Mark FAILED, no retry
   ├─ If valid → Schedule retry
   ↓
3. Calculate next retry time
   └─ Attempt 1 failed: retry in 60 seconds
   └─ Attempt 2 failed: retry in 120 seconds (exponential)
   └─ Attempt 3 failed: Mark FAILED (exceeded maxRetries)
   ↓
4. Entry remains in PENDING status
   └─ nextRetryAt set
   └─ lastError stored
   ↓
5. Processor job runs in 30s intervals
   └─ Checks for PENDING entries with nextRetryAt ≤ now
   └─ Retries automatically
   └─ Exponential backoff prevents thrashing
```

**Code Example**:
```typescript
import { rebalanceQueueService } from './services/rebalanceQueueService';

const queueEntry = await queueService.getPendingRetries()[0];

try {
  await rebalanceQueueService.markAsProcessing(queueEntry.id);
  // ... execution attempt ...
} catch (error) {
  // Record failure
  const updated = await rebalanceQueueService.recordFailedAttempt(
    queueEntry.id,
    `Insufficient liquidity: ${error.message}`,
    { maxRetries: 3, retryDelayMs: 60000 }
  );

  if (updated.status === REBALANCE_STATUS.PENDING) {
    console.log(`Scheduled retry in ${updated.nextRetryAt}`);
  } else if (updated.status === REBALANCE_STATUS.FAILED) {
    console.log(`Max retries exceeded: ${updated.lastError}`);
  }
}
```

### Phase 5: Audit and Verification

```
1. Query audit trail for rebalance
   ├─ Get rebalance history
   ├─ Check all partial executions
   ├─ Verify final status
   ↓
2. Verify strategy version used
   ├─ Query StrategyVersionReference
   ├─ Confirm which version was active
   ├─ Review version history showing what changed
   ↓
3. Reconstruct decision context
   ├─ Recommendation that prompted rebalance
   ├─ Strategy version parameters at decision time
   ├─ Market conditions (stored in history)
   ↓
4. Full traceability for compliance
   └─ Who requested? (triggeredBy)
   └─ When did it happen? (createdAt, completedAt)
   └─ What was the decision? (strategy version)
   └─ How was it executed? (execution history)
```

**Code Example**:
```typescript
import { rebalanceQueueService } from './services/rebalanceQueueService';
import { strategySnapshotVersioningService } from './services/strategySnapshotVersioningService';

const queueEntryId = 'queue-123';
const strategyId = 'strategy-1';

// 1. Get rebalance history
const history = await rebalanceQueueService.getExecutionHistory(vaultId);
console.log(`Rebalance history: ${history.length} entries`);

// 2. Verify strategy version
const wasV2Used = await strategySnapshotVersioningService.verifyRebalanceVersion(
  queueEntryId,
  strategyId,
  2
);
console.log(`Rebalance used strategy v2: ${wasV2Used}`);

// 3. Get strategy version details
const strategyV2 = await strategySnapshotVersioningService.getVersion(strategyId, 2);
console.log(`Strategy v2 keyWeights:`, strategyV2.keyWeights);
console.log(`Strategy v2 created: ${strategyV2.createdAt}`);
console.log(`Strategy v2 change reason: ${strategyV2.changeReason}`);

// 4. Get all rebalances using this version
const rebalancesV2 = await strategySnapshotVersioningService
  .getRebalancesForVersion(strategyId, 2);
console.log(`${rebalancesV2.length} rebalances used strategy v2`);
```

## Security Guarantees

### 1. Replay Prevention

**Problem**: An attacker could try to replay an old rebalance with stale market data.

**Solution**:
- Each intent has `intentValidUntil` (default 24 hours)
- If retry attempts after expiry, execution is rejected
- Entry marked FAILED with error: "Intent expired - replay prevention triggered"

```typescript
// Example: Stale intent detection
if (queueEntry.intentValidUntil < now) {
  // Reject: Don't retry, mark as failed
  recordFailedAttempt(queueEntry.id, 'Intent expired - replay prevention triggered');
}
```

### 2. Duplicate Prevention

**Problem**: Same rebalance submitted twice could execute twice.

**Solution**:
- Intent hash: SHA256({vaultId, targetAllocations})
- Unique constraint: (intentHash, vaultId)
- If duplicate detected, error returned pointing to existing entry

```typescript
// Example: Duplicate prevention
const existingEntry = await prisma.rebalanceQueueEntry.findUnique({
  where: { intentHash_vaultId: { intentHash, vaultId } }
});

if (existingEntry?.status === PENDING) {
  throw new Error(`Duplicate intent. Existing entry: ${existingEntry.id}`);
}
```

### 3. Conflict Prevention

**Problem**: Two different rebalances could conflict if executed simultaneously.

**Solution**:
- Check for overlapping PENDING/PROCESSING entries with different target allocations
- Prevent enqueueing if conflict detected

```typescript
// Example: Conflict detection
const activeEntries = await prisma.rebalanceQueueEntry.findMany({
  where: { vaultId, status: { in: [PENDING, PROCESSING] } }
});

for (const entry of activeEntries) {
  if (entry.targetAllocations !== newTargetAllocations) {
    throw new Error('Conflicting rebalance already in progress');
  }
}
```

### 4. Immutable Strategy Versions

**Problem**: Historical data could be modified for nefarious reasons.

**Solution**:
- Versions marked ACTIVE are never updated
- Historical versions immutable by design
- Only creation and status transitions allowed

```typescript
// Immutability enforced at application level
// Database structure prevents updates to immutable fields
const createSnapshot = async (...) => {
  // Creates new version, never modifies existing
  const newVersion = await db.strategySnapshot.create({ ... });
  
  // Previous version superseded but not modified
  await db.strategySnapshot.update({
    where: { id: oldVersion.id },
    data: { 
      status: 'SUPERSEDED',
      supersededAt: now,
      supersededByVersion: newVersion.version
    }
  });
};
```

## Operational Procedures

### Starting the System

```typescript
import { startRebalanceQueueProcessorJob } from './jobs/rebalanceQueueProcessorJob';

// Start the background processor
startRebalanceQueueProcessorJob({
  enabled: true,
  batchSize: 10,              // Process 10 per run
  enableRetries: true,        // Enable automatic retries
  enableDeferredProcessing: true,
  partialFillConfig: {
    minFillPercentage: 50,
    maxRetries: 3,
    retryDelayMs: 60000,      // 1 minute base
    deferralThreshold: 75
  },
  logResults: true
});

console.log('Rebalance queue processor started');
```

### Monitoring Queue Status

```typescript
import { rebalanceQueueService } from './services/rebalanceQueueService';

// Check queue status for a vault
const status = await rebalanceQueueService.getQueueStatus(vaultId);

console.log(`Pending: ${status.pendingCount}`);
console.log(`Processing: ${status.processingCount}`);
console.log(`Partial: ${status.partialCount}`);
console.log(`Failed: ${status.failedCount}`);
console.log(`Deferred: ${status.deferredCount}`);

// Alert if too many failures
if (status.failedCount > 5) {
  sendAlert('High rebalance failure rate detected');
}
```

### Manual Intervention

```typescript
import { rebalanceQueueService } from './services/rebalanceQueueService';

// Cancel a stuck entry
await rebalanceQueueService.cancelEntry(
  queueEntryId,
  'Manual cancellation due to market conditions'
);

// Mark as completed manually (if execution happened off-chain)
await rebalanceQueueService.markAsCompleted(
  queueEntryId,
  '0xtxhash...'
);

// Trigger immediate processing (normally runs on interval)
import { triggerQueueProcessing } from './jobs/rebalanceQueueProcessorJob';
const result = await triggerQueueProcessing(5); // Process 5 items
```

## Testing Strategy

Both systems have comprehensive test coverage:

1. **Unit Tests**: Core logic, edge cases
2. **Integration Tests**: Queue + Versioning together
3. **Scenario Tests**: Real-world workflows

```bash
# Run unit tests
npm test -- rebalanceQueue.test.ts
npm test -- strategySnapshotVersioning.test.ts

# Run integration tests  
npm test -- rebalanceQueueIntegration.test.ts

# Run all tests with coverage
npm test -- --coverage
```

## Performance Considerations

### Query Optimization

```typescript
// Index strategy on (strategyId, status) for quick lookups
await service.getActiveVersion(strategyId);
// Uses: @@index([strategyId, status])

// Index rebalance on (vaultId, status) for queue processing
await service.getPendingRetries();
// Uses: @@index([status, nextRetryAt])
```

### Batch Processing

```typescript
// Processor handles in batches, not one-by-one
const config = {
  batchSize: 10,  // Process 10 items per interval
};

// Runs every 30 seconds, avoiding overload
startRebalanceQueueProcessorJob(config);
```

## Troubleshooting Guide

### Queue stuck in PROCESSING

**Symptom**: Entry marked PROCESSING for hours

**Diagnosis**:
```typescript
const stuck = await prisma.rebalanceQueueEntry.findFirst({
  where: {
    status: REBALANCE_STATUS.PROCESSING,
    updatedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } // > 1 hour
  }
});
```

**Solution**: Manually record failure and reschedule:
```typescript
await rebalanceQueueService.recordFailedAttempt(
  stuck.id,
  'Processor hung - manual intervention'
);
```

### Strategy version mismatch

**Symptom**: Recommendation linked to wrong version

**Diagnosis**:
```typescript
const ref = await service.verifyRecommendationVersion(
  recommendationId,
  strategyId,
  expectedVersion
);
if (!ref) console.log('Version mismatch!');
```

**Solution**: Verify linking is done immediately after creating recommendation.

### Too many deferred entries

**Symptom**: Queue backing up with deferred items

**Diagnosis**:
```typescript
const deferred = await service.getDeferredEntries();
console.log(`${deferred.length} deferred entries waiting`);
```

**Solution**: Check execution function for systematic failures. May need to adjust `deferralThreshold` or `retryDelayMs`.
