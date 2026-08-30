# feat(drift): add drift anomaly grouping across portfolio, vault, and strategy services

## Description

### Context & Problem
Previously, drift alerts emitted by different monitoring domains (portfolio attribution, vault pressure & allocation, strategy health & execution) operated in silos. When an underlying systemic event occurred (such as high market volatility, an oracle disruption, a sudden liquidity drain, or an execution failure), each subsystem produced separate, uncoordinated warning signals. This created noisy, duplicated alerts where the same root cause appeared as multiple isolated issues without clear causal relationships.

### Solution Overview
This PR introduces a unified **Drift Anomaly Grouping Engine** (`DriftAnomalyGrouper` and extended `DriftService`) that aggregates, correlates, deduplicates, and structures drift signals across portfolio, vault, and strategy services.

### Key Capabilities Implemented

1. **Multi-Dimensional Signal Grouping**:
   - Standardized `DriftSignal` schema with domain source (`portfolio`, `vault`, `strategy`), sub-source, asset identifier, metric, deviation, severity band (`INFO`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`), timestamp, explicit `rootCauseId`, and hierarchical `parentSignalId`.
   - Flexible grouping strategies: `bySourceAssetSeverity` (default), `byAssetAndProximity`, `byRootCause`, and `hierarchical`.

2. **Duplicate Signal Suppression**:
   - Detects repeated signals within a configurable deduplication window (`dedupWindowMs`, default 10 minutes).
   - Coalesces rapid polling duplicates into a single anomaly entity while tracking `duplicateCount`, `uniqueSignalCount`, and retaining the peak deviation observed.

3. **Overlapping Temporal & Multi-Metric Correlation**:
   - Merges related multi-metric signals (e.g., allocation drift + outflow surge + low inflow) occurring on the same asset within `correlationWindowMs` (default 15 minutes).
   - Automatically determines aggregate group severity (highest constituent severity wins) and synthesizes human-readable root cause summaries and recommended actions.

4. **Hierarchical Nested Anomalies (Causal Relationships)**:
   - Evaluates `parentSignalId` references to construct multi-tier parent-child nested anomaly structures (e.g. Strategy failure → Vault outflow surge → Portfolio concentration drift).
   - Preserves complete source count and severity breakdowns at every level of the hierarchy.

5. **Service Signal Extractors**:
   - `VaultPressureService`: `extractPressureDriftSignals()` transforms elevated, high, and critical flow velocities into standardized drift signals.
   - `PortfolioAttributionService`: `extractAttributionDriftSignals()` maps low data completeness and decision confidence deficits into drift signals.
   - `StrategyHealthService`: `extractStrategyHealthDriftSignals()` maps degraded/critical health statuses, error spikes, and provider uptime drops into drift signals.
   - `DriftService`: `convertVaultDriftToSignals()` and `evaluateGroupedDriftEvents()` orchestrate combined evaluation and database persistence.

6. **REST API & OpenAPI Documentation**:
   - `POST /api/drift/group`: Ad-hoc grouping of arbitrary drift signal payloads.
   - `POST /api/drift/evaluate`: Evaluates vault USD allocations and external signals, updates state, and returns grouped anomalies.
   - `GET /api/drift/anomalies`: Queries active grouped anomalies with optional filtering by `source`, `severity`, or `asset`.
   - Documented in `server/openapi.yaml`.

---

## Type of Change
- [x] New feature (non-breaking change which adds functionality)
- [x] Bug fix / Code cleanup (fixed pre-existing compilation & route typing issues)
- [x] Documentation update (OpenAPI spec & types)

---

## Verification Commands & Results

### 1. Test Suite Execution
```bash
npx jest src/__tests__/duplicateOverlappingNestedSignals.test.ts src/__tests__/driftAnomalyGrouping.test.ts src/__tests__/driftService.test.ts
```
**Result**:
```
PASS src/__tests__/duplicateOverlappingNestedSignals.test.ts
PASS src/__tests__/driftService.test.ts
PASS src/__tests__/driftAnomalyGrouping.test.ts

Test Suites: 3 passed, 3 total
Tests:       22 passed, 22 total
Snapshots:   0 total
Time:        3.189 s
```

### 2. TypeScript Compilation & Build
```bash
npm run build
```
**Result**: Exited with code `0` (`tsc -p tsconfig.build.json` succeeded without errors).

### 3. OpenAPI Drift Verification
```bash
npm run check:openapi
```
**Result**: `/api/drift` endpoints verified and documented.

---

## UI Snapshot Checklist
- [x] No visual changes (Backend service & API changes only)

---

## Checklist
- [x] My code follows the style guidelines of this project
- [x] I have performed a self-review of my own code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have made corresponding changes to the documentation (OpenAPI spec)
- [x] My changes generate no new warnings or leaks