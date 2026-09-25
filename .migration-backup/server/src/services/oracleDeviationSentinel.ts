/**
 * Oracle Deviation Sentinel for Strategy Execution (#280)
 *
 * Evaluates oracle data for freshness and value deviation before strategy
 * execution is permitted. Execution fails closed: when oracle state is
 * unacceptable the sentinel blocks execution and records a deviation event.
 *
 * Thresholds:
 *   - maxAgeMs           : reject if data is older than this
 *   - maxDeviationPct    : reject if deviation from reference > this %
 *   - downgradeThresholdPct: issue WARNING (not block) above this % deviation
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type OracleState = "FRESH" | "STALE" | "VALID" | "DEVIATED" | "MISSING";
export type ExecutionDecision = "ALLOW" | "DOWNGRADE" | "BLOCK";

export interface OracleReading {
  price: number;
  fetchedAt: number; // Unix ms
  source: string;
}

export interface DeviationThresholds {
  /** Max age in ms before a reading is considered stale. Default: 60 s. */
  maxAgeMs: number;
  /** Block execution if deviation exceeds this %. Default: 5%. */
  maxDeviationPct: number;
  /** Downgrade (allow with warning) if deviation exceeds this %. Default: 2%. */
  downgradeThresholdPct: number;
}

export interface SentinelEvaluation {
  state: OracleState;
  decision: ExecutionDecision;
  deviationPct: number | null;
  ageMs: number | null;
  reasons: string[];
  recordedAt: number;
}

export interface DeviationEvent {
  id: string;
  assetId: string;
  reading: OracleReading | null;
  referencePrice: number | null;
  evaluation: SentinelEvaluation;
  timestamp: number;
}

export const DEFAULT_THRESHOLDS: DeviationThresholds = {
  maxAgeMs: 60_000,
  maxDeviationPct: 5,
  downgradeThresholdPct: 2,
};

// ── In-memory deviation event log ─────────────────────────────────────────────

const MAX_LOG_ENTRIES = 1_000;
const _log: DeviationEvent[] = [];
let _eventCounter = 0;

function logEvent(event: DeviationEvent): void {
  _log.push(event);
  if (_log.length > MAX_LOG_ENTRIES) _log.shift();
}

// ── Core evaluation ───────────────────────────────────────────────────────────

/**
 * Evaluate an oracle reading and decide whether execution may proceed.
 *
 * @param reading        The oracle price reading to evaluate (null = missing).
 * @param referencePrice Trusted reference price for deviation check (null = skip deviation check).
 * @param thresholds     Override the default thresholds.
 * @param now            Injectable current time (for testing).
 */
export function evaluateOracle(
  reading: OracleReading | null,
  referencePrice: number | null = null,
  thresholds: DeviationThresholds = DEFAULT_THRESHOLDS,
  now: number = Date.now(),
): SentinelEvaluation {
  const reasons: string[] = [];

  // ── Missing data ──────────────────────────────────────────────────────────
  if (!reading) {
    reasons.push("Oracle reading is missing.");
    return {
      state: "MISSING",
      decision: "BLOCK",
      deviationPct: null,
      ageMs: null,
      reasons,
      recordedAt: now,
    };
  }

  // ── Freshness check ───────────────────────────────────────────────────────
  const ageMs = now - reading.fetchedAt;
  if (ageMs > thresholds.maxAgeMs) {
    reasons.push(
      `Oracle data is stale: age ${(ageMs / 1_000).toFixed(1)}s > max ${(thresholds.maxAgeMs / 1_000).toFixed(1)}s.`,
    );
    return {
      state: "STALE",
      decision: "BLOCK",
      deviationPct: null,
      ageMs,
      reasons,
      recordedAt: now,
    };
  }

  // ── Deviation check ───────────────────────────────────────────────────────
  if (referencePrice !== null && referencePrice > 0) {
    const deviationPct = Math.abs((reading.price - referencePrice) / referencePrice) * 100;

    if (deviationPct > thresholds.maxDeviationPct) {
      reasons.push(
        `Price deviation ${deviationPct.toFixed(2)}% exceeds max ${thresholds.maxDeviationPct}%.`,
      );
      return {
        state: "DEVIATED",
        decision: "BLOCK",
        deviationPct,
        ageMs,
        reasons,
        recordedAt: now,
      };
    }

    if (deviationPct > thresholds.downgradeThresholdPct) {
      reasons.push(
        `Price deviation ${deviationPct.toFixed(2)}% exceeds downgrade threshold ${thresholds.downgradeThresholdPct}%. Proceeding with caution.`,
      );
      return {
        state: "VALID",
        decision: "DOWNGRADE",
        deviationPct,
        ageMs,
        reasons,
        recordedAt: now,
      };
    }

    return {
      state: "VALID",
      decision: "ALLOW",
      deviationPct,
      ageMs,
      reasons,
      recordedAt: now,
    };
  }

  // No reference price — freshness is sufficient
  return {
    state: "FRESH",
    decision: "ALLOW",
    deviationPct: null,
    ageMs,
    reasons,
    recordedAt: now,
  };
}

/**
 * Evaluate and record a deviation event for an asset.
 * Returns the evaluation result for the caller to act on.
 */
export function evaluateAndRecord(
  assetId: string,
  reading: OracleReading | null,
  referencePrice: number | null = null,
  thresholds: DeviationThresholds = DEFAULT_THRESHOLDS,
  now: number = Date.now(),
): SentinelEvaluation {
  const evaluation = evaluateOracle(reading, referencePrice, thresholds, now);

  const event: DeviationEvent = {
    id: `dev-${++_eventCounter}-${now}`,
    assetId,
    reading,
    referencePrice,
    evaluation,
    timestamp: now,
  };

  logEvent(event);
  return evaluation;
}

/** Return the recorded deviation event log (newest-first). */
export function getDeviationLog(): DeviationEvent[] {
  return [..._log].reverse();
}

/** Clear the log (for testing). */
export function clearDeviationLog(): void {
  _log.length = 0;
  _eventCounter = 0;
}
