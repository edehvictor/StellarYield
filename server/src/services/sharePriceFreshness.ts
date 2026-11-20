/**
 * Vault Share Price Freshness (#1155)
 *
 * Compares the timestamp of the latest vault share price snapshot with the
 * latest indexed event checkpoint. When the indexer has processed events
 * newer than the share price data (by more than the delay threshold), the
 * dashboard is warned before users rely on stale figures.
 *
 * Statuses:
 *   - "current" — share price is in sync with the checkpoint (quiet; no warning)
 *   - "delayed" — share price trails the checkpoint by more than the threshold
 *   - "missing" — the indexer checkpoint or the share price snapshot is absent
 *
 * The evaluator is a pure function (no I/O) so routes and tests can drive it
 * with explicit clocks. The default threshold (36h) exceeds the daily
 * snapshot cadence (`0 0 * * *` in jobs/sharePriceSnapshot.ts), so healthy
 * pipelines stay quiet and only a missed snapshot run is flagged.
 */

export type SharePriceFreshnessStatus = "current" | "delayed" | "missing";

export const SHARE_PRICE_FRESHNESS_THRESHOLDS = {
  /** Delay (ms) beyond which share price data counts as delayed. 36 hours. */
  maxDelayMs: 36 * 60 * 60 * 1000,
} as const;

export interface SharePriceFreshnessInput {
  /** Timestamp of the latest share price snapshot for the vault. */
  sharePriceUpdatedAt?: string | Date | null;
  /** Timestamp of the latest indexed vault event (checkpoint). */
  eventCheckpointAt?: string | Date | null;
  /** Clock override for deterministic tests. */
  now?: number;
  /** Delay threshold override in milliseconds. */
  maxDelayMs?: number;
}

export interface SharePriceFreshness {
  status: SharePriceFreshnessStatus;
  /** True for "delayed" and "missing" — the dashboard should warn. */
  isDelayed: boolean;
  /** ISO timestamp of the last known share price update (null when absent). */
  sharePriceUpdatedAt: string | null;
  /** ISO timestamp of the latest indexed event checkpoint (null when absent). */
  eventCheckpointAt: string | null;
  /** How far the share price trails the checkpoint, in ms (null when unknown). */
  delayMs: number | null;
  /** Threshold used for this evaluation. */
  maxDelayMs: number;
  /** Operator-facing warning; null when status is "current". */
  message: string | null;
  /** ISO timestamp of when this evaluation ran. */
  evaluatedAt: string;
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function resolveThreshold(maxDelayMs: number | undefined): number {
  return typeof maxDelayMs === "number" &&
    Number.isFinite(maxDelayMs) &&
    maxDelayMs > 0
    ? maxDelayMs
    : SHARE_PRICE_FRESHNESS_THRESHOLDS.maxDelayMs;
}

/**
 * Evaluate share price freshness against the latest event checkpoint.
 * Never throws; malformed timestamps are treated as missing.
 */
export function evaluateSharePriceFreshness(
  input: SharePriceFreshnessInput,
): SharePriceFreshness {
  const maxDelayMs = resolveThreshold(input.maxDelayMs);
  const evaluatedAt = new Date(input.now ?? Date.now()).toISOString();
  const sharePriceUpdatedAt = toIso(input.sharePriceUpdatedAt);
  const eventCheckpointAt = toIso(input.eventCheckpointAt);

  // Missing indexer checkpoint — we cannot prove the data is in sync.
  if (!eventCheckpointAt) {
    return {
      status: "missing",
      isDelayed: true,
      sharePriceUpdatedAt,
      eventCheckpointAt: null,
      delayMs: null,
      maxDelayMs,
      message: sharePriceUpdatedAt
        ? `Indexer checkpoint unavailable — share price last known update: ${sharePriceUpdatedAt}.`
        : "Indexer checkpoint unavailable and no share price snapshot has been recorded.",
      evaluatedAt,
    };
  }

  // Checkpoint exists but the vault has no share price snapshot at all.
  if (!sharePriceUpdatedAt) {
    return {
      status: "missing",
      isDelayed: true,
      sharePriceUpdatedAt: null,
      eventCheckpointAt,
      delayMs: null,
      maxDelayMs,
      message: `No share price snapshot recorded — latest indexed event checkpoint is ${eventCheckpointAt}.`,
      evaluatedAt,
    };
  }

  const priceMs = Date.parse(sharePriceUpdatedAt);
  const checkpointMs = Date.parse(eventCheckpointAt);
  const delayMs = Math.max(0, checkpointMs - priceMs);

  if (delayMs > maxDelayMs) {
    const delayHours = (delayMs / 3_600_000).toFixed(1);
    return {
      status: "delayed",
      isDelayed: true,
      sharePriceUpdatedAt,
      eventCheckpointAt,
      delayMs,
      maxDelayMs,
      message:
        `Share price data is ${delayHours}h behind the latest indexed event ` +
        `(last known update: ${sharePriceUpdatedAt}).`,
      evaluatedAt,
    };
  }

  return {
    status: "current",
    isDelayed: false,
    sharePriceUpdatedAt,
    eventCheckpointAt,
    delayMs,
    maxDelayMs,
    message: null,
    evaluatedAt,
  };
}
