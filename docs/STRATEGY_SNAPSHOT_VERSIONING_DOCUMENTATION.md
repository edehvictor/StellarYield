# Issue #282: Vault Strategy Snapshot Versioning System

## Overview

The Strategy Snapshot Versioning System provides immutable, audit-trailed snapshots of strategy configurations. This enables:

- **Version Control**: Each strategy change creates a new immutable version
- **Audit Trail**: Recommendations and rebalances are tied to the exact strategy version active at that time
- **Historical Replay**: Access to historical versions for compliance, debugging, and validation
- **Immutability**: Once active, versions cannot be modified
- **Change Tracking**: Full history of what changed, when, and why

## Architecture

### Data Model

```
StrategySnapshot
├── id: UUID (primary)
├── strategyId: String (identifies the strategy)
├── version: Int (incremental, per strategy)
├── name: String
├── description: String (optional)
├── keyWeights: JSON (IMMUTABLE snapshot)
│   └── Example: { "BTC": 0.4, "ETH": 0.3, "USDC": 0.3 }
├── riskParameters: JSON (IMMUTABLE snapshot)
│   └── Example: { "volatility": 0.25, "sharpeRatio": 1.5 }
├── constraints: JSON (IMMUTABLE snapshot)
│   └── Example: { "minAllocation": 0.05, "maxAllocation": 0.5 }
├── status: ACTIVE | SUPERSEDED | ARCHIVED
├── createdAt: DateTime
├── supersededAt: DateTime (when replaced)
├── supersededByVersion: Int (reference to newer version)
├── changeReason: String (why this version was created)
└── changeAuthor: String (who created it)

Unique Constraint: (strategyId, version)

StrategyVersionReference
├── id: UUID (primary)
├── strategySnapshotId: String (foreign key)
├── strategyId: String
├── snapshotVersion: Int (denormalized for queries)
├── recommendationId: String (optional, if used in recommendation)
├── rebalanceQueueId: String (optional, if used in rebalance)
├── eventType: RECOMMENDATION | REBALANCE | SNAPSHOT
├── linkedAt: DateTime
└── linkedBy: String (optional, who/what linked this)

StrategyVersionHistory
├── id: UUID (primary)
├── strategyId: String
├── versionChanges: JSON (detailed diff)
├── fromVersion: Int
├── toVersion: Int
├── changeType: WEIGHTS_UPDATE | CONSTRAINTS_UPDATE | PARAMETERS_UPDATE | FULL_REVISION
├── reason: String (why changed)
├── author: String (optional)
└── createdAt: DateTime
```

### Version Lifecycle

```
Version 1 (ACTIVE)
  └─→ [Change detected]
  └─→ Version 2 (ACTIVE)
      [Version 1 becomes SUPERSEDED, updated with supersededAt & supersededByVersion]
  └─→ [Time passes, archival policy]
  └─→ Version 2 (ARCHIVED), Version 3 (ACTIVE)
      └─→ etc.
```

## Core Concepts

### 1. Immutable Configuration Snapshots

When a version is created, the following are frozen:

```typescript
interface StrategySnapshot {
  keyWeights: {
    BTC: 0.4,
    ETH: 0.3,
    USDC: 0.3
  },
  riskParameters: {
    volatility: 0.25,
    sharpeRatio: 1.5,
    maxDrawdown: 0.10
  },
  constraints: {
    minAllocation: 0.05,
    maxAllocation: 0.5,
    rebalanceThreshold: 0.02
  }
}
```

These are NEVER modified after creation. If they need to change, a new version is created.

### 2. Version Supersession

When creating a new version:

1. Find the current ACTIVE version (if exists)
2. Create the new version in ACTIVE status
3. Update the previous version:
   - status → SUPERSEDED
   - supersededAt → now
   - supersededByVersion → new version number
4. Create a StrategyVersionHistory record documenting the change

### 3. Version References (Audit Linkage)

Every time a recommendation or rebalance occurs, it's linked to the active strategy version:

```typescript
// When recommendation is created
await strategySnapshotVersioningService.linkRecommendation(
  snapshotId,      // Which version was used
  recommendationId, // What recommended
  'recommendation-engine'
);

// When rebalance is created
await strategySnapshotVersioningService.linkRebalance(
  snapshotId,
  rebalanceQueueId,
  'drift-detection-job'
);
```

This creates a `StrategyVersionReference` record for audit purposes.

### 4. Change Detection

The system automatically detects what changed between versions:

- **WEIGHTS_UPDATE**: Only keyWeights changed
- **CONSTRAINTS_UPDATE**: Only constraints changed
- **PARAMETERS_UPDATE**: Only riskParameters changed
- **FULL_REVISION**: Multiple or all changed

```typescript
// Example: Detect change type
const previous = {
  keyWeights: { BTC: 0.4, ETH: 0.3 },
  riskParameters: { vol: 0.25 },
  constraints: { min: 0.05 }
};

const current = {
  keyWeights: { BTC: 0.5, ETH: 0.2 },  // CHANGED
  riskParameters: { vol: 0.25 },       // SAME
  constraints: { min: 0.05 }           // SAME
};

// Detected as: WEIGHTS_UPDATE
```

### 5. Historical Access for Audit and Replay

The system supports querying historical versions:

```typescript
// Get all versions of a strategy
const allVersions = await service.getAllVersions('strategy-1');
// Returns: [{v:1}, {v:2}, {v:3}] in descending order

// Get specific historical version
const v2Config = await service.getVersion('strategy-1', 2);
// Can replay recommendations with this exact config

// Verify what version was used
const wasV2Used = await service.verifyRecommendationVersion(
  'recommendation-123',
  'strategy-1',
  2
);
// Returns: true if that recommendation used version 2
```

## Security Guarantees

### Immutability

Once a version is created and marked ACTIVE, it **cannot be modified**:

- No updates to keyWeights, riskParameters, constraints
- No deletion of historical versions
- Status transitions are one-way: ACTIVE → SUPERSEDED → ARCHIVED

**Enforcement**: Application-level. Database has no update triggers; immutability is enforced by service layer.

### Audit Trail

Every version change is recorded with:
- What changed (detailed diff in `versionChanges`)
- Who made the change (`changeAuthor`)
- Why it changed (`changeReason`)
- When it changed (`createdAt`)

This enables full reconstruction of strategy evolution.

### Replay Prevention

By linking every recommendation and rebalance to a version:

```typescript
// Can verify: "Was this recommendation made with version 2?"
const isAuditValid = await service.verifyRecommendationVersion(
  'rec-123',
  'strategy-1',
  2
);

// Can get: "All recommendations that used version 2"
const recsUsingV2 = await service.getRecommendationsForVersion(
  'strategy-1',
  2
);
```

## API Reference

### StrategySnapshotVersioningService

#### `createSnapshot()`
```typescript
async createSnapshot(
  strategyId: string,
  name: string,
  keyWeights: Record<string, number>,
  riskParameters: Record<string, unknown>,
  constraints: Record<string, unknown>,
  options?: {
    description?: string;
    changeReason?: string;
    changeAuthor?: string;
  }
): Promise<StrategySnapshotDTO>

// Creates new version, supersedes previous, records change
// Returns new version in ACTIVE status
```

#### `getActiveVersion()`
```typescript
async getActiveVersion(strategyId: string): Promise<StrategySnapshotDTO | null>

// Returns current ACTIVE version
```

#### `getVersion()`
```typescript
async getVersion(
  strategyId: string,
  version: number
): Promise<StrategySnapshotDTO | null>

// Returns specific historical version (including SUPERSEDED/ARCHIVED)
```

#### `getAllVersions()`
```typescript
async getAllVersions(strategyId: string): Promise<StrategySnapshotDTO[]>

// Returns all versions in descending order
```

#### `linkRecommendation()`
```typescript
async linkRecommendation(
  strategySnapshotId: string,
  recommendationId: string,
  linkedBy?: string
): Promise<VersionReferenceDTO>

// Links recommendation to this version for audit
```

#### `linkRebalance()`
```typescript
async linkRebalance(
  strategySnapshotId: string,
  rebalanceQueueId: string,
  linkedBy?: string
): Promise<VersionReferenceDTO>

// Links rebalance to this version for audit
```

#### `getRecommendationsForVersion()`
```typescript
async getRecommendationsForVersion(
  strategyId: string,
  version: number
): Promise<VersionReferenceDTO[]>

// All recommendations that used this version
```

#### `getRebalancesForVersion()`
```typescript
async getRebalancesForVersion(
  strategyId: string,
  version: number
): Promise<VersionReferenceDTO[]>

// All rebalances that used this version
```

#### `getEventsForVersion()`
```typescript
async getEventsForVersion(
  strategyId: string,
  version: number
): Promise<VersionReferenceDTO[]>

// All events (recommendations + rebalances) for this version
```

#### `verifyRecommendationVersion()`
```typescript
async verifyRecommendationVersion(
  recommendationId: string,
  expectedStrategyId: string,
  expectedVersion: number
): Promise<boolean>

// Audit verification: "Was this recommendation made with version X?"
```

#### `verifyRebalanceVersion()`
```typescript
async verifyRebalanceVersion(
  rebalanceQueueId: string,
  expectedStrategyId: string,
  expectedVersion: number
): Promise<boolean>

// Audit verification: "Was this rebalance executed with version X?"
```

#### `getVersionHistory()`
```typescript
async getVersionHistory(strategyId: string): Promise<VersionChangeRecordDTO[]>

// Full change history with diffs
```

#### `getChangesBetweenVersions()`
```typescript
async getChangesBetweenVersions(
  strategyId: string,
  fromVersion: number,
  toVersion: number
): Promise<VersionChangeRecordDTO[]>

// Detailed changes between two specific versions
```

#### `archiveOldVersions()`
```typescript
async archiveOldVersions(
  strategyId: string,
  keepVersions: number = 10
): Promise<number>

// Archive versions older than keepVersions
// Returns count archived
// ACTIVE versions are never archived
```

#### `getVersionStatistics()`
```typescript
async getVersionStatistics(strategyId: string): Promise<{
  totalVersions: number;
  activeVersion: number;
  recommendationsCount: number;
  rebalancesCount: number;
  totalEventsCount: number;
}>
```

## Usage Example

```typescript
import { strategySnapshotVersioningService } from './services/strategySnapshotVersioningService';

// 1. Create initial strategy version
const v1 = await strategySnapshotVersioningService.createSnapshot(
  'strategy-conservative',
  'Conservative Portfolio',
  { BTC: 0.4, ETH: 0.3, USDC: 0.3 },
  { volatility: 0.25, sharpeRatio: 1.5 },
  { minAllocation: 0.05, maxAllocation: 0.5 },
  {
    description: 'Initial conservative allocation',
    changeAuthor: 'admin'
  }
);
// Result: v1.version = 1, v1.status = ACTIVE

// 2. Get active version
const active = await strategySnapshotVersioningService.getActiveVersion(
  'strategy-conservative'
);
// Result: Same as v1

// 3. Link a recommendation to the current version
await strategySnapshotVersioningService.linkRecommendation(
  active.id,
  'rec-abc123',
  'recommendation-engine'
);

// 4. Update strategy (market conditions change)
const v2 = await strategySnapshotVersioningService.createSnapshot(
  'strategy-conservative',
  'Conservative Portfolio - Adjusted',
  { BTC: 0.5, ETH: 0.2, USDC: 0.3 },
  { volatility: 0.25, sharpeRatio: 1.5 },
  { minAllocation: 0.05, maxAllocation: 0.5 },
  {
    changeReason: 'Increased BTC weight due to market volatility reduction',
    changeAuthor: 'bot-rebalancer'
  }
);
// Result: v2.version = 2, v2.status = ACTIVE
// v1 is now SUPERSEDED

// 5. Verify audit trail
const isV1Used = await strategySnapshotVersioningService
  .verifyRecommendationVersion('rec-abc123', 'strategy-conservative', 1);
// Result: true (recommendation was made with v1)

// 6. Get all recommendations using v1
const recsV1 = await strategySnapshotVersioningService
  .getRecommendationsForVersion('strategy-conservative', 1);
// Result: [{ recommendationId: 'rec-abc123', ... }]

// 7. View change history
const history = await strategySnapshotVersioningService
  .getVersionHistory('strategy-conservative');
// Result: [{ fromVersion: 1, toVersion: 2, changeType: 'WEIGHTS_UPDATE', ... }]

// 8. Get detailed changes
const changes = await strategySnapshotVersioningService
  .getChangesBetweenVersions('strategy-conservative', 1, 2);
// Result: Details of exactly what changed

// 9. Get statistics
const stats = await strategySnapshotVersioningService
  .getVersionStatistics('strategy-conservative');
// Result: { totalVersions: 2, activeVersion: 2, recommendationsCount: 1, ... }
```

## Integration with Rebalance Queue

The systems work together:

```typescript
// 1. Create strategy version
const snapshot = await strategySnapshotVersioningService.createSnapshot(
  strategyId,
  'v1',
  targetAllocations,
  riskParams,
  constraints
);

// 2. Enqueue rebalance
const queueEntry = await rebalanceQueueService.enqueueRebalance(
  vaultId,
  targetAllocations,
  currentAllocations,
  executionStrategy
);

// 3. Link rebalance to strategy version
await strategySnapshotVersioningService.linkRebalance(
  snapshot.id,
  queueEntry.id,
  'rebalance-processor'
);

// Later: Verify audit
const wasV1Used = await strategySnapshotVersioningService.verifyRebalanceVersion(
  queueEntry.id,
  strategyId,
  1
);
```

## Data Migration and Version Rollback

**Important**: Versions are immutable and cannot be rolled back at the database level.

**Migration approach**:
1. If critical bug found in current version, create a new version with fixes
2. Existing references to old version remain valid (immutability preserved)
3. New recommendations/rebalances use new version

**Example**:
```typescript
// v1 had bug in BTC weight calculation
// Don't modify v1 - create v2 with fix
const v2 = await strategySnapshotVersioningService.createSnapshot(
  'strategy-1',
  'Fixed BTC weight bug',
  { BTC: 0.42, ETH: 0.3, USDC: 0.28 },  // Corrected
  riskParams,
  constraints,
  { changeReason: 'Bugfix: BTC weight calculation corrected' }
);
// v1 remains unchanged, all history preserved
```

## Testing

See `__tests__/strategySnapshotVersioning.test.ts` for comprehensive unit tests covering:
- Version creation and supersession
- Immutability enforcement
- Version retrieval (current and historical)
- Reference linking (recommendations and rebalances)
- Change detection and history
- Audit verification
- Version statistics
- Archival

## Troubleshooting

### Issue: "Cannot modify historical version"
**Cause**: Trying to update a SUPERSEDED or ARCHIVED version.
**Solution**: Create a new version instead. Versions are immutable.

### Issue: Recommendation shows wrong version
**Cause**: Version reference wasn't linked when recommendation was created.
**Solution**: Link the reference immediately after creating the recommendation:
```typescript
await strategySnapshotVersioningService.linkRecommendation(
  activeSnapshot.id,
  newRecommendationId
);
```

### Issue: History is incomplete
**Cause**: Old versions were archived and removed.
**Solution**: Increase `keepVersions` in `archiveOldVersions()` or don't archive at all.

### Issue: Can't find events for a version
**Cause**: Version number might not match. Check:
- Get all versions: `getAllVersions(strategyId)`
- Verify specific version exists: `getVersion(strategyId, versionNumber)`
- Then query: `getEventsForVersion(strategyId, versionNumber)`
