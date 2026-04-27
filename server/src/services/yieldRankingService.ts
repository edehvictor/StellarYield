import NodeCache from "node-cache";
import { getYieldData } from "./yieldService";
import type { NormalizedYield } from "../types/yields";

export interface RankingWeights {
  apy: number;
  tvl: number;
  liquidity: number;
  protocolMaturity: number;
  volatility: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  apy: 0.35,
  tvl: 0.25,
  liquidity: 0.15,
  protocolMaturity: 0.15,
  volatility: 0.10,
};

export interface RankedOpportunity {
  rank: number;
  protocolName: string;
  apy: number;
  tvl: number;
  riskScore: number;
  totalScore: number;
  source: string;
  fetchedAt: string;
  breakdown: {
    apyScore: number;
    tvlScore: number;
    liquidityScore: number;
    maturityScore: number;
    volatilityScore: number;
  };
}

export interface RankingResult {
  opportunities: RankedOpportunity[];
  weights: RankingWeights;
  generatedAt: string;
  dataSources: number;
  warnings: string[];
}

const cache = new NodeCache({
  stdTTL: 300,
  checkperiod: process.env.NODE_ENV === "test" ? 0 : 60,
});
const RANKING_CACHE_KEY = "yield-rankings";

export function validateWeights(weights: Partial<RankingWeights>): RankingWeights {
  const total =
    (weights.apy || 0) +
    (weights.tvl || 0) +
    (weights.liquidity || 0) +
    (weights.protocolMaturity || 0) +
    (weights.volatility || 0);

  if (Math.abs(total - 1.0) > 0.001) {
    return { ...DEFAULT_RANKING_WEIGHTS };
  }

  return {
    apy: weights.apy ?? DEFAULT_RANKING_WEIGHTS.apy,
    tvl: weights.tvl ?? DEFAULT_RANKING_WEIGHTS.tvl,
    liquidity: weights.liquidity ?? DEFAULT_RANKING_WEIGHTS.liquidity,
    protocolMaturity:
      weights.protocolMaturity ?? DEFAULT_RANKING_WEIGHTS.protocolMaturity,
    volatility: weights.volatility ?? DEFAULT_RANKING_WEIGHTS.volatility,
  };
}

function normalizeToZeroOne(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export function scoreApy(apy: number, minApy: number, maxApy: number): number {
  return normalizeToZeroOne(apy, minApy, maxApy) * 100;
}

export function scoreTvl(tvl: number, minTvl: number, maxTvl: number): number {
  if (tvl <= 0) return 0;
  return normalizeToZeroOne(Math.log10(tvl + 1), Math.log10(minTvl + 1), Math.log10(maxTvl + 1)) * 100;
}

export function scoreLiquidity(tvl: number, minTvl: number, maxTvl: number): number {
  return scoreTvl(tvl, minTvl, maxTvl);
}

export function scoreMaturity(riskScore: number): number {
  return riskScore * 10;
}

export function scoreVolatility(riskScore: number): number {
  return (10 - riskScore) * 10;
}

export async function calculateRankings(
  customWeights?: Partial<RankingWeights>,
): Promise<RankingResult> {
  const cached = cache.get<RankingResult>(RANKING_CACHE_KEY);
  if (cached && !customWeights) {
    return cached;
  }

  const yields = await getYieldData();
  const warnings: string[] = [];

  if (yields.length === 0) {
    return {
      opportunities: [],
      weights: DEFAULT_RANKING_WEIGHTS,
      generatedAt: new Date().toISOString(),
      dataSources: 0,
      warnings: ["No yield data available from upstream providers."],
    };
  }

  const validYields = yields.filter((y) => {
    if (!y.apy || !y.tvl) {
      warnings.push(`Missing APY or TVL for ${y.protocolName}`);
      return false;
    }
    if (y.apy < 0 || y.tvl < 0) {
      warnings.push(`Invalid negative values for ${y.protocolName}`);
      return false;
    }
    return true;
  });

  if (validYields.length === 0) {
    return {
      opportunities: [],
      weights: DEFAULT_RANKING_WEIGHTS,
      generatedAt: new Date().toISOString(),
      dataSources: 0,
      warnings: ["All upstream data invalidated due to malformed values."],
    };
  }

  const weights = validateWeights(customWeights || {});

  const apyValues = validYields.map((y) => y.apy);
  const tvlValues = validYields.map((y) => y.tvl);
  const minApy = Math.min(...apyValues);
  const maxApy = Math.max(...apyValues);
  const minTvl = Math.min(...tvlValues);
  const maxTvl = Math.max(...tvlValues);

  const scored = validYields.map((yieldData) => {
    const apyScore = scoreApy(yieldData.apy, minApy, maxApy);
    const tvlScore = scoreTvl(yieldData.tvl, minTvl, maxTvl);
    const liquidityScore = scoreLiquidity(yieldData.tvl, minTvl, maxTvl);
    const maturityScore = scoreMaturity(yieldData.riskScore);
    const volatilityScore = scoreVolatility(yieldData.riskScore);

    const totalScore =
      weights.apy * apyScore +
      weights.tvl * tvlScore +
      weights.liquidity * liquidityScore +
      weights.protocolMaturity * maturityScore +
      weights.volatility * volatilityScore;

    return {
      yieldData,
      apyScore,
      tvlScore,
      liquidityScore,
      maturityScore,
      volatilityScore,
      totalScore,
    };
  });

  scored.sort((a, b) => b.totalScore - a.totalScore);

  let currentRank = 0;
  let previousScore = Number.POSITIVE_INFINITY;
  const opportunities: RankedOpportunity[] = [];

  for (const item of scored) {
    if (item.totalScore < previousScore) {
      currentRank++;
      previousScore = item.totalScore;
    }

    if (currentRank > 20) break;

    opportunities.push({
      rank: currentRank,
      protocolName: item.yieldData.protocolName,
      apy: item.yieldData.apy,
      tvl: item.yieldData.tvl,
      riskScore: item.yieldData.riskScore,
      totalScore: Math.round(item.totalScore * 100) / 100,
      source: item.yieldData.source,
      fetchedAt: item.yieldData.fetchedAt,
      breakdown: {
        apyScore: Math.round(item.apyScore * 100) / 100,
        tvlScore: Math.round(item.tvlScore * 100) / 100,
        liquidityScore: Math.round(item.liquidityScore * 100) / 100,
        maturityScore: Math.round(item.maturityScore * 100) / 100,
        volatilityScore: Math.round(item.volatilityScore * 100) / 100,
      },
    });
  }

  const result: RankingResult = {
    opportunities,
    weights,
    generatedAt: new Date().toISOString(),
    dataSources: yields.length,
    warnings,
  };

  if (!customWeights) {
    cache.set(RANKING_CACHE_KEY, result, 300);
  }

  return result;
}

export function clearRankingCache(): void {
  cache.flushAll();
}

export async function getOpportunityByRank(
  rank: number,
): Promise<RankedOpportunity | null> {
  const rankings = await calculateRankings();
  return rankings.opportunities.find((o) => o.rank === rank) || null;
}