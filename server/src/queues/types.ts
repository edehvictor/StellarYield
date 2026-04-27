/**
 * Shared queue-name constants used by producers and consumers.
 * Using typed constants reduces typo errors across queue interactions.
 */
export const QUEUE_NAMES = {
  DIGEST_GENERATION: 'digest-generation',
  DIGEST_THRESHOLD_CHECK: 'digest-threshold-check',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
