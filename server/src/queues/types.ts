/**
 * Shared queue-name constants used by producers and consumers.
 * Using typed constants reduces typo errors across queue interactions.
 */
export const QUEUE_NAMES = {
  DIGEST_GENERATION: 'digest-generation',
  DIGEST_THRESHOLD_CHECK: 'digest-threshold-check',
  REBALANCE_EXECUTION: 'rebalance-execution',
  REBALANCE_RETRY: 'rebalance-retry',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Rebalance queue entry status constants
 */
export const REBALANCE_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PARTIAL: 'PARTIAL',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type RebalanceStatus = (typeof REBALANCE_STATUS)[keyof typeof REBALANCE_STATUS];

/**
 * Rebalance execution type constants
 */
export const EXECUTION_TYPE = {
  FULL: 'FULL',
  PARTIAL: 'PARTIAL',
  DEFERRED: 'DEFERRED',
} as const;

export type ExecutionType = (typeof EXECUTION_TYPE)[keyof typeof EXECUTION_TYPE];

/**
 * Strategy version event types
 */
export const STRATEGY_EVENT_TYPE = {
  RECOMMENDATION: 'RECOMMENDATION',
  REBALANCE: 'REBALANCE',
  SNAPSHOT: 'SNAPSHOT',
} as const;

export type StrategyEventType = (typeof STRATEGY_EVENT_TYPE)[keyof typeof STRATEGY_EVENT_TYPE];

/**
 * Strategy version change types
 */
export const VERSION_CHANGE_TYPE = {
  WEIGHTS_UPDATE: 'WEIGHTS_UPDATE',
  CONSTRAINTS_UPDATE: 'CONSTRAINTS_UPDATE',
  PARAMETERS_UPDATE: 'PARAMETERS_UPDATE',
  FULL_REVISION: 'FULL_REVISION',
} as const;

export type VersionChangeType = (typeof VERSION_CHANGE_TYPE)[keyof typeof VERSION_CHANGE_TYPE];
