export interface RecommendationOutput {
  /**
   * Stable identifier for matching items across releases (e.g. vault id).
   */
  id: string;
  rank: number;
  score: number;
  confidence: number; // 0-1
}

export interface RecommendationStabilityChange {
  id: string;
  before: RecommendationOutput | null;
  after: RecommendationOutput | null;
  rankDelta: number | null;
  scoreDelta: number | null;
  confidenceDelta: number | null;
  isLargeChange: boolean;
}

export interface RecommendationStabilityConfig {
  topK: number;
  rankChangeThreshold: number;
  scoreChangeThreshold: number;
  confidenceChangeThreshold: number;
}

export interface RecommendationStabilityReport {
  baseline: {
    testSetId?: string;
    beforeRelease?: string;
    afterRelease?: string;
    comparedAt: string;
  };
  summary: {
    totalItems: number;
    largeChanges: number;
    stabilityScore: number; // 0-1, higher = more stable
  };
  changes: RecommendationStabilityChange[];
  topChanges: RecommendationStabilityChange[];
}

const DEFAULT_CONFIG: RecommendationStabilityConfig = {
  topK: 10,
  rankChangeThreshold: 3,
  scoreChangeThreshold: 0.1,
  confidenceChangeThreshold: 0.1,
};

function absFinite(n: number | null): number {
  if (n === null) return 1;
  return Math.abs(n);
}

export function compareRecommendationSets(
  before: RecommendationOutput[],
  after: RecommendationOutput[],
  config: Partial<RecommendationStabilityConfig> = {},
): RecommendationStabilityChange[] {
  const cfg: RecommendationStabilityConfig = { ...DEFAULT_CONFIG, ...config };

  const beforeMap = new Map(before.map((r) => [r.id, r]));
  const afterMap = new Map(after.map((r) => [r.id, r]));
  const ids = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);

  const changes: RecommendationStabilityChange[] = [];

  for (const id of ids) {
    const b = beforeMap.get(id) ?? null;
    const a = afterMap.get(id) ?? null;

    const rankDelta = b && a ? a.rank - b.rank : null;
    const scoreDelta = b && a ? a.score - b.score : null;
    const confidenceDelta = b && a ? a.confidence - b.confidence : null;

    const isMissing = !b || !a;

    const isLargeChange =
      isMissing ||
      (rankDelta !== null && Math.abs(rankDelta) >= cfg.rankChangeThreshold) ||
      (scoreDelta !== null && Math.abs(scoreDelta) >= cfg.scoreChangeThreshold) ||
      (confidenceDelta !== null &&
        Math.abs(confidenceDelta) >= cfg.confidenceChangeThreshold);

    changes.push({
      id,
      before: b,
      after: a,
      rankDelta,
      scoreDelta,
      confidenceDelta,
      isLargeChange,
    });
  }

  // Sort: largest absolute rank changes first, then score/confidence deltas.
  changes.sort((x, y) => {
    const rankAbsX = absFinite(x.rankDelta);
    const rankAbsY = absFinite(y.rankDelta);
    if (rankAbsY !== rankAbsX) return rankAbsY - rankAbsX;

    const scoreAbsX = absFinite(x.scoreDelta);
    const scoreAbsY = absFinite(y.scoreDelta);
    if (scoreAbsY !== scoreAbsX) return scoreAbsY - scoreAbsX;

    const confAbsX = absFinite(x.confidenceDelta);
    const confAbsY = absFinite(y.confidenceDelta);
    if (confAbsY !== confAbsX) return confAbsY - confAbsX;

    return x.id.localeCompare(y.id);
  });

  return changes;
}

export function generateRecommendationStabilityReport(
  before: RecommendationOutput[],
  after: RecommendationOutput[],
  baseline: {
    testSetId?: string;
    beforeRelease?: string;
    afterRelease?: string;
  } = {},
  config: Partial<RecommendationStabilityConfig> = {},
): RecommendationStabilityReport {
  const cfg: RecommendationStabilityConfig = { ...DEFAULT_CONFIG, ...config };

  const changes = compareRecommendationSets(before, after, cfg);
  const topChanges = changes.filter((c) => c.isLargeChange).slice(0, cfg.topK);

  const totalItems = changes.length;
  const largeChanges = changes.filter((c) => c.isLargeChange).length;

  // Stability score: 1 - average normalized change severity.
  // Missing items count as maximum instability.
  const severitySum = changes.reduce((sum, c) => {
    const rankSev =
      c.rankDelta === null
        ? 1
        : Math.min(1, Math.abs(c.rankDelta) / cfg.rankChangeThreshold);
    const scoreSev =
      c.scoreDelta === null
        ? 1
        : Math.min(1, Math.abs(c.scoreDelta) / cfg.scoreChangeThreshold);
    const confidenceSev =
      c.confidenceDelta === null
        ? 1
        : Math.min(1, Math.abs(c.confidenceDelta) / cfg.confidenceChangeThreshold);

    // Rank tends to be most user-visible, so slightly weight it.
    const severity = 0.5 * rankSev + 0.3 * scoreSev + 0.2 * confidenceSev;
    return sum + severity;
  }, 0);

  const avgSeverity = totalItems > 0 ? severitySum / totalItems : 0;
  const stabilityScore = Math.round((1 - avgSeverity) * 1000) / 1000;

  return {
    baseline: {
      ...baseline,
      comparedAt: new Date().toISOString(),
    },
    summary: {
      totalItems,
      largeChanges,
      stabilityScore: Math.max(0, Math.min(1, stabilityScore)),
    },
    changes,
    topChanges,
  };
}

