/**
 * Pure transparency subsystem health summarization and external data boundary validation.
 *
 * Normalizes indexer, relayer, registry, and smoke-test signals into a single
 * deterministic overall status for the transparency dashboard.
 *
 * Boundary-value & malformed external data handling (#1913, #1914): every
 * untrusted field is validated at the boundary before state updates or
 * arithmetic. Non-finite, negative, non-boolean, or out-of-range values are
 * rejected or normalized to "unknown" / "degraded" rather than "healthy",
 * successRate is clamped to [0, 100] and rounded only after clamping, and
 * failureCount is bounded to a finite non-negative integer.
 */
import {
  buildTransparencyDiagnostic,
  type TransparencyDiagnostic,
  type TransparencyStage,
} from "../../../../shared/types/transparencyDiagnostic";
import { configFingerprintsMatch } from "../../../../shared/types/configFingerprint";

export type SubsystemState = "healthy" | "degraded" | "failed" | "unknown";

export type OverallHealthState = "healthy" | "degraded" | "failed";

export interface TransparencyHealthInput {
  indexer: SubsystemState;
  relayer: SubsystemState;
  registry: SubsystemState;
  smokeTest: SubsystemState;
}

/**
 * Configuration identity for a health rollup.
 *
 * `configFingerprint` is the fingerprint the current signals were reported
 * under; `previousConfigFingerprint` is the one the reusable signals were
 * reported under. When both are present and differ, the previous signals were
 * observed against a different configuration and must not be reused.
 */
export interface TransparencyHealthConfig {
  configFingerprint?: string;
  previousConfigFingerprint?: string;
}

export interface TransparencyHealthSummary {
  overall: OverallHealthState;
  subsystems: TransparencyHealthInput;
  needsAttention: boolean;
  /** Subsystems that are not healthy, ordered by severity then name. */
  attentionSubsystems: Array<keyof TransparencyHealthInput>;
  summaryMessage: string;
  /** True when enough independent signals were present to trust the rollup. */
  contextSufficient: boolean;
  /** Subsystems whose last known-good value was reused because the signal was missing. */
  reusedSubsystems: Array<keyof TransparencyHealthInput>;
  /** Privacy-safe diagnostics naming the failed stage and remediation path. */
  diagnostics: TransparencyDiagnostic[];
  /** Config fingerprint the observed signals were reported under, when known. */
  configFingerprint?: string;
  /** True when last known-good signals were rejected because the config changed. */
  configStale: boolean;
}

export interface TransparencyHistoryPoint {
  date: string;
  revenue: number;
  burned: number;
}

export interface TransparencySummaryPayload {
  totalRevenueLumens: number;
  totalBurnedTokens: number;
  deflationaryRatio: number;
  history: TransparencyHistoryPoint[];
}

export interface ValidatedFailoverIncident {
  id: string;
  protocolId: string;
  protocolName: string;
  trigger: string;
  reasons: string[];
  startedAt: string;
  recoveredAt?: string;
  durationMs?: number;
  resolved: boolean;
}

export type TransparencyDataErrorCode =
  | "MALFORMED_SUMMARY_PAYLOAD"
  | "MALFORMED_HISTORY_ENTRY"
  | "MALFORMED_INCIDENTS_PAYLOAD"
  | "MALFORMED_INDEXER_PAYLOAD"
  | "MALFORMED_RELAYER_PAYLOAD"
  | "MALFORMED_REGISTRY_PAYLOAD"
  | "MALFORMED_SMOKE_PAYLOAD";

export class TransparencyExternalDataError extends Error {
  readonly code: TransparencyDataErrorCode;

  constructor(code: TransparencyDataErrorCode, message: string) {
    super(message);
    this.name = "TransparencyExternalDataError";
    this.code = code;
  }
}

const SEVERITY_RANK: Record<SubsystemState, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  failed: 3,
};

const SUBSYSTEM_LABELS: Record<keyof TransparencyHealthInput, string> = {
  indexer: "Indexer",
  relayer: "Relayer",
  registry: "Registry",
  smokeTest: "Smoke test",
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIsoCalendarDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const parsed = new Date(`${dateStr}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateStr;
}

function isValidState(state: unknown): state is SubsystemState {
  return state === "healthy" || state === "degraded" || state === "failed" || state === "unknown";
}

/** Coerce an unchecked subsystem value to a valid state or "unknown". */
export function sanitizeSubsystemState(state: unknown): SubsystemState {
  return isValidState(state) ? state : "unknown";
}

function worstState(states: SubsystemState[]): SubsystemState {
  return states.reduce(
    (worst, state) => (SEVERITY_RANK[state] > SEVERITY_RANK[worst] ? state : worst),
    "healthy" as SubsystemState,
  );
}

function toOverall(worst: SubsystemState): OverallHealthState {
  if (worst === "failed") return "failed";
  if (worst === "degraded" || worst === "unknown") return "degraded";
  return "healthy";
}

/** Map indexer checkpoint status to a normalized subsystem state. */
export function mapIndexerStatus(status: string | undefined): SubsystemState {
  if (typeof status !== "string") {
    return "unknown";
  }
  switch (status) {
    case "healthy":
      return "healthy";
    case "degraded":
      return "degraded";
    case "unavailable":
      return "failed";
    default:
      return "unknown";
  }
}

/**
 * Validate and extract indexer status from an untrusted API response payload
 * (supports both top-level `{ status }` and `{ success, data: { status } }` envelopes).
 */
export function parseIndexerStatusPayload(payload: unknown): SubsystemState {
  if (!isPlainRecord(payload)) {
    return "unknown";
  }
  if ("success" in payload && payload.success === false) {
    return "unknown";
  }
  if (typeof payload.status === "string") {
    return mapIndexerStatus(payload.status);
  }
  if (isPlainRecord(payload.data) && typeof payload.data.status === "string") {
    return mapIndexerStatus(payload.data.status);
  }
  return "unknown";
}

/** Map relayer service signals to a normalized subsystem state. */
export function mapRelayerStatus(input: {
  isOnline: boolean;
  failureCount: number;
  successRate: number;
}): SubsystemState {
  if (!isPlainRecord(input) || typeof input.isOnline !== "boolean") {
    return "unknown";
  }
  if (!input.isOnline) return "failed";
  // Boundary values: NaN/Infinity/out-of-range/non-number fields never count as healthy.
  // Clamp successRate to [0, 100] and bound failureCount to a finite
  // non-negative integer before comparing against the 50% threshold.
  const rawFailureCount = (input as { failureCount?: unknown }).failureCount;
  const rawSuccessRate = (input as { successRate?: unknown }).successRate;
  const failureCount =
    typeof rawFailureCount === "number" && Number.isFinite(rawFailureCount)
      ? Math.max(0, Math.floor(rawFailureCount))
      : 0;
  const successRate =
    typeof rawSuccessRate === "number" && Number.isFinite(rawSuccessRate)
      ? Math.min(100, Math.max(0, rawSuccessRate))
      : 0;
  const hasInvalid =
    typeof rawFailureCount !== "number" ||
    typeof rawSuccessRate !== "number" ||
    failureCount !== rawFailureCount ||
    successRate !== rawSuccessRate;
  if (failureCount <= 0 && !hasInvalid) return "healthy";
  if (failureCount > 0 && successRate < 50) return "failed";
  if (failureCount > 0 || hasInvalid) return "degraded";
  return "healthy";
}

/**
 * Validate and normalize an untrusted `/api/relayer/status` JSON payload without
 * defaulting missing fields to healthy values.
 */
export function parseRelayerStatusPayload(payload: unknown): SubsystemState {
  if (!isPlainRecord(payload)) {
    return "unknown";
  }
  if ("success" in payload && payload.success === false) {
    return "unknown";
  }
  const target = isPlainRecord(payload.data) ? payload.data : payload;
  if (typeof target.isOnline !== "boolean") {
    return "unknown";
  }
  return mapRelayerStatus({
    isOnline: target.isOnline,
    failureCount: target.failureCount as number,
    successRate: target.successRate as number,
  });
}

/** Map registry diff summary to a normalized subsystem state. */
export function mapRegistryHealth(input: {
  hasMissing: boolean;
  hasRemoved: boolean;
  hasChanged: boolean;
}): SubsystemState {
  if (
    !isPlainRecord(input) ||
    typeof input.hasMissing !== "boolean" ||
    typeof input.hasRemoved !== "boolean" ||
    typeof input.hasChanged !== "boolean"
  ) {
    return "unknown";
  }
  if (input.hasRemoved) return "failed";
  if (input.hasMissing || input.hasChanged) return "degraded";
  return "healthy";
}

/** Map smoke-test run results to a normalized subsystem state. */
export function mapSmokeTestStatus(
  status: "pass" | "fail" | null,
  checks?: Array<{ status: "pass" | "fail" }>,
): SubsystemState {
  if (status === null || status === undefined) return "unknown";
  if (status === "fail") return "failed";
  if (status !== "pass") return "unknown";
  if (checks !== undefined) {
    if (!Array.isArray(checks)) return "unknown";
    for (const check of checks) {
      if (!isPlainRecord(check) || (check.status !== "pass" && check.status !== "fail")) {
        return "unknown";
      }
    }
    if (checks.some((check) => check.status === "fail")) return "degraded";
  }
  return "healthy";
}

/**
 * Validate an untrusted `/api/transparency/summary` payload at the boundary.
 * Throws a typed `TransparencyExternalDataError` without mutating the payload
 * when required totals or history points are missing or malformed.
 */
export function validateTransparencySummaryPayload(payload: unknown): TransparencySummaryPayload {
  if (!isPlainRecord(payload)) {
    throw new TransparencyExternalDataError(
      "MALFORMED_SUMMARY_PAYLOAD",
      "Transparency summary payload must be an object.",
    );
  }
  const { totalRevenueLumens, totalBurnedTokens, deflationaryRatio, history } = payload;
  if (
    typeof totalRevenueLumens !== "number" ||
    !Number.isFinite(totalRevenueLumens) ||
    totalRevenueLumens < 0 ||
    typeof totalBurnedTokens !== "number" ||
    !Number.isFinite(totalBurnedTokens) ||
    totalBurnedTokens < 0 ||
    typeof deflationaryRatio !== "number" ||
    !Number.isFinite(deflationaryRatio) ||
    deflationaryRatio < 0 ||
    deflationaryRatio > 100 ||
    !Array.isArray(history)
  ) {
    throw new TransparencyExternalDataError(
      "MALFORMED_SUMMARY_PAYLOAD",
      "Transparency summary totals or history array are invalid.",
    );
  }

  const validatedHistory: TransparencyHistoryPoint[] = history.map((entry) => {
    if (!isPlainRecord(entry)) {
      throw new TransparencyExternalDataError(
        "MALFORMED_HISTORY_ENTRY",
        "Transparency history entry must be an object.",
      );
    }
    const rawDate = typeof entry.date === "string" ? entry.date.trim() : "";
    const rawRevenue = entry.revenue;
    const rawBurned = entry.burned;
    if (
      !isValidIsoCalendarDate(rawDate) ||
      typeof rawRevenue !== "number" ||
      !Number.isFinite(rawRevenue) ||
      rawRevenue < 0 ||
      typeof rawBurned !== "number" ||
      !Number.isFinite(rawBurned) ||
      rawBurned < 0
    ) {
      throw new TransparencyExternalDataError(
        "MALFORMED_HISTORY_ENTRY",
        "Transparency history entry contains malformed date, revenue, or burned fields.",
      );
    }
    return {
      date: rawDate,
      revenue: rawRevenue,
      burned: rawBurned,
    };
  });

  return {
    totalRevenueLumens,
    totalBurnedTokens,
    deflationaryRatio,
    history: validatedHistory,
  };
}

/**
 * Validate a single untrusted failover incident record at the boundary.
 * Returns a sanitized clone or `null` if malformed.
 */
export function validateFailoverIncident(entry: unknown): ValidatedFailoverIncident | null {
  if (!isPlainRecord(entry)) return null;
  if (
    typeof entry.id !== "string" ||
    !entry.id.trim() ||
    typeof entry.protocolId !== "string" ||
    !entry.protocolId.trim() ||
    typeof entry.protocolName !== "string" ||
    !entry.protocolName.trim() ||
    typeof entry.trigger !== "string" ||
    !entry.trigger.trim() ||
    typeof entry.startedAt !== "string" ||
    !entry.startedAt.trim() ||
    !Number.isFinite(Date.parse(entry.startedAt)) ||
    typeof entry.resolved !== "boolean" ||
    !Array.isArray(entry.reasons) ||
    entry.reasons.some((reason) => typeof reason !== "string" || !reason.trim())
  ) {
    return null;
  }

  if (
    entry.recoveredAt !== undefined &&
    (typeof entry.recoveredAt !== "string" ||
      !entry.recoveredAt.trim() ||
      !Number.isFinite(Date.parse(entry.recoveredAt)))
  ) {
    return null;
  }

  if (
    entry.durationMs !== undefined &&
    (typeof entry.durationMs !== "number" ||
      !Number.isFinite(entry.durationMs) ||
      entry.durationMs < 0)
  ) {
    return null;
  }

  return {
    id: entry.id.trim(),
    protocolId: entry.protocolId.trim(),
    protocolName: entry.protocolName.trim(),
    trigger: entry.trigger.trim(),
    reasons: entry.reasons.map((reason: string) => reason.trim()),
    startedAt: entry.startedAt.trim(),
    ...(entry.recoveredAt !== undefined ? { recoveredAt: entry.recoveredAt.trim() } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    resolved: entry.resolved,
  };
}

/**
 * Validate an untrusted `/api/transparency/failover-history` response payload.
 * Throws `TransparencyExternalDataError` if the envelope is not `{ incidents: [...] }`
 * or if every entry in a non-empty incident list is malformed.
 */
export function validateFailoverIncidentsPayload(payload: unknown): ValidatedFailoverIncident[] {
  if (!isPlainRecord(payload) || !Array.isArray(payload.incidents)) {
    throw new TransparencyExternalDataError(
      "MALFORMED_INCIDENTS_PAYLOAD",
      "Malformed failover history response",
    );
  }
  if (payload.incidents.length === 0) {
    return [];
  }
  const valid = payload.incidents
    .map((entry) => validateFailoverIncident(entry))
    .filter((entry): entry is ValidatedFailoverIncident => entry !== null);
  if (valid.length === 0) {
    throw new TransparencyExternalDataError(
      "MALFORMED_INCIDENTS_PAYLOAD",
      "Failover history contained no valid incident records",
    );
  }
  return valid;
}

/**
 * Summarize mixed subsystem health with deterministic prioritization:
 * failed > degraded > unknown > healthy.
 *
 * Pass the previous rollup input as `previous` to preserve last known-good
 * values when a retry comes back with a missing signal. This never invents a
 * value for a subsystem that was never observed.
 *
 * Pass `config` to tie the reused values to a configuration identity. A
 * previous value is only reused when the current and previous fingerprints
 * match; after a configuration change the old signals are rejected, the rollup
 * cannot rely on them, and a `CONFIG_SNAPSHOT_STALE` diagnostic is reported.
 */
export function summarizeTransparencyHealth(
  input: Partial<TransparencyHealthInput>,
  previous?: Partial<TransparencyHealthInput>,
  config: TransparencyHealthConfig = {},
): TransparencyHealthSummary {
  const safeInput = isPlainRecord(input) ? input : {};
  const subsystems: TransparencyHealthInput = {
    indexer: sanitizeSubsystemState(safeInput.indexer),
    relayer: sanitizeSubsystemState(safeInput.relayer),
    registry: sanitizeSubsystemState(safeInput.registry),
    smokeTest: sanitizeSubsystemState(safeInput.smokeTest),
  };

  const states = Object.values(subsystems);
  const worst = worstState(states);
  const knownSubsystems = SUBSYSTEM_KEYS.filter((key) => subsystems[key] !== "unknown");
  const contextSufficient = knownSubsystems.length >= MIN_KNOWN_SUBSYSTEMS;
  const overall: OverallHealthState = contextSufficient
    ? toOverall(worst)
    : worst === "failed"
      ? "failed"
      : "degraded";

  const attentionSubsystems = (
    Object.entries(subsystems) as Array<[keyof TransparencyHealthInput, SubsystemState]>
  )
    .filter(([, state]) => state !== "healthy")
    .sort(
      (a, b) =>
        SEVERITY_RANK[b[1]] - SEVERITY_RANK[a[1]] ||
        SUBSYSTEM_LABELS[a[0]].localeCompare(SUBSYSTEM_LABELS[b[0]]),
    )
    .map(([key]) => key);

  const needsAttention = attentionSubsystems.length > 0;

  const diagnostics = buildHealthDiagnostics(subsystems, {
    contextSufficient,
    unknownSubsystems: SUBSYSTEM_KEYS.filter((key) => subsystems[key] === "unknown"),
    reusedSubsystems,
    configStale,
  });

  let summaryMessage = "All transparency subsystems are healthy.";
  if (configStale) {
    summaryMessage =
      "Degraded: the configuration changed since these signals were observed. " +
      "Signals from the previous configuration were not reused; refresh once the " +
      "new configuration has reported.";
  } else if (!contextSufficient) {
    summaryMessage =
      `Degraded: insufficient diagnostic context — ${knownSubsystems.length} of ` +
      `${SUBSYSTEM_KEYS.length} transparency subsystems reported a status. ` +
      "Last known values were retained where available; retry once the missing signals report.";
  } else if (overall === "failed") {
    summaryMessage = `Critical: ${attentionSubsystems
      .map((key) => SUBSYSTEM_LABELS[key])
      .join(", ")} need immediate attention.`;
  } else if (overall === "degraded") {
    summaryMessage = `Degraded: ${attentionSubsystems
      .map((key) => SUBSYSTEM_LABELS[key])
      .join(", ")} require review.`;
  }

  return {
    overall,
    subsystems,
    needsAttention,
    attentionSubsystems,
    summaryMessage,
    contextSufficient,
    reusedSubsystems,
    diagnostics,
    ...(config.configFingerprint ? { configFingerprint: config.configFingerprint } : {}),
    configStale,
  };
}

interface DiagnosticContext {
  contextSufficient: boolean;
  unknownSubsystems: Array<keyof TransparencyHealthInput>;
  reusedSubsystems: Array<keyof TransparencyHealthInput>;
  configStale: boolean;
}

/**
 * Build diagnostics in a fixed order: context, failed, degraded, unknown,
 * stale. Only subsystem keys and stage labels are emitted — never raw error
 * text — so the result is safe to render to any viewer.
 */
function buildHealthDiagnostics(
  subsystems: TransparencyHealthInput,
  context: DiagnosticContext,
): TransparencyDiagnostic[] {
  const diagnostics: TransparencyDiagnostic[] = [];

  if (context.configStale) {
    diagnostics.push(
      buildTransparencyDiagnostic("CONFIG_SNAPSHOT_STALE", {
        stage: "configuration",
        affectedStages: ["configuration", "context-validation"],
      }),
    );
  }

  if (!context.contextSufficient) {
    diagnostics.push(
      buildTransparencyDiagnostic("CONTEXT_INSUFFICIENT", {
        stage: "context-validation",
        affectedStages: context.unknownSubsystems.map((key) => SUBSYSTEM_STAGES[key]),
      }),
    );
  }

  const failed = SUBSYSTEM_KEYS.filter((key) => subsystems[key] === "failed");
  if (failed.length > 0) {
    diagnostics.push(
      buildTransparencyDiagnostic("SUBSYSTEM_UNAVAILABLE", {
        stage: SUBSYSTEM_STAGES[failed[0]],
        severity: "critical",
        affectedStages: failed.map((key) => SUBSYSTEM_STAGES[key]),
      }),
    );
  }

  const degraded = SUBSYSTEM_KEYS.filter((key) => subsystems[key] === "degraded");
  if (degraded.length > 0) {
    diagnostics.push(
      buildTransparencyDiagnostic("SUBSYSTEM_UNAVAILABLE", {
        stage: SUBSYSTEM_STAGES[degraded[0]],
        severity: "warning",
        affectedStages: degraded.map((key) => SUBSYSTEM_STAGES[key]),
      }),
    );
  }

  if (context.contextSufficient && context.unknownSubsystems.length > 0) {
    diagnostics.push(
      buildTransparencyDiagnostic("SUBSYSTEM_UNAVAILABLE", {
        stage: SUBSYSTEM_STAGES[context.unknownSubsystems[0]],
        severity: "warning",
        affectedStages: context.unknownSubsystems.map((key) => SUBSYSTEM_STAGES[key]),
      }),
    );
  }

  if (context.reusedSubsystems.length > 0) {
    diagnostics.push(
      buildTransparencyDiagnostic("STALE_LAST_KNOWN", {
        stage: "cache",
        affectedStages: context.reusedSubsystems.map((key) => SUBSYSTEM_STAGES[key]),
      }),
    );
  }

  return diagnostics;
}

export function getSubsystemLabel(key: keyof TransparencyHealthInput): string {
  return SUBSYSTEM_LABELS[key];
}

export function getStateLabel(state: SubsystemState): string {
  switch (state) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "failed":
      return "Failed";
    default:
      return "Unknown";
  }
}

/** Assess registry health from current and previous registry JSON objects. */
export function assessRegistryFromRecords(
  current: Record<string, Record<string, string>>,
  previous: Record<string, Record<string, string>>,
): SubsystemState {
  if (!isPlainRecord(current) || !isPlainRecord(previous)) {
    return "unknown";
  }

  const networkKeys = Array.from(
    new Set([...Object.keys(previous), ...Object.keys(current)]),
  ).filter((key) => !key.startsWith("_"));

  if (networkKeys.length === 0) {
    return "unknown";
  }

  let hasMissing = false;
  let hasRemoved = false;
  let hasChanged = false;

  for (const net of networkKeys) {
    const rawOldNet = previous[net];
    const rawNewNet = current[net];

    if (
      (rawOldNet !== undefined && !isPlainRecord(rawOldNet)) ||
      (rawNewNet !== undefined && !isPlainRecord(rawNewNet))
    ) {
      return "unknown";
    }

    const oldNet = (rawOldNet ?? {}) as Record<string, unknown>;
    const newNet = (rawNewNet ?? {}) as Record<string, unknown>;
    const names = new Set([...Object.keys(oldNet), ...Object.keys(newNet)]);

    for (const name of names) {
      const rawOldAddr = oldNet[name];
      const rawNewAddr = newNet[name];
      if (
        (rawOldAddr !== undefined && typeof rawOldAddr !== "string") ||
        (rawNewAddr !== undefined && typeof rawNewAddr !== "string")
      ) {
        return "unknown";
      }
      const oldAddr = typeof rawOldAddr === "string" ? rawOldAddr.trim() : "";
      const newAddr = typeof rawNewAddr === "string" ? rawNewAddr.trim() : "";
      if (newAddr === "" && oldAddr !== "") hasRemoved = true;
      else if (newAddr === "" && oldAddr === "") hasMissing = true;
      else if (oldAddr !== newAddr && oldAddr !== "" && newAddr !== "") hasChanged = true;
    }
  }

  return mapRegistryHealth({ hasMissing, hasRemoved, hasChanged });
}
