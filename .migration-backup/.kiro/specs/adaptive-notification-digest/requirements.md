# Requirements Document

## Introduction

The Adaptive Notification Digest Builder replaces per-event individual notifications with intelligently grouped digest messages. Instead of sending every alert, recommendation change, or watchlist trigger as a separate email, the system clusters related events by type and importance, ranks them, and delivers a single cohesive digest on a user-configured schedule (daily, weekly, or event-threshold-based). The digest must be scoped strictly to the requesting user's data to prevent cross-user data leakage.

## Glossary

- **Digest_Builder**: The service responsible for collecting, clustering, deduplicating, ranking, and formatting notification events into a digest payload.
- **Digest_Scheduler**: The job scheduler responsible for triggering digest generation and delivery on configured schedules (daily, weekly, event-threshold).
- **Digest_Delivery_Service**: The service responsible for sending formatted digest payloads to users via email or other notification channels.
- **Event_Clusterer**: The component within Digest_Builder that groups related notification events by type, vault, and time proximity.
- **Event_Ranker**: The component within Digest_Builder that assigns importance scores to clustered events and orders them highest-first.
- **Deduplicator**: The component within Digest_Builder that removes duplicate or superseded events within a cluster before ranking.
- **Digest_Payload**: The structured output of Digest_Builder containing ranked, deduplicated, and formatted event clusters for a single user.
- **Notification_Event**: A raw event record representing a triggered alert, recommendation change, or watchlist trigger for a specific user and vault.
- **Alert_Event**: A Notification_Event of type `alert`, produced when a vault metric crosses a user-defined threshold.
- **Recommendation_Event**: A Notification_Event of type `recommendation`, produced when the migration optimizer changes its decision for a user's position.
- **Watchlist_Event**: A Notification_Event of type `watchlist`, produced when a vault on a user's watchlist meets a monitored condition.
- **Digest_Schedule**: A user-level configuration specifying the delivery cadence: `daily`, `weekly`, or `event_threshold`.
- **Event_Threshold**: The minimum number of pending Notification_Events that triggers an immediate digest delivery outside the regular schedule.
- **User_Scope**: The set of walletAddress-bound data records that belong exclusively to one user. No digest may include events from outside the requesting user's User_Scope.
- **Importance_Score**: A numeric value (0–100) assigned to each Notification_Event by Event_Ranker, used to order events within a Digest_Payload.
- **Cluster**: A group of Notification_Events of the same type and vault, collected within a configurable time window.

---

## Requirements

### Requirement 1: Notification Event Ingestion

**User Story:** As a platform, I want to record notification events as they occur, so that the Digest_Builder has a reliable source of events to process.

#### Acceptance Criteria

1. WHEN an alert threshold is crossed for a user, THE Digest_Builder SHALL record an Alert_Event containing the walletAddress, vaultId, condition, thresholdValue, and triggeredAt timestamp.
2. WHEN the migration optimizer changes its decision for a user's position, THE Digest_Builder SHALL record a Recommendation_Event containing the walletAddress, sourceStrategyId, destinationStrategyId, previous decision, new decision, and recordedAt timestamp.
3. WHEN a watchlist condition is met for a vault a user is monitoring, THE Digest_Builder SHALL record a Watchlist_Event containing the walletAddress, vaultId, condition description, and triggeredAt timestamp.
4. THE Digest_Builder SHALL persist each Notification_Event with a unique event identifier, event type, walletAddress, and ISO 8601 timestamp.
5. IF a Notification_Event is received with a missing walletAddress, THEN THE Digest_Builder SHALL reject the event and return an `INVALID_EVENT` error code.

---

### Requirement 2: Event Clustering

**User Story:** As a user, I want related notifications grouped together, so that I receive a coherent summary rather than a flood of individual messages.

#### Acceptance Criteria

1. THE Event_Clusterer SHALL group Notification_Events into Clusters by matching event type and vaultId within a configurable time window of at most 24 hours.
2. WHEN two or more Alert_Events share the same walletAddress, vaultId, and condition within the clustering time window, THE Event_Clusterer SHALL merge them into a single Cluster.
3. WHEN two or more Recommendation_Events share the same walletAddress, sourceStrategyId, and destinationStrategyId within the clustering time window, THE Event_Clusterer SHALL merge them into a single Cluster.
4. WHEN two or more Watchlist_Events share the same walletAddress and vaultId within the clustering time window, THE Event_Clusterer SHALL merge them into a single Cluster.
5. THE Event_Clusterer SHALL preserve all individual event records within a Cluster so that the Deduplicator can process them.
6. THE Event_Clusterer SHALL produce a Cluster count equal to the number of distinct (type, vaultId) pairs present in the input event set for a given user.

---

### Requirement 3: Event Deduplication

**User Story:** As a user, I want redundant or superseded notifications removed from my digest, so that I only see meaningful, non-repetitive information.

#### Acceptance Criteria

1. WHEN a Cluster contains multiple Alert_Events for the same condition and vaultId, THE Deduplicator SHALL retain only the most recent Alert_Event and discard earlier duplicates.
2. WHEN a Cluster contains multiple Recommendation_Events for the same strategy pair, THE Deduplicator SHALL retain only the latest Recommendation_Event reflecting the current decision and discard superseded ones.
3. WHEN a Cluster contains multiple Watchlist_Events for the same vaultId and condition description, THE Deduplicator SHALL retain only the most recent Watchlist_Event.
4. THE Deduplicator SHALL not remove events that differ in condition, vaultId, or event type, even if they share a walletAddress.
5. FOR ALL input Clusters, the count of events output by the Deduplicator SHALL be less than or equal to the count of events in the input Cluster (deduplication never increases event count).

---

### Requirement 4: Event Ranking

**User Story:** As a user, I want the most important changes shown first in my digest, so that I can quickly identify what requires my attention.

#### Acceptance Criteria

1. THE Event_Ranker SHALL assign an Importance_Score between 0 and 100 (inclusive) to each deduplicated Notification_Event.
2. THE Event_Ranker SHALL assign a higher Importance_Score to Alert_Events where the triggered threshold deviation is larger relative to the current vault metric value.
3. THE Event_Ranker SHALL assign a higher Importance_Score to Recommendation_Events where the decision changes from `HOLD` or `DEFER` to `MIGRATE` than to changes in the opposite direction.
4. THE Event_Ranker SHALL assign a higher Importance_Score to Watchlist_Events for vaults with a lower health score.
5. THE Event_Ranker SHALL order events within a Digest_Payload from highest Importance_Score to lowest.
6. WHEN two events share the same Importance_Score, THE Event_Ranker SHALL order them by triggeredAt timestamp, most recent first.
7. FOR ALL Digest_Payloads, the sequence of Importance_Scores SHALL be non-increasing from first to last event.

---

### Requirement 5: Digest Scheduling

**User Story:** As a user, I want to receive digests on a schedule I choose, so that notifications arrive at a time and frequency that suits my workflow.

#### Acceptance Criteria

1. THE Digest_Scheduler SHALL support three Digest_Schedule modes: `daily`, `weekly`, and `event_threshold`.
2. WHEN a user's Digest_Schedule is set to `daily`, THE Digest_Scheduler SHALL trigger digest generation once every 24 hours at the user's configured delivery time.
3. WHEN a user's Digest_Schedule is set to `weekly`, THE Digest_Scheduler SHALL trigger digest generation once every 7 days on the user's configured day and time.
4. WHEN a user's Digest_Schedule is set to `event_threshold` and the count of pending Notification_Events for that user reaches or exceeds the configured Event_Threshold, THE Digest_Scheduler SHALL trigger digest generation within 5 minutes of the threshold being crossed.
5. THE Digest_Scheduler SHALL use BullMQ repeatable jobs to persist schedule state across service restarts.
6. IF a user has no pending Notification_Events at the scheduled trigger time, THEN THE Digest_Scheduler SHALL skip digest generation and delivery for that cycle without producing an error.
7. THE Digest_Scheduler SHALL record the timestamp of each triggered digest generation in a durable store for auditability.

---

### Requirement 6: Digest Formatting

**User Story:** As a user, I want my digest to be clearly formatted and easy to read, so that I can quickly understand the grouped notifications.

#### Acceptance Criteria

1. THE Digest_Builder SHALL produce a Digest_Payload as a structured JSON object containing: walletAddress, generatedAt (ISO 8601), scheduleMode, and an ordered array of ranked event clusters.
2. EACH cluster entry in the Digest_Payload SHALL include: event type, vaultId (where applicable), Importance_Score of the top event, event count, and a human-readable summary string.
3. THE Digest_Builder SHALL format the human-readable summary string for Alert_Events as: `"[condition] threshold of [thresholdValue] triggered for vault [vaultId]"`.
4. THE Digest_Builder SHALL format the human-readable summary string for Recommendation_Events as: `"Recommendation changed from [previousDecision] to [newDecision] for strategy [sourceStrategyId] → [destinationStrategyId]"`.
5. THE Digest_Builder SHALL format the human-readable summary string for Watchlist_Events as: `"Watchlist condition '[conditionDescription]' met for vault [vaultId]"`.
6. THE Digest_Delivery_Service SHALL render the Digest_Payload into an HTML email template before delivery.
7. FOR ALL valid Digest_Payloads, serializing to JSON and then deserializing SHALL produce an equivalent Digest_Payload (round-trip property).

---

### Requirement 7: User Scope Isolation

**User Story:** As a user, I want my digest to contain only my own notifications, so that my data is never exposed to other users.

#### Acceptance Criteria

1. THE Digest_Builder SHALL filter all Notification_Events by walletAddress before clustering, ranking, or formatting, ensuring only events belonging to the requesting user are included.
2. WHEN generating a Digest_Payload for a given walletAddress, THE Digest_Builder SHALL not include any Notification_Event whose walletAddress does not exactly match the requested walletAddress.
3. THE Digest_Delivery_Service SHALL deliver each Digest_Payload only to the email address registered for the walletAddress that owns the digest.
4. IF a Digest_Payload is requested for a walletAddress that has no registered email address, THEN THE Digest_Delivery_Service SHALL abort delivery and log a `MISSING_EMAIL` error without sending any message.
5. THE Digest_Builder SHALL not expose vault data, strategy data, or event data from one user's scope in any Digest_Payload generated for a different user.

---

### Requirement 8: Digest Schedule Configuration

**User Story:** As a user, I want to configure my digest schedule and event threshold, so that I control when and how often I receive digests.

#### Acceptance Criteria

1. THE Digest_Scheduler SHALL allow a user to set their Digest_Schedule mode to `daily`, `weekly`, or `event_threshold` via an API endpoint.
2. WHEN a user sets the `event_threshold` mode, THE Digest_Scheduler SHALL require the user to provide an Event_Threshold value between 1 and 100 (inclusive).
3. IF a user submits a Digest_Schedule configuration with an Event_Threshold outside the range 1–100, THEN THE Digest_Scheduler SHALL reject the request and return an `INVALID_THRESHOLD` error code.
4. WHEN a user updates their Digest_Schedule, THE Digest_Scheduler SHALL cancel the previous repeatable job and register a new repeatable job reflecting the updated configuration within 60 seconds.
5. THE Digest_Scheduler SHALL persist each user's Digest_Schedule configuration in a durable store so that schedules survive service restarts.

---

### Requirement 9: Test Coverage

**User Story:** As a developer, I want comprehensive automated tests for all digest components, so that regressions are caught before deployment.

#### Acceptance Criteria

1. THE test suite SHALL achieve a minimum of 90% line coverage across all files in the `services/` and `jobs/` directories related to the digest feature.
2. THE test suite SHALL include property-based tests for Event_Clusterer verifying that the output Cluster count equals the number of distinct (type, vaultId) pairs in any input event set.
3. THE test suite SHALL include property-based tests for Deduplicator verifying that output event count is always less than or equal to input event count for any input Cluster.
4. THE test suite SHALL include property-based tests for Event_Ranker verifying that the Importance_Score sequence in any output Digest_Payload is non-increasing.
5. THE test suite SHALL include a round-trip property test verifying that serializing a Digest_Payload to JSON and deserializing it produces an equivalent object.
6. THE test suite SHALL include unit tests for each Digest_Schedule mode (`daily`, `weekly`, `event_threshold`) verifying correct trigger behavior.
7. THE test suite SHALL include unit tests for User_Scope isolation verifying that events from one walletAddress are never included in a Digest_Payload for a different walletAddress.
