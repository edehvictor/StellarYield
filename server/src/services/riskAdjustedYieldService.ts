/**
 * Risk-Adjusted Yield (RAY) Service
 *
 * Formula:
 *   RAY = APY * (riskScore / 10) / (1 + drawdownProxy)
 *
 * Where:
 *   riskScore   — 1–10 safety score (10 = safest)
 *   drawdownProxy = ilVolatilityPct / 10 (normalized; 0 = no risk)
 *
 * Tie resolution: equal RAY → higher TVL wins.
 */

export interface StrategyInput {
  id: string;
  name: string;
  strategyType: "blend" | "soroswap" | "defindex" | string;
  apy: number;
  tvlUsd: number;
  ilVolatilityPct: number;
  riskScore: number;
  fetchedAt?: string;
}

export interface RankedStrategy extends StrategyInput {
  rank: number;
  riskAdjustedYield: number;
  drawdownProxy: number;
}

const MIN_FLOOR = 0.01;

export function computeRiskAdjustedYield(strategy: StrategyInput): number {
  const { apy, riskScore, ilVolatilityPct } = strategy;

  if (!Number.isFinite(apy) || !Number.isFinite(riskScore) || !Number.isFinite(ilVolatilityPct)) {
    return 0;
  }

  const safeRiskScore = Math.max(0, Math.min(10, riskScore));
  const drawdownProxy = Math.max(0, ilVolatilityPct) / 10;
  const safeApy = Math.max(0, apy);

  return (safeApy * (safeRiskScore / 10)) / Math.max(MIN_FLOOR, 1 + drawdownProxy);
}

export function rankStrategies(strategies: StrategyInput[]): RankedStrategy[] {
  const withScores = strategies.map((s) => ({
    ...s,
    riskAdjustedYield: computeRiskAdjustedYield(s),
    drawdownProxy: Math.max(0, s.ilVolatilityPct) / 10,
  }));

  withScores.sort((a, b) => {
    const diff = b.riskAdjustedYield - a.riskAdjustedYield;
    if (Math.abs(diff) > 1e-9) return diff;
    return b.tvlUsd - a.tvlUsd;
  });

  return withScores.map((s, i) => ({ ...s, rank: i + 1 }));
}

export type TimeWindow = "24h" | "7d" | "30d" | "all";

export function filterByTimeWindow<T extends { fetchedAt?: string }>(
  items: T[],
  window: TimeWindow,
): T[] {
  if (window === "all") return items;
  const cutoffMs: Record<Exclude<TimeWindow, "all">, number> = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  const since = Date.now() - cutoffMs[window as Exclude<TimeWindow, "all">];
  return items.filter((item) => {
    if (!item.fetchedAt) return true;
    return new Date(item.fetchedAt).getTime() >= since;
  });
}
