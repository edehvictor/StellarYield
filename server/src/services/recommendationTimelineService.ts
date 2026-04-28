export interface RecommendationInputSnapshot {
  riskTolerance: string;
  expectedApy: number;
  liquidityDepthUsd: number;
  volatilityPct: number;
}

export interface RecommendationTimelineEntry {
  id: string;
  recommendation: string;
  rationale: string;
  targetVault: string;
  changedInputs: string[];
  inputSnapshot: RecommendationInputSnapshot;
  timestamp: string;
}

const MAX_ENTRIES_PER_USER = 20;
const historyStore = new Map<string, RecommendationTimelineEntry[]>();

function sanitizeText(text: string): string {
  return text
    .replace(/(api[_-]?key|secret|token)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/_-]{24,}/g, "[redacted]")
    .slice(0, 500);
}

function diffInputs(
  previous: RecommendationInputSnapshot | null,
  current: RecommendationInputSnapshot,
): string[] {
  if (!previous) return ["initial-baseline"];
  const changed: string[] = [];
  if (previous.riskTolerance !== current.riskTolerance) changed.push("riskTolerance");
  if (Math.abs(previous.expectedApy - current.expectedApy) >= 0.5) changed.push("expectedApy");
  if (Math.abs(previous.liquidityDepthUsd - current.liquidityDepthUsd) >= 50_000) {
    changed.push("liquidityDepthUsd");
  }
  if (Math.abs(previous.volatilityPct - current.volatilityPct) >= 1) {
    changed.push("volatilityPct");
  }
  return changed;
}

export function recordRecommendation(
  userId: string,
  payload: Omit<RecommendationTimelineEntry, "id" | "timestamp" | "changedInputs"> & {
    inputSnapshot: RecommendationInputSnapshot;
  },
): RecommendationTimelineEntry {
  const existing = historyStore.get(userId) ?? [];
  const previous = existing[0]?.inputSnapshot ?? null;
  const entry: RecommendationTimelineEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    recommendation: sanitizeText(payload.recommendation),
    rationale: sanitizeText(payload.rationale),
    targetVault: sanitizeText(payload.targetVault),
    changedInputs: diffInputs(previous, payload.inputSnapshot),
    inputSnapshot: payload.inputSnapshot,
    timestamp: new Date().toISOString(),
  };
  const next = [entry, ...existing].slice(0, MAX_ENTRIES_PER_USER);
  historyStore.set(userId, next);
  return entry;
}

export function getRecommendationTimeline(userId: string): RecommendationTimelineEntry[] {
  return historyStore.get(userId) ?? [];
}

export function resetRecommendationTimelineStore(): void {
  historyStore.clear();
}
