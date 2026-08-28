/**
 * Shared job-name constants used by producers (monitors) and consumers (workers).
 * Using typed constants reduces typo errors across queue interactions.
 */
export const QUEUE_NAMES = {
  LIQUIDATION: 'liquidation',
  COMPOUND: 'compound',
  /** Jobs moved after exceeding retry budget (terminal failure) */
  POISON: 'poison',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Payload for a liquidation job */
export interface LiquidationJobData {
  /** Stellar address of the undercollateralized account */
  accountAddress: string;
  /** Current CR in basis points (at time of scan) */
  currentCrBps: number;
  /** Collateral value in USD (7 decimal precision) */
  collateralValueUsd: string;
  /** Outstanding debt in sUSD */
  debtAmount: string;
  /** #906: Fencing token incremented on each attempt to reject stale locks */
  fencingToken: number;
  /** #906: Sequence number required before submission */
  requiredSequence: number;
  /**
   * Unix ms timestamp of the oracle price used to compute `currentCrBps`.
   * Omitted when the scanner didn't attach price provenance (dry-run policy
   * then skips the staleness check rather than blocking on missing data).
   */
  priceTimestampMs?: number;
  /**
   * Whether an oracle price was available when this job was enqueued.
   * `false` means the scanner could not confirm a live price at all — the
   * dry-run policy always blocks liquidation in that case.
   */
  oracleAvailable?: boolean;
}

/** Payload for an auto-compound job */
export interface CompoundJobData {
  /** Vault contract ID to compound */
  vaultContractId: string;
  /** Expected minimum harvest amount (slippage guard) */
  minHarvestAmount: string;
  /** #906: Fencing token incremented on each attempt to reject stale locks */
  fencingToken: number;
  /** #906: Sequence number required before submission */
  requiredSequence: number;
}

/**
 * #907: Terminal failure reasons that exhaust the retry budget.
 * Once exhausted, the job is moved to the POISON queue.
 */
export const TERMINAL_FAILURE_REASONS = {
  NON_RETRYABLE_ERROR: 'NON_RETRYABLE_ERROR',
  SEQUENCE_MISMATCH: 'SEQUENCE_MISMATCH',
  FENCING_VIOLATION: 'FENCING_VIOLATION',
  RETRY_BUDGET_EXHAUSTED: 'RETRY_BUDGET_EXHAUSTED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
} as const;

export type TerminalFailureReason =
  (typeof TERMINAL_FAILURE_REASONS)[keyof typeof TERMINAL_FAILURE_REASONS];

/**
 * #907: Retry classification for errors.
 * Retryable errors indicate transient conditions (network blips, temporary congestion).
 * Non-retryable errors indicate permanent failures that should not be retried.
 */
export function isRetryableError(error: Error | string): boolean {
  const message = typeof error === 'string' ? error : error.message;
  const nonRetryablePatterns = [
    'Simulation failed',
    'Contract reverted',
    'NON_RETRYABLE_ERROR',
    'FENCING_VIOLATION',
    'QUOTA_EXCEEDED',
    'insufficient balance',
    'Auth required',
    'Permission denied',
  ];

  return !nonRetryablePatterns.some((pattern) =>
    message.toLowerCase().includes(pattern.toLowerCase()),
  );
}

/**
 * #906: Job lifecycle states for observability and crash recovery.
 */
export const JOB_STATES = {
  CREATED: 'created',
  CLAIMED: 'claimed',       // Worker acquired lock
  SUBMITTED: 'submitted',   // Transaction sent
  CONFIRMED: 'confirmed',   // On-chain success
  FAILED: 'failed',         // Transient failure (will retry)
  EXHAUSTED: 'exhausted',   // Terminal failure (moved to poison)
} as const;

export type JobState = (typeof JOB_STATES)[keyof typeof JOB_STATES];

/**
 * #906: Persisted job attempt record for crash recovery and exactly-once semantics.
 */
export interface JobAttemptRecord {
  jobId: string;
  queueName: QueueName;
  state: JobState;
  attemptNumber: number;
  fencingToken: number;
  requiredSequence: number;
  txHash?: string;
  failedReason?: string;
  claimedAt: string;
  updatedAt: string;
  /** Vault or account identifier for logging */
  targetId: string;
}