/**
 * Event types for the event-sourced strategy lifecycle audit (#34).
 *
 * Each event is immutable once recorded. The union type StrategyLifecycleEvent
 * covers every point in a strategy's lifecycle from first recommendation
 * through to final execution or block.
 *
 * All events carry a stable `correlationId` that links every event belonging
 * to the same recommendation-through-execution chain, and an `actor` field
 * identifying the system component or operator that generated the event.
 * An optional `sourceDataHash` records a SHA-256 of the input data used so
 * replays can verify nothing was altered.
 */

export type StrategyLifecycleEventType =
  | "StrategyRecommended"
  | "StrategyQueued"
  | "StrategyRiskChecked"
  | "OracleDecisionRecorded"
  | "FallbackRouteSelected"
  | "StrategyExecuted"
  | "StrategyExecutionFailed"
  | "StrategyBlocked"
  | "StrategySnapshotted";

interface BaseEvent {
  /** Unique event identifier. */
  id: string;
  strategyId: string;
  timestamp: Date;
  type: StrategyLifecycleEventType;
  /**
   * Stable ID linking all events that belong to the same recommendation →
   * execution chain. Assigned when the recommendation is first recorded and
   * propagated to every downstream event.
   */
  correlationId: string;
  /** System component or operator that produced the event. */
  actor: string;
  /**
   * SHA-256 hex digest of the primary input payload used to produce this
   * event. Allows audit replays to verify data integrity.
   */
  sourceDataHash?: string;
}

export interface StrategyRecommendedEvent extends BaseEvent {
  type: "StrategyRecommended";
  recommendedBy: string;
  rationale: string;
  expectedApyBps: number;
}

export interface StrategyQueuedEvent extends BaseEvent {
  type: "StrategyQueued";
  queueEntryId: string;
  queuePosition: number;
  priority: "high" | "medium" | "low";
}

export interface StrategyRiskCheckedEvent extends BaseEvent {
  type: "StrategyRiskChecked";
  riskScore: number;
  passed: boolean;
  checkedBy: string;
}

/** Emitted when the oracle sentinel evaluates a price reading before execution. */
export interface OracleDecisionRecordedEvent extends BaseEvent {
  type: "OracleDecisionRecorded";
  assetId: string;
  oracleDecision: "ALLOW" | "DOWNGRADE" | "BLOCK";
  oracleState: string;
  deviationPct: number | null;
  ageMs: number | null;
  reasons: string[];
}

/** Emitted when the normal execution path is unavailable and a fallback is chosen. */
export interface FallbackRouteSelectedEvent extends BaseEvent {
  type: "FallbackRouteSelected";
  originalProtocol: string;
  fallbackProtocol: string;
  fallbackReason: string;
}

export interface StrategyExecutedEvent extends BaseEvent {
  type: "StrategyExecuted";
  executedBy: string;
  executionDurationMs: number;
  resultApyBps: number;
  transactionHash?: string;
  filledPercentage?: number;
}

/** Emitted when execution is attempted but fails (distinct from StrategyBlocked). */
export interface StrategyExecutionFailedEvent extends BaseEvent {
  type: "StrategyExecutionFailed";
  failureClass: string;
  reason: string;
  attemptNumber: number;
  willRetry: boolean;
}

export interface StrategyBlockedEvent extends BaseEvent {
  type: "StrategyBlocked";
  reason: string;
  blockedBy: string;
}

export interface StrategySnapshottedEvent extends BaseEvent {
  type: "StrategySnapshotted";
  snapshotId: string;
  snapshotVersion: number;
  snapshotHash: string;
  changeReason?: string;
}

export type StrategyLifecycleEvent =
  | StrategyRecommendedEvent
  | StrategyQueuedEvent
  | StrategyRiskCheckedEvent
  | OracleDecisionRecordedEvent
  | FallbackRouteSelectedEvent
  | StrategyExecutedEvent
  | StrategyExecutionFailedEvent
  | StrategyBlockedEvent
  | StrategySnapshottedEvent;
