// Shared types and data models for the Adaptive Notification Digest feature

export type EventType = "alert" | "recommendation" | "watchlist";

export type ScheduleMode = "daily" | "weekly" | "event_threshold";

export type Decision = "MIGRATE" | "HOLD" | "DEFER";
export type WatchlistDigestTrigger =
  | "apy_change"
  | "risk_change"
  | "freshness_change"
  | "alert_triggered";

export interface AlertEvent {
  eventId: string;
  eventType: "alert";
  walletAddress: string;
  vaultId: string;
  condition: string;
  thresholdValue: number;
  currentValue: number;
  triggeredAt: string;
  recordedAt: string;
}

export interface RecommendationEvent {
  eventId: string;
  eventType: "recommendation";
  walletAddress: string;
  sourceStrategyId: string;
  destinationStrategyId: string;
  previousDecision: Decision;
  newDecision: Decision;
  recordedAt: string;
  triggeredAt: string;
}

export interface WatchlistEvent {
  eventId: string;
  eventType: "watchlist";
  walletAddress: string;
  vaultId: string;
  trigger: WatchlistDigestTrigger;
  severity: "info" | "warning" | "critical";
  conditionDescription: string;
  previousValue?: number | null;
  currentValue?: number | null;
  triggeredAt: string;
  recordedAt: string;
}

export type NotificationEvent =
  | AlertEvent
  | RecommendationEvent
  | WatchlistEvent;

export interface Cluster {
  eventType: EventType;
  clusterKey: string;
  vaultId?: string;
  events: NotificationEvent[];
}

export interface RankedCluster extends Cluster {
  topImportanceScore: number;
  summary: string;
}

export interface RankedClusterEntry {
  eventType: EventType;
  vaultId?: string;
  topImportanceScore: number;
  eventCount: number;
  summary: string;
}

export interface DigestPayload {
  walletAddress: string;
  generatedAt: string;
  scheduleMode: ScheduleMode;
  clusters: RankedClusterEntry[];
}

export interface ScheduleConfig {
  walletAddress: string;
  mode: ScheduleMode;
  timezone?: string;
  deliveryTime?: string;
  dayOfWeek?: number;
  eventThreshold?: number;
  updatedAt: string;
}

export interface WatchlistDigestPreference {
  enabled: boolean;
  scheduleMode: ScheduleMode;
  eventThreshold: number;
  watchedVaultIds: string[];
  minApyDeltaPct: number;
  minRiskDelta: number;
  maxFreshnessHours: number;
}

export type DeliveryFailureStatus = "temporary" | "retry_exhausted" | "terminal";

export interface DeliveryRetryMetadata {
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
  backoffMs: number;
  status: DeliveryFailureStatus;
  message: string;
}

export type IngestResult =
  | { ok: true; eventId: string }
  | { ok: false; error: "INVALID_EVENT" };

export type ConfigureResult =
  | { ok: true }
  | { ok: false; error: "INVALID_THRESHOLD" };

export type DeliveryResult =
  | { ok: true }
  | { ok: false; error: "MISSING_EMAIL" | "DELIVERY_FAILED"; retry: DeliveryRetryMetadata };