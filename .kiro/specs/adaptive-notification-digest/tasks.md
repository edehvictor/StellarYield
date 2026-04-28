# Implementation Plan: Adaptive Notification Digest

## Overview

Implement the digest pipeline as a set of TypeScript services and BullMQ jobs under `server/src/`. The pipeline flows: ingest → cluster → deduplicate → rank → format → deliver. Pure-function stages (clusterer, deduplicator, ranker, formatter) are implemented first so they can be property-tested in isolation, then wired together in `DigestBuilder`, followed by the scheduler and delivery layer.

## Tasks

- [x] 1. Define shared types and data models
  - Create `server/src/services/digest/types.ts` with all shared interfaces and union types: `NotificationEvent` (AlertEvent, RecommendationEvent, WatchlistEvent), `Cluster`, `RankedCluster`, `DigestPayload`, `RankedClusterEntry`, `ScheduleMode`, `ScheduleConfig`, `Decision`, `IngestResult`, `ConfigureResult`, `DeliveryResult`
  - Export `EventType`, `ScheduleMode`, and `Decision` as string literal union types
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 4.1, 5.1, 6.1, 6.2_

- [x] 2. Implement EventClusterer
  - [x] 2.1 Implement `clusterEvents` in `server/src/services/digest/EventClusterer.ts`
    - Group events by `(eventType, clusterKey)` where `clusterKey` is `vaultId` for alert/watchlist events and `sourceStrategyId:destinationStrategyId` for recommendation events
    - Accept a `windowMs` parameter (max 24 hours) and filter out events older than the window
    - Return one `Cluster` per distinct `(eventType, clusterKey)` pair
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 2.2 Write property test for EventClusterer — Property 3: Cluster count equals distinct (type, vaultId) pairs
    - **Property 3: Cluster count equals distinct (type, vaultId) pairs**
    - **Validates: Requirements 2.1, 2.6**

  - [ ]* 2.3 Write property test for EventClusterer — Property 4: Clustering preserves total event count
    - **Property 4: Clustering preserves total event count**
    - **Validates: Requirements 2.5**

- [x] 3. Implement Deduplicator
  - [x] 3.1 Implement `deduplicateCluster` in `server/src/services/digest/Deduplicator.ts`
    - For alert clusters: retain only the most recent event per `(condition, vaultId)` key
    - For recommendation clusters: retain only the most recent event per `(sourceStrategyId, destinationStrategyId)` key
    - For watchlist clusters: retain only the most recent event per `(vaultId, conditionDescription)` key
    - Never remove events that differ in condition, vaultId, or eventType
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 3.2 Write property test for Deduplicator — Property 5: Deduplication never increases event count
    - **Property 5: Deduplication never increases event count**
    - **Validates: Requirements 3.5**

  - [ ]* 3.3 Write property test for Deduplicator — Property 6: Deduplication retains only the most recent duplicate
    - **Property 6: Deduplication retains only the most recent duplicate**
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [ ]* 3.4 Write property test for Deduplicator — Property 7: Distinct events are never removed
    - **Property 7: Distinct events are never removed by deduplication**
    - **Validates: Requirements 3.4**

- [x] 4. Implement EventRanker
  - [x] 4.1 Implement `computeImportanceScore` and `rankEvents` in `server/src/services/digest/EventRanker.ts`
    - `computeImportanceScore`: returns a number in [0, 100]; for alerts use threshold deviation ratio; for recommendations score `HOLD/DEFER→MIGRATE` higher than the reverse; for watchlist use inverse of vault health score
    - `rankEvents`: sort clusters by `topImportanceScore` descending; break ties by most recent `triggeredAt`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ]* 4.2 Write property test for EventRanker — Property 8: Importance scores are always in [0, 100]
    - **Property 8: Importance scores are always in [0, 100]**
    - **Validates: Requirements 4.1**

  - [ ]* 4.3 Write property test for EventRanker — Property 9: Digest payload importance scores are non-increasing
    - **Property 9: Digest payload importance scores are non-increasing**
    - **Validates: Requirements 4.5, 4.7**

  - [ ]* 4.4 Write unit tests for EventRanker edge cases
    - Test `HOLD→MIGRATE` scores higher than `MIGRATE→HOLD`
    - Test tiebreaker: equal scores ordered by `triggeredAt` descending
    - _Requirements: 4.3, 4.6_

- [x] 5. Implement DigestFormatter
  - [x] 5.1 Implement `formatSummary` and `formatDigest` in `server/src/services/digest/DigestFormatter.ts`
    - `formatSummary` for AlertEvent: `"[condition] threshold of [thresholdValue] triggered for vault [vaultId]"`
    - `formatSummary` for RecommendationEvent: `"Recommendation changed from [previousDecision] to [newDecision] for strategy [sourceStrategyId] → [destinationStrategyId]"`
    - `formatSummary` for WatchlistEvent: `"Watchlist condition '[conditionDescription]' met for vault [vaultId]"`
    - `formatDigest`: produce `DigestPayload` with `walletAddress`, `generatedAt` (ISO 8601), `scheduleMode`, and ordered `clusters` array
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 5.2 Write property test for DigestFormatter — Property 13: Summary strings contain all interpolated values
    - **Property 13: Summary strings contain all interpolated values**
    - **Validates: Requirements 6.3, 6.4, 6.5**

  - [ ]* 5.3 Write property test for DigestFormatter — Property 12: DigestPayload JSON round-trip
    - **Property 12: DigestPayload JSON round-trip**
    - **Validates: Requirements 6.7**

- [x] 6. Checkpoint — pure pipeline tests
  - Ensure all tests pass for EventClusterer, Deduplicator, EventRanker, and DigestFormatter. Ask the user if questions arise.

- [x] 7. Implement DigestBuilder (orchestrator + Redis persistence)
  - [x] 7.1 Implement `DigestBuilder` class in `server/src/services/digest/DigestBuilder.ts`
    - `ingestEvent`: validate `walletAddress` is present (return `INVALID_EVENT` if missing), generate UUID v4 `eventId`, set `recordedAt` to current ISO 8601 timestamp, persist to Redis sorted set `digest:events:{walletAddress}` scored by `triggeredAt` ms
    - `buildDigest`: fetch events for `walletAddress` only, run `clusterEvents → deduplicateCluster → rankEvents → formatDigest` pipeline, return `DigestPayload`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 7.1, 7.2, 7.5_

  - [ ]* 7.2 Write property test for DigestBuilder — Property 1: Event ingestion preserves all required fields
    - **Property 1: Event ingestion preserves all required fields**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4**

  - [ ]* 7.3 Write property test for DigestBuilder — Property 2: Missing walletAddress is always rejected
    - **Property 2: Missing walletAddress is always rejected**
    - **Validates: Requirements 1.5**

  - [ ]* 7.4 Write property test for DigestBuilder — Property 10: User scope isolation
    - **Property 10: User scope isolation**
    - **Validates: Requirements 7.1, 7.2, 7.5**

  - [ ]* 7.5 Write unit test for empty event set handling
    - Verify `buildDigest` returns a `DigestPayload` with empty `clusters` array when no events are pending
    - _Requirements: 5.6_

- [x] 8. Implement DigestScheduler
  - [x] 8.1 Implement `DigestScheduler` class in `server/src/services/digest/DigestScheduler.ts`
    - `configure`: validate `mode` and `eventThreshold` (reject with `INVALID_THRESHOLD` if outside [1, 100]); persist `ScheduleConfig` to Redis hash `digest:schedule:{walletAddress}`; cancel existing BullMQ repeatable job for the user and register a new one
    - `getConfig`: retrieve `ScheduleConfig` from Redis
    - Add `DIGEST_GENERATION` and `DIGEST_THRESHOLD_CHECK` to `server/src/queues/types.ts`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 8.2 Write property test for DigestScheduler — Property 11: Threshold validation rejects out-of-range values
    - **Property 11: Threshold validation rejects out-of-range values**
    - **Validates: Requirements 8.2, 8.3**

  - [ ]* 8.3 Write unit tests for each schedule mode
    - Test `daily` mode creates a BullMQ repeatable job with 24-hour repeat
    - Test `weekly` mode creates a BullMQ repeatable job with 7-day repeat
    - Test `event_threshold` mode creates a threshold-check job
    - Test schedule update cancels old job and registers new one within 60 seconds
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 8.4_

- [x] 9. Implement DigestGenerationJob (BullMQ worker)
  - Create `server/src/jobs/digestSchedulerJob.ts` with a BullMQ `Worker` for the `digest-generation` queue
  - Worker processes `DigestJobData` (`walletAddress`, `scheduleMode`, `triggeredAt`): calls `DigestBuilder.buildDigest`, skips delivery if `clusters` is empty, otherwise calls `DigestDeliveryService.deliver`, appends ISO 8601 timestamp to `digest:audit:{walletAddress}` Redis list
  - Add a second worker for `digest-threshold-check` that polls pending event counts for `event_threshold` users and enqueues a `digest-generation` job when threshold is reached
  - _Requirements: 5.4, 5.5, 5.6, 5.7_

  - [ ]* 9.1 Write unit tests for DigestGenerationJob
    - Test skip-delivery path when `clusters` is empty
    - Test audit log entry is written on each triggered generation
    - _Requirements: 5.6, 5.7_

- [x] 10. Implement DigestDeliveryService and email template
  - [x] 10.1 Implement `DigestDeliveryService` class in `server/src/services/digest/DigestDeliveryService.ts`
    - `deliver`: look up registered email for `walletAddress`; if missing, log `MISSING_EMAIL` and return `ok: false`; otherwise call `renderHtml` and `sendEmail`
    - `renderHtml`: render `DigestPayload` to HTML using the digest email template
    - _Requirements: 6.6, 7.3, 7.4_

  - [x] 10.2 Create `server/src/templates/digestEmailTemplate.ts`
    - Export `renderDigestEmail(payload: DigestPayload): string` producing a styled HTML email
    - Group clusters by event type with human-readable section headers
    - Display `summary`, `eventCount`, and `topImportanceScore` for each cluster entry
    - _Requirements: 6.6_

  - [ ]* 10.3 Write unit tests for DigestDeliveryService
    - Test `MISSING_EMAIL` abort path: no email sent, error logged
    - Test `renderHtml` produces HTML containing payload data
    - _Requirements: 7.3, 7.4, 6.6_

- [x] 11. Wire everything together and add barrel exports
  - Create `server/src/services/digest/index.ts` exporting `DigestBuilder`, `DigestScheduler`, `DigestDeliveryService`, and all types
  - Register `DigestGenerationJob` worker in the server startup sequence (alongside existing workers)
  - Verify `DigestScheduler` is instantiated and `configure` is callable from the existing API layer
  - _Requirements: 5.5, 8.1_

- [x] 12. Final checkpoint — full suite
  - Ensure all tests pass across `server/src/__tests__/digest*.test.ts`. Confirm ≥90% line coverage for all digest service and job files. Ask the user if questions arise.
