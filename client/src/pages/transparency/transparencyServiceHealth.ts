/**
 * Pure transparency subsystem health summarization.
 *
 * Normalizes indexer, relayer, registry, and smoke-test signals into a single
 * deterministic overall status for the transparency dashboard.
 */

export type SubsystemState = "healthy" | "degraded" | "failed" | "unknown";

export type OverallHealthState = "healthy" | "degraded" | "failed";

export interface TransparencyHealthInput {
  indexer: SubsystemState;
  relayer: SubsystemState;
  registry: SubsystemState;
  smokeTest: SubsystemState;
}

export interface TransparencyHealthSummary {
  overall: OverallHealthState;
  subsystems: TransparencyHealthInput;
  needsAttention: boolean;
  /** Subsystems that are not healthy, ordered by severity then name. */
  attentionSubsystems: Array<keyof TransparencyHealthInput>;
  summaryMessage: string;
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

/** Map relayer service signals to a normalized subsystem state. */
export function mapRelayerStatus(input: {
  isOnline: boolean;
  failureCount: number;
  successRate: number;
}): SubsystemState {
  if (!input.isOnline) return "failed";
  if (input.failureCount > 0 && input.successRate < 50) return "failed";
  if (input.failureCount > 0) return "degraded";
  return "healthy";
}

/** Map registry diff summary to a normalized subsystem state. */
export function mapRegistryHealth(input: {
  hasMissing: boolean;
  hasRemoved: boolean;
  hasChanged: boolean;
}): SubsystemState {
  if (input.hasRemoved) return "failed";
  if (input.hasMissing || input.hasChanged) return "degraded";
  return "healthy";
}

/** Map smoke-test run results to a normalized subsystem state. */
export function mapSmokeTestStatus(
  status: "pass" | "fail" | null,
  checks?: Array<{ status: "pass" | "fail" }>,
): SubsystemState {
  if (status === null) return "unknown";
  if (status === "fail") return "failed";
  if (checks?.some((check) => check.status === "fail")) return "degraded";
  return "healthy";
}

/**
 * Summarize mixed subsystem health with deterministic prioritization:
 * failed > degraded > unknown > healthy.
 */
export function summarizeTransparencyHealth(
  input: Partial<TransparencyHealthInput>,
): TransparencyHealthSummary {
  const subsystems: TransparencyHealthInput = {
    indexer: input.indexer ?? "unknown",
    relayer: input.relayer ?? "unknown",
    registry: input.registry ?? "unknown",
    smokeTest: input.smokeTest ?? "unknown",
  };

  const states = Object.values(subsystems);
  const worst = worstState(states);
  const overall = toOverall(worst);

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

  let summaryMessage = "All transparency subsystems are healthy.";
  if (overall === "failed") {
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
  };
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
  let hasMissing = false;
  let hasRemoved = false;
  let hasChanged = false;

  for (const net of Object.keys(current)) {
    const oldNet = previous[net] ?? {};
    const newNet = current[net] ?? {};
    const names = new Set([...Object.keys(oldNet), ...Object.keys(newNet)]);

    for (const name of names) {
      const oldAddr = oldNet[name] ?? "";
      const newAddr = newNet[name] ?? "";
      if (newAddr === "" && oldAddr !== "") hasRemoved = true;
      else if (newAddr === "" && oldAddr === "") hasMissing = true;
      else if (oldAddr !== newAddr && oldAddr !== "" && newAddr !== "") hasChanged = true;
      else if (newAddr === "" && oldAddr === "") hasMissing = true;
    }
  }

  return mapRegistryHealth({ hasMissing, hasRemoved, hasChanged });
}
