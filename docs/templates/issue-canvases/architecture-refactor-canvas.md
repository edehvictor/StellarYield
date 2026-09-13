# Architecture & Refactoring Canvas: [Component / Subsystem Name]

> **Template Instructions**: Use this canvas when proposing major architectural reorganizations, Prisma schema updates, state reconciliation refactors, database index additions, or system-level dependency changes.

---

## Overview & Refactor Metadata

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Canvas Type** | `Architecture & Refactor Canvas` | System design and technical debt refactoring |
| **Issue / PR #** | `#[Issue Number]` | Associated GitHub issue |
| **Author / Lead** | `@[GitHub Handle]` | Technical lead / architect |
| **Scope** | `Frontend / Backend / Database / Monorepo` | Target architectural boundary |
| **Risk Level** | `Low` / `Medium` / `High` / `Critical` | System regression or migration risk |
| **Target Release** | `[e.g. v2.0.0 / Sprint 12]` | Target deployment milestone |
| **Performance Impact** | `Improved / Neutral / Monitored` | Expected throughput or latency change |
| **Downtime Requirement** | `Zero Downtime / Maintenance Window` | Deployment requirement |

---

## Current State & Motivation for Change

### Current Architecture & Limitations
Describe the existing implementation and why it is no longer adequate (e.g., performance bottlenecks, tight coupling, maintainability challenges, race conditions).

### Problem Statement
Identify the exact pain points, technical debt, or scalability ceilings being encountered.

> [!NOTE]
> Include latency metrics, query execution plans, or error rates to illustrate the motivation with concrete data.

---

## Target Architecture & System Boundaries

### High-Level Architecture Diagram
```
Before:
[Client] ----(Monolithic Handler)----> [Database]

After:
[Client] ---> [API Gateway / Router] ---> [Domain Service Layer] ---> [Prisma ORM] ---> [PostgreSQL]
                                     ---> [Event Queue / Indexer]
```

### Key Architectural Decisions
1. **Decoupling Strategy**: Separation of database queries into domain repository services.
2. **State Management**: Replacing polled queries with SSE / WebSocket reactive updates.
3. **Caching Strategy**: Redis/in-memory cache for static vault metadata with invalidation hooks.

---

## Schema, State & Data Migration Plan

### Database & Model Changes (Prisma)
```prisma
// Example Prisma Schema Diff
model YieldPosition {
  id          String   @id @default(uuid())
  vaultId     String
  userAddress String
  shares      Decimal  @db.Decimal(36, 18)
+ version     Int      @default(1)
+ lastSyncLedger BigInt
  updatedAt   DateTime @updatedAt
  
+ @@index([vaultId, userAddress])
}
```

### Migration Phasing Strategy
- **Phase 1 (Expand)**: Add new columns / models as nullable/defaulted without deleting old fields.
- **Phase 2 (Dual Write)**: Write to both old and new data structures simultaneously.
- **Phase 3 (Backfill)**: Run backfill script for historical data.
- **Phase 4 (Contract)**: Deprecate and safely remove legacy columns/models.

> [!WARNING]
> Database schema migrations must maintain zero-downtime compatibility with running server instances. Never drop active columns in the same release that introduces new code.

---

## API, Contract & Backward Compatibility

| Endpoint / Method | Change Type | Deprecation Schedule | Client Impact |
| :--- | :--- | :--- | :--- |
| `GET /api/v1/vaults` | Non-breaking | None (Payload enhanced) | Compatible |
| `POST /api/v1/rebalance` | Breaking | Deprecated in v1.4, removed in v2.0 | Update SDK caller |
| `VaultManager.soroban` | Interface parity | Kept backwards-compatible | Zero client change |

---

## Performance, Resource & Gas Impact

| Metric | Baseline (Current) | Target (Projected) | Verification Method |
| :--- | :--- | :--- | :--- |
| **API p95 Latency** | 350 ms | < 80 ms | Autocannon / K6 load testing |
| **DB Query Duration** | 120 ms | < 15 ms | `EXPLAIN ANALYZE` on indexed queries |
| **Memory Footprint** | 512 MB | < 300 MB | Node.js heap snapshot profile |
| **Soroban CPU Instructions** | 800k units | < 500k units | Soroban CLI gas measurement |

> [!TIP]
> Use `EXPLAIN ANALYZE` on PostgreSQL queries to confirm that new composite indexes eliminate sequential scans.

---

## Testing & Shadow Verification Strategy

- **Shadow Traffic / Replay**: Validate new pipeline against recorded historical transactions.
- **Drift Detection**: Automated scripts to verify consistency between old and new state representations.
- **Rollback Drills**: Rehearsal of migration reversal in local staging environment.

---

## Phased Execution & Rollback Plan

### Step-by-Step Execution Plan
1. **Preparation**: Merge schema changes and run database migrations.
2. **Service Deployment**: Deploy updated backend services behind feature flag.
3. **Validation**: Verify monitoring dashboards and error logs for 24 hours.
4. **Client Rollout**: Deploy frontend updates to consume new APIs.
5. **Cleanup**: Remove temporary feature flags and dual-read shims.

### Rollback Procedure
If p95 latency exceeds 500ms or error rates spike above 0.5%:
1. Flip feature flag `ENABLE_NEW_PIPELINE=false`.
2. Traffic reverts to legacy handler immediately.
3. Database changes remain non-destructive and backward-compatible.

---

## Acceptance Criteria Checklist

- [ ] New architecture conforms to modularity and separation of concerns principles.
- [ ] Prisma migrations tested locally with `npx prisma migrate dev` and verified against PostgreSQL.
- [ ] No breaking changes introduced without dual-write/read transition phases.
- [ ] Load and performance benchmarks meet or exceed projected targets.
- [ ] Automated integration test suite covers new service paths.
- [ ] Documentation updated across `docs/` and architecture guides.
