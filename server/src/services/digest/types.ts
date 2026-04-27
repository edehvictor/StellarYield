// Shared types and data models for the Adaptive Notification Digest feature

// ─── String literal union types ───────────────────────────────────────────────

export type EventType = 'alert' | 'recommendation' | 'watchlist';

export type ScheduleMode = 'daily' | 'weekly' | 'event_threshold';

export type Decision = 'MIGRATE' | 'HOLD' | 'DEFER';

// ─── Notification Event types ─────────────────────────────────────────────────

export interface AlertEvent {
  eventId: string;
  eventType: 'alert';
  walletAddress: string;
  vaultId: string;
  condition: string;
  thresholdValue: number;
  currentValue: number;
  triggeredAt: string; // ISO 8601
  recordedAt: string;  // ISO 8601
}

export interface RecommendationEvent {
  eventId: string;
  eventType: 'recommendation';
  walletAddress: string;
  sourceStrategyId: string;
  destinationStrategyId: string;
  previousDecision: Decision;
  newDecision: Decision;
  recordedAt: string;  // ISO 8601
  triggeredAt: string; // ISO 8601
}

export interface WatchlistEvent {
  eventId: string;
  eventType: 'watchlist';
  walletAddress: string;
  vaultId: string;
  conditionDescription: string;
  triggeredAt: string; // ISO 8601
  recordedAt: string;  // ISO 8601
}

export type NotificationEvent = AlertEvent | RecommendationEvent | WatchlistEvent;

// ─── Cluster types ────────────────────────────────────────────────────────────

export interface Cluster {
  eventType: EventType;
  clusterKey: string; // "{eventType}:{vaultId}" or "{eventType}:{sourceStrategyId}:{destinationStrategyId}"
  vaultId?: string;
  events: NotificationEvent[];
}

export interface RankedCluster extends Cluster {
  topImportanceScore: number;
  summary: string;
}

// ─── Digest Payload types ─────────────────────────────────────────────────────

export interface RankedClusterEntry {
  eventType: EventType;
  vaultId?: string;
  topImportanceScore: number;
  eventCount: number;
  summary: string;
}

export interface DigestPayload {
  walletAddress: string;
  generatedAt: string; // ISO 8601
  scheduleMode: ScheduleMode;
  clusters: RankedClusterEntry[];
}

// ─── Schedule Config ──────────────────────────────────────────────────────────

export interface ScheduleConfig {
  walletAddress: string;
  mode: ScheduleMode;
  deliveryTime?: string;    // HH:MM, for daily/weekly
  dayOfWeek?: number;       // 0–6, for weekly
  eventThreshold?: number;  // 1–100, for event_threshold
  updatedAt: string;        // ISO 8601
}

// ─── Result types ─────────────────────────────────────────────────────────────

export type IngestResult =
  | { ok: true; eventId: string }
  | { ok: false; error: 'INVALID_EVENT' };

export type ConfigureResult =
  | { ok: true }
  | { ok: false; error: 'INVALID_THRESHOLD' };

export type DeliveryResult =
  | { ok: true }
  | { ok: false; error: 'MISSING_EMAIL' };
