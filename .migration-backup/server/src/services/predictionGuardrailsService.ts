/**
 * Prediction Guardrails Service
 *
 * Analytics prediction pipelines can silently produce low-quality outputs when
 * historical data is too thin or time-series inputs are stale. This service
 * validates input depth and freshness before predictions are computed and
 * surfaces structured diagnostics alongside prediction output so callers can
 * decide how much to trust the result.
 */

export interface TimeSeriesPoint {
  timestamp: string; // ISO-8601
  value: number;
}

export interface PredictionInput {
  seriesId: string;
  dataPoints: TimeSeriesPoint[];
  /** ISO-8601 timestamp of the most recent authoritative fetch for this series. */
  lastFetchedAt?: string;
}

export type DiagnosticSeverity = "ok" | "warn" | "error";

export interface PredictionDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
}

export interface GuardrailResult {
  seriesId: string;
  passed: boolean;
  diagnostics: PredictionDiagnostic[];
}

/** Minimum number of data points required for a usable prediction. */
export const MIN_HISTORICAL_DEPTH = 7;

/** Maximum age (ms) of the newest data point before the series is considered stale. */
export const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum age (ms) of lastFetchedAt before the fetch itself is considered stale. */
export const STALE_FETCH_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Validate a single prediction input for historical depth and data freshness.
 * Returns a structured result containing all diagnostics and a passed flag.
 */
export function validatePredictionInput(
  input: PredictionInput,
  nowMs: number = Date.now(),
): GuardrailResult {
  const diagnostics: PredictionDiagnostic[] = [];

  // ── Depth check ─────────────────────────────────────────────────────────
  const depth = input.dataPoints.length;
  if (depth === 0) {
    diagnostics.push({
      code: "NO_DATA",
      severity: "error",
      message: `Series "${input.seriesId}" has no historical data points — prediction cannot proceed.`,
    });
  } else if (depth < MIN_HISTORICAL_DEPTH) {
    diagnostics.push({
      code: "INSUFFICIENT_DEPTH",
      severity: "error",
      message: `Series "${input.seriesId}" has only ${depth} data point(s); at least ${MIN_HISTORICAL_DEPTH} are required for a reliable prediction.`,
    });
  }

  // ── Stale newest-point check ─────────────────────────────────────────────
  if (input.dataPoints.length > 0) {
    const timestamps = input.dataPoints.map((p) => new Date(p.timestamp).getTime());
    const newestMs = Math.max(...timestamps);
    const ageMs = nowMs - newestMs;

    if (Number.isNaN(newestMs)) {
      diagnostics.push({
        code: "INVALID_TIMESTAMP",
        severity: "error",
        message: `Series "${input.seriesId}" contains data points with invalid timestamps.`,
      });
    } else if (ageMs > STALE_THRESHOLD_MS) {
      const ageMinutes = Math.round(ageMs / 60_000);
      diagnostics.push({
        code: "STALE_DATA",
        severity: "warn",
        message: `Series "${input.seriesId}" newest data point is ${ageMinutes} minute(s) old (threshold: ${STALE_THRESHOLD_MS / 60_000} min) — prediction quality may be degraded.`,
      });
    }
  }

  // ── Stale fetch check ────────────────────────────────────────────────────
  if (input.lastFetchedAt !== undefined) {
    const fetchMs = new Date(input.lastFetchedAt).getTime();
    if (Number.isNaN(fetchMs)) {
      diagnostics.push({
        code: "INVALID_FETCH_TIMESTAMP",
        severity: "error",
        message: `Series "${input.seriesId}" has an invalid lastFetchedAt timestamp.`,
      });
    } else {
      const fetchAgeMs = nowMs - fetchMs;
      if (fetchAgeMs > STALE_FETCH_THRESHOLD_MS) {
        const fetchAgeMinutes = Math.round(fetchAgeMs / 60_000);
        diagnostics.push({
          code: "STALE_FETCH",
          severity: "warn",
          message: `Series "${input.seriesId}" was last fetched ${fetchAgeMinutes} minute(s) ago (threshold: ${STALE_FETCH_THRESHOLD_MS / 60_000} min) — upstream data may be outdated.`,
        });
      }
    }
  }

  const passed = diagnostics.every((d) => d.severity !== "error");

  return { seriesId: input.seriesId, passed, diagnostics };
}

/**
 * Validate multiple prediction inputs at once.
 * Returns one GuardrailResult per input; overall batch passes only if all pass.
 */
export function validatePredictionBatch(
  inputs: PredictionInput[],
  nowMs: number = Date.now(),
): { results: GuardrailResult[]; allPassed: boolean } {
  const results = inputs.map((input) => validatePredictionInput(input, nowMs));
  const allPassed = results.every((r) => r.passed);
  return { results, allPassed };
}

/**
 * Collect all diagnostics across a batch, optionally filtered by severity.
 */
export function collectDiagnostics(
  results: GuardrailResult[],
  minSeverity: DiagnosticSeverity = "ok",
): PredictionDiagnostic[] {
  const order: Record<DiagnosticSeverity, number> = { ok: 0, warn: 1, error: 2 };
  const threshold = order[minSeverity];
  return results.flatMap((r) =>
    r.diagnostics.filter((d) => order[d.severity] >= threshold),
  );
}
