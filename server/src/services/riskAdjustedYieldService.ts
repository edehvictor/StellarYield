import { drawdownService, DrawdownToleranceProfile } from "./drawdownService";

/**
 * Risk-Adjusted Yield (RAY) Service
 *
 * Formula:
 *   RAY = APY * (riskScore / 10) * drawdownMultiplier / (1 + drawdownProxy)
 *
 * Where:
 *   riskScore   — 1–10 safety score (10 = safest)
 *   drawdownMultiplier — derived from tolerance profile and estimated drawdown
 *   drawdownProxy = ilVolatilityPct / 10 (normalized; 0 = no risk)
 *
 * Tie resolution (deterministic total order): equal RAY → higher TVL wins →
 * equal TVL → lower strategy id wins. The final id key keeps ranking stable
 * across refreshes regardless of the input order.
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
  historicalDepthDays?: number;
}

export interface RankedStrategy extends StrategyInput {
  rank: number;
  riskAdjustedYield: number;
  drawdownProxy: number;
  estimatedDrawdown: number;
  drawdownMultiplier: number;
}

const MIN_FLOOR = 0.01;

export function computeRiskAdjustedYield(
  strategy: StrategyInput,
  profile: DrawdownToleranceProfile = 'balanced'
): number {
  const { apy, riskScore, ilVolatilityPct, historicalDepthDays = 365 } = strategy;

  if (!Number.isFinite(apy) || !Number.isFinite(riskScore) || !Number.isFinite(ilVolatilityPct)) {
    return 0;
  }

  const safeRiskScore = Math.max(0, Math.min(10, riskScore));
  const drawdownProxy = Math.max(0, ilVolatilityPct) / 10;
  const safeApy = Math.max(0, apy);

  const estimatedDrawdown = drawdownService.estimateDrawdown(ilVolatilityPct, historicalDepthDays);
  const drawdownMultiplier = drawdownService.calculateYieldMultiplier(estimatedDrawdown, profile);

  return (safeApy * (safeRiskScore / 10) * drawdownMultiplier) / Math.max(MIN_FLOOR, 1 + drawdownProxy);
}

export function rankStrategies(
  strategies: StrategyInput[],
  profile: DrawdownToleranceProfile = 'balanced'
): RankedStrategy[] {
  const withScores = strategies.map((s) => {
    const estimatedDrawdown = drawdownService.estimateDrawdown(s.ilVolatilityPct, s.historicalDepthDays || 365);
    const drawdownMultiplier = drawdownService.calculateYieldMultiplier(estimatedDrawdown, profile);
    
    return {
      ...s,
      riskAdjustedYield: computeRiskAdjustedYield(s, profile),
      drawdownProxy: Math.max(0, s.ilVolatilityPct) / 10,
      estimatedDrawdown,
      drawdownMultiplier,
    };
  });

  // Deterministic total ordering. Each key only breaks ties left by the
  // previous one, and the final `id` key guarantees a stable rank even when
  // two strategies share the same RAY *and* TVL — so ordering never depends on
  // the input array position (which varies across refreshes via failover and
  // time-window filtering).
  withScores.sort((a, b) => {
    const rayDiff = b.riskAdjustedYield - a.riskAdjustedYield;
    if (Math.abs(rayDiff) > 1e-9) return rayDiff; // 1. RAY descending (epsilon tie)
    if (b.tvlUsd !== a.tvlUsd) return b.tvlUsd - a.tvlUsd; // 2. TVL descending
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // 3. id ascending (final key)
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
