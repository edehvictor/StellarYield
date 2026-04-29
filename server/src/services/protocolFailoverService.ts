/**
 * Protocol Downtime Failover Strategy Layer
 *
 * Detects unavailable or degraded protocols via configurable health and
 * data-freshness checks, excludes them from strategy ranking until they
 * recover, and records every failover decision so it can be returned in
 * recommendation responses and inspected through audit endpoints.
 *
 * Design notes:
 *   - Pure decision logic: callers feed in `ProtocolHealthInput` records
 *     and receive structured exclusions plus reasons. There are no I/O
 *     dependencies in this module so it is trivial to unit-test.
 *   - Recovery is modelled by transitioning a previously-excluded
 *     protocol back to `included`; the decision log records the
 *     transition explicitly so consumers can show "X recovered" UX.
 *   - Decisions are kept in a bounded ring buffer so memory cannot grow
 *     unbounded under flapping providers.
 *   - Health thresholds are documented at the top of the file so
 *     operators can tune them with full context.
 *
 * Health thresholds (defaults):
 *   maxDataAgeMs   — data older than this is considered stale (5 min)
 *   minUptimeRatio — provider uptime below this is considered degraded
 *                    (0.95 = 95% in the relevant window)
 *   excludeStatuses — the set of statuses that always disqualify a
 *                     protocol regardless of other signals.
 *
 * Severity:
 *   ok    — protocol is healthy
 *   warn  — protocol is degraded but still usable
 *   fail  — protocol must be excluded from ranking
 */

export type ProtocolHealthStatus =
  | "healthy"
  | "degraded"
  | "critical"
  | "down"
  | "unknown";

export type FailoverSeverity = "ok" | "warn" | "fail";

export type FailoverAction = "include" | "exclude" | "recovered";

export interface ProtocolHealthInput {
  /** Stable protocol identifier (e.g. "blend"). */
  id: string;
  /** Human-readable protocol name. */
  name: string;
  /** Latest known health status. */
  status: ProtocolHealthStatus;
  /**
   * ISO-8601 timestamp of when the underlying data was fetched.
   * Used to enforce freshness thresholds.
   */
  lastUpdatedAt: string;
  /** Optional uptime ratio in [0,1] over the configured window. */
  providerUptime?: number;
  /** Optional explicit error count over the relevant window. */
  recentErrorCount?: number;
}

export interface FailoverThresholds {
  /** Data older than this is treated as stale and excluded. */
  maxDataAgeMs: number;
  /** Provider uptime below this is excluded. */
  minUptimeRatio: number;
  /** Statuses that unconditionally exclude a protocol. */
  excludeStatuses: ProtocolHealthStatus[];
  /** Statuses that warrant a warning but allow inclusion. */
  warnStatuses: ProtocolHealthStatus[];
  /** Above this many recent errors, the protocol is excluded. */
  maxRecentErrors: number;
}

export const DEFAULT_FAILOVER_THRESHOLDS: FailoverThresholds = {
  maxDataAgeMs: 5 * 60 * 1000,
  minUptimeRatio: 0.95,
  excludeStatuses: ["critical", "down"],
  warnStatuses: ["degraded", "unknown"],
  maxRecentErrors: 5,
};

export interface ProtocolEvaluation {
  protocolId: string;
  protocolName: string;
  severity: FailoverSeverity;
  shouldExclude: boolean;
  reasons: string[];
  evaluatedAt: string;
}

export interface FailoverDecision {
  protocolId: string;
  protocolName: string;
  action: FailoverAction;
  severity: FailoverSeverity;
  reasons: string[];
  timestamp: string;
}

export interface FailoverResult<T> {
  included: T[];
  excluded: T[];
  evaluations: ProtocolEvaluation[];
  decisions: FailoverDecision[];
}

const DECISION_LOG_MAX_ENTRIES = 500;

/**
 * Evaluate a single protocol's health against the configured thresholds.
 * Pure function — does not mutate global state.
 */
export function evaluateProtocolHealth(
  health: ProtocolHealthInput,
  thresholds: FailoverThresholds = DEFAULT_FAILOVER_THRESHOLDS,
  now: number = Date.now(),
): ProtocolEvaluation {
  const reasons: string[] = [];
  let severity: FailoverSeverity = "ok";
  let shouldExclude = false;

  if (thresholds.excludeStatuses.includes(health.status)) {
    severity = "fail";
    shouldExclude = true;
    reasons.push(`status=${health.status}`);
  } else if (thresholds.warnStatuses.includes(health.status)) {
    severity = "warn";
    reasons.push(`status=${health.status}`);
  }

  const lastUpdatedMs = Date.parse(health.lastUpdatedAt);
  if (!Number.isFinite(lastUpdatedMs)) {
    severity = "fail";
    shouldExclude = true;
    reasons.push("lastUpdatedAt is missing or invalid");
  } else {
    const ageMs = now - lastUpdatedMs;
    if (ageMs > thresholds.maxDataAgeMs) {
      severity = "fail";
      shouldExclude = true;
      reasons.push(
        `data is stale (age=${ageMs}ms > maxDataAgeMs=${thresholds.maxDataAgeMs}ms)`,
      );
    }
  }

  if (
    typeof health.providerUptime === "number" &&
    Number.isFinite(health.providerUptime) &&
    health.providerUptime < thresholds.minUptimeRatio
  ) {
    severity = "fail";
    shouldExclude = true;
    reasons.push(
      `uptime=${health.providerUptime.toFixed(3)} < minUptimeRatio=${thresholds.minUptimeRatio}`,
    );
  }

  if (
    typeof health.recentErrorCount === "number" &&
    health.recentErrorCount > thresholds.maxRecentErrors
  ) {
    severity = "fail";
    shouldExclude = true;
    reasons.push(
      `errorCount=${health.recentErrorCount} > maxRecentErrors=${thresholds.maxRecentErrors}`,
    );
  }

  return {
    protocolId: health.id,
    protocolName: health.name,
    severity,
    shouldExclude,
    reasons,
    evaluatedAt: new Date(now).toISOString(),
  };
}

/**
 * Filter a list of strategies by their associated protocol health,
 * producing both the surviving list and a structured decision log
 * that explains every exclusion and recovery.
 *
 * The previousState argument lets callers pass in the prior set of
 * excluded protocol IDs so that recoveries are surfaced explicitly:
 * a protocol that was excluded last cycle and is healthy now will
 * appear in `decisions` with action="recovered".
 */
export function applyFailover<T extends { id: string }>(
  strategies: T[],
  health: Map<string, ProtocolHealthInput>,
  previousState: Set<string> = new Set(),
  thresholds: FailoverThresholds = DEFAULT_FAILOVER_THRESHOLDS,
  now: number = Date.now(),
): FailoverResult<T> {
  const evaluations: ProtocolEvaluation[] = [];
  const decisions: FailoverDecision[] = [];
  const included: T[] = [];
  const excluded: T[] = [];

  for (const strategy of strategies) {
    const healthRecord = health.get(strategy.id);

    if (!healthRecord) {
      const reasons = ["no health data available"];
      evaluations.push({
        protocolId: strategy.id,
        protocolName: strategy.id,
        severity: "fail",
        shouldExclude: true,
        reasons,
        evaluatedAt: new Date(now).toISOString(),
      });
      decisions.push({
        protocolId: strategy.id,
        protocolName: strategy.id,
        action: "exclude",
        severity: "fail",
        reasons,
        timestamp: new Date(now).toISOString(),
      });
      excluded.push(strategy);
      continue;
    }

    const evaluation = evaluateProtocolHealth(healthRecord, thresholds, now);
    evaluations.push(evaluation);

    if (evaluation.shouldExclude) {
      decisions.push({
        protocolId: evaluation.protocolId,
        protocolName: evaluation.protocolName,
        action: "exclude",
        severity: evaluation.severity,
        reasons: evaluation.reasons,
        timestamp: evaluation.evaluatedAt,
      });
      excluded.push(strategy);
      continue;
    }

    if (previousState.has(strategy.id)) {
      decisions.push({
        protocolId: evaluation.protocolId,
        protocolName: evaluation.protocolName,
        action: "recovered",
        severity: evaluation.severity,
        reasons: evaluation.reasons.length
          ? evaluation.reasons
          : ["all checks passed"],
        timestamp: evaluation.evaluatedAt,
      });
    } else if (evaluation.severity === "warn") {
      decisions.push({
        protocolId: evaluation.protocolId,
        protocolName: evaluation.protocolName,
        action: "include",
        severity: evaluation.severity,
        reasons: evaluation.reasons,
        timestamp: evaluation.evaluatedAt,
      });
    }

    included.push(strategy);
  }

  return { included, excluded, evaluations, decisions };
}

/**
 * Stateful failover registry. Wraps `applyFailover` with a bounded
 * decision log and remembers which protocols were excluded last cycle
 * so recoveries can be reported automatically.
 */
export class FailoverRegistry {
  private excludedIds = new Set<string>();
  private decisionLog: FailoverDecision[] = [];

  constructor(private thresholds: FailoverThresholds = DEFAULT_FAILOVER_THRESHOLDS) {}

  /**
   * Run a failover pass. Updates the internal exclusion set and appends
   * any new decisions to the bounded decision log.
   */
  apply<T extends { id: string }>(
    strategies: T[],
    health: Map<string, ProtocolHealthInput>,
    now: number = Date.now(),
  ): FailoverResult<T> {
    const result = applyFailover(
      strategies,
      health,
      this.excludedIds,
      this.thresholds,
      now,
    );
    this.excludedIds = new Set(result.excluded.map((s) => s.id));
    this.recordDecisions(result.decisions);
    return result;
  }

  /** Snapshot of currently-excluded protocol IDs. */
  excludedProtocols(): string[] {
    return Array.from(this.excludedIds).sort();
  }

  /** Most recent decisions, newest first, optionally limited. */
  recentDecisions(limit = 50): FailoverDecision[] {
    if (limit <= 0) return [];
    const slice = this.decisionLog.slice(-limit);
    return slice.slice().reverse();
  }

  /** Reset state (test hook). */
  reset(): void {
    this.excludedIds.clear();
    this.decisionLog = [];
  }

  private recordDecisions(decisions: FailoverDecision[]): void {
    if (!decisions.length) return;
    this.decisionLog.push(...decisions);
    if (this.decisionLog.length > DECISION_LOG_MAX_ENTRIES) {
      this.decisionLog.splice(
        0,
        this.decisionLog.length - DECISION_LOG_MAX_ENTRIES,
      );
    }
  }
}

/** Process-wide failover registry shared across routes/jobs. */
export const failoverRegistry = new FailoverRegistry();
