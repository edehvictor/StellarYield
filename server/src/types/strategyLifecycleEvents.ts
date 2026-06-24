/**
 * Event types for the event-sourced strategy lifecycle audit (#720).
 *
 * Each event is immutable once recorded. The union type StrategyLifecycleEvent
 * covers every point in a strategy's lifecycle from first recommendation
 * through to final execution or block.
 */

export type StrategyLifecycleEventType =
  | "StrategyRecommended"
  | "StrategyQueued"
  | "StrategyRiskChecked"
  | "StrategyExecuted"
  | "StrategyBlocked"
  | "StrategySnapshotted";

interface BaseEvent {
  strategyId: string;
  timestamp: Date;
  type: StrategyLifecycleEventType;
}

export interface StrategyRecommendedEvent extends BaseEvent {
  type: "StrategyRecommended";
  recommendedBy: string;
  rationale: string;
  expectedApyBps: number;
}

export interface StrategyQueuedEvent extends BaseEvent {
  type: "StrategyQueued";
  queuePosition: number;
  priority: "high" | "medium" | "low";
}

export interface StrategyRiskCheckedEvent extends BaseEvent {
  type: "StrategyRiskChecked";
  riskScore: number;
  passed: boolean;
  checkedBy: string;
}

export interface StrategyExecutedEvent extends BaseEvent {
  type: "StrategyExecuted";
  executedBy: string;
  executionDurationMs: number;
  resultApyBps: number;
}

export interface StrategyBlockedEvent extends BaseEvent {
  type: "StrategyBlocked";
  reason: string;
  blockedBy: string;
}

export interface StrategySnapshottedEvent extends BaseEvent {
  type: "StrategySnapshotted";
  snapshotId: string;
  snapshotHash: string;
}

export type StrategyLifecycleEvent =
  | StrategyRecommendedEvent
  | StrategyQueuedEvent
  | StrategyRiskCheckedEvent
  | StrategyExecutedEvent
  | StrategyBlockedEvent
  | StrategySnapshottedEvent;
