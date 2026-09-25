import { NormalizedYield } from "../types/yields";
import { PROTOCOLS } from "../config/protocols";
import { getYieldData } from "./yieldService";

export interface RankingWeights {
  apy: number;
  liquidity: number;
  volatility: number;
  maturity: number;
  tvl: number;
}

export interface RankedOpportunity {
  protocolName: string;
  apy: number;
  tvl: number;
  liquidityUsd: number;
  volatilityPct: number;
  protocolAgeDays: number;
  scores: {
    apy: number;
    liquidity: number;
    volatility: number;
    maturity: number;
    tvl: number;
  };
  finalScore: number;
  rank: number;
  isStale: boolean;
  fetchedAt: string;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  apy: 0.4,
  liquidity: 0.2,
  volatility: 0.15,
  maturity: 0.15,
  tvl: 0.1,
};

export class OpportunityRankingService {
  /**
   * Rank active yield opportunities.
   *
   * @param customWeights Optional custom weights for ranking signals
   * @param customYields Optional custom list of yields (useful for testing/mocking)
   * @param now Optional timestamp for testing stale behavior
   */
  public static async rankOpportunities(
    customWeights?: Partial<RankingWeights>,
    customYields?: NormalizedYield[],
    now?: number
  ): Promise<RankedOpportunity[]> {
    const currentTime = now ?? Date.now();

    // 1. Resolve weights and normalize them
    const rawWeights = { ...DEFAULT_WEIGHTS, ...customWeights };
    const totalWeight =
      rawWeights.apy +
      rawWeights.liquidity +
      rawWeights.volatility +
      rawWeights.maturity +
      rawWeights.tvl;

    const weights: RankingWeights = {
      apy: totalWeight > 0 ? rawWeights.apy / totalWeight : 0,
      liquidity: totalWeight > 0 ? rawWeights.liquidity / totalWeight : 0,
      volatility: totalWeight > 0 ? rawWeights.volatility / totalWeight : 0,
      maturity: totalWeight > 0 ? rawWeights.maturity / totalWeight : 0,
      tvl: totalWeight > 0 ? rawWeights.tvl / totalWeight : 0,
    };

    // 2. Fetch live yield data
    const yields = customYields ?? (await getYieldData());

    // 3. Process and filter malformed or stale data
    const validOpportunities: Array<{
      yieldData: NormalizedYield;
      volatilityPct: number;
      protocolAgeDays: number;
    }> = [];

    for (const item of yields) {
      // Validate basic fields
      if (!item.protocolName || typeof item.totalApy !== "number" || typeof item.tvl !== "number") {
        console.warn(`Skipping malformed yield opportunity: missing core fields`, item);
        continue;
      }

      if (item.totalApy < 0 || item.tvl < 0 || item.liquidityUsd < 0) {
        console.warn(`Skipping malformed yield opportunity: negative values`, item);
        continue;
      }

      // Stale check (older than 24 hours)
      const fetchedTime = Date.parse(item.fetchedAt);
      if (isNaN(fetchedTime)) {
        console.warn(`Skipping malformed yield opportunity: invalid fetchedAt date`, item);
        continue;
      }

      const isStale = currentTime - fetchedTime > 24 * 60 * 60 * 1000;
      if (isStale) {
        console.warn(`Skipping stale yield opportunity: fetched at ${item.fetchedAt}`, item);
        continue;
      }

      // Fetch volatility and age from PROTOCOLS config or fallback
      const config = PROTOCOLS.find((p) => p.protocolName.toLowerCase() === item.protocolName.toLowerCase());
      const volatilityPct = config?.volatilityPct ?? 5.0; // fallback default
      const protocolAgeDays = config?.protocolAgeDays ?? 180; // fallback default

      if (volatilityPct < 0 || protocolAgeDays < 0) {
        console.warn(`Skipping malformed yield opportunity: invalid volatility or age`, item);
        continue;
      }

      validOpportunities.push({
        yieldData: item,
        volatilityPct,
        protocolAgeDays,
      });
    }

    if (validOpportunities.length === 0) {
      return [];
    }

    // 4. Find min and max for normalization
    let maxApy = -Infinity;
    let minApy = Infinity;
    let maxTvl = -Infinity;
    let minTvl = Infinity;
    let maxLiquidity = -Infinity;
    let minLiquidity = Infinity;
    let maxVolatility = -Infinity;
    let minVolatility = Infinity;
    let maxAge = -Infinity;
    let minAge = Infinity;

    for (const op of validOpportunities) {
      const apy = op.yieldData.totalApy;
      const tvl = op.yieldData.tvl;
      const liq = op.yieldData.liquidityUsd;
      const vol = op.volatilityPct;
      const age = op.protocolAgeDays;

      if (apy > maxApy) maxApy = apy;
      if (apy < minApy) minApy = apy;
      if (tvl > maxTvl) maxTvl = tvl;
      if (tvl < minTvl) minTvl = tvl;
      if (liq > maxLiquidity) maxLiquidity = liq;
      if (liq < minLiquidity) minLiquidity = liq;
      if (vol > maxVolatility) maxVolatility = vol;
      if (vol < minVolatility) minVolatility = vol;
      if (age > maxAge) maxAge = age;
      if (age < minAge) minAge = age;
    }

    // Helper for normalized scoring
    const normalize = (val: number, min: number, max: number, invert = false): number => {
      if (max === min) return 1.0;
      const score = (val - min) / (max - min);
      return invert ? 1.0 - score : score;
    };

    // 5. Score and rank opportunities
    const scoredOpportunities: RankedOpportunity[] = validOpportunities.map((op) => {
      const apyScore = normalize(op.yieldData.totalApy, minApy, maxApy);
      const tvlScore = normalize(op.yieldData.tvl, minTvl, maxTvl);
      const liqScore = normalize(op.yieldData.liquidityUsd, minLiquidity, maxLiquidity);
      const volScore = normalize(op.volatilityPct, minVolatility, maxVolatility, true); // lower is better
      const ageScore = normalize(op.protocolAgeDays, minAge, maxAge);

      const finalScore =
        apyScore * weights.apy +
        tvlScore * weights.tvl +
        liqScore * weights.liquidity +
        volScore * weights.volatility +
        ageScore * weights.maturity;

      return {
        protocolName: op.yieldData.protocolName,
        apy: op.yieldData.totalApy,
        tvl: op.yieldData.tvl,
        liquidityUsd: op.yieldData.liquidityUsd,
        volatilityPct: op.volatilityPct,
        protocolAgeDays: op.protocolAgeDays,
        scores: {
          apy: parseFloat(apyScore.toFixed(4)),
          liquidity: parseFloat(liqScore.toFixed(4)),
          volatility: parseFloat(volScore.toFixed(4)),
          maturity: parseFloat(ageScore.toFixed(4)),
          tvl: parseFloat(tvlScore.toFixed(4)),
        },
        finalScore: parseFloat(finalScore.toFixed(4)),
        rank: 0, // Assigned after sorting
        isStale: false,
        fetchedAt: op.yieldData.fetchedAt,
      };
    });

    // 6. Sort by final score descending with tie-breakers: APY (desc), TVL (desc), then Alphabetical
    scoredOpportunities.sort((a, b) => {
      if (Math.abs(a.finalScore - b.finalScore) > 1e-9) {
        return b.finalScore - a.finalScore;
      }
      if (Math.abs(a.apy - b.apy) > 1e-9) {
        return b.apy - a.apy;
      }
      if (Math.abs(a.tvl - b.tvl) > 1e-9) {
        return b.tvl - a.tvl;
      }
      return a.protocolName.localeCompare(b.protocolName);
    });

    // 7. Assign ranks
    scoredOpportunities.forEach((op, index) => {
      op.rank = index + 1;
    });

    return scoredOpportunities;
  }
}
