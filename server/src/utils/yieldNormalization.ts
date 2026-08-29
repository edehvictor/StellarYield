import { calculateRiskScore } from "./riskScoring";
import type { NormalizedYield, RawProtocolYield } from "../types/yields";
import { calculateNetYield } from "../services/netYieldEngine";
import { calculateCapitalEfficiency } from "../services/capitalEfficiencyService";
import {
  bpsToApyPercent,
  normalizeApyPercent,
  normalizeUsd,
} from "./yieldNormalizationContract";

export {
  APY_DECIMALS,
  APY_ULP,
  USD_DECIMALS,
  USD_ULP,
  YIELD_NORMALIZATION_CONTRACT,
  blendApyPercent,
  bpsToApyPercent,
  decimalsOf,
  isAtApyPrecision,
  isAtUsdPrecision,
  normalizeApyPercent,
  normalizeUsd,
  roundTo,
} from "./yieldNormalizationContract";

export {
  checkYieldParity,
  formatParityReport,
} from "./yieldParity";
export type {
  ComparableYield,
  YieldParityCode,
  YieldParityIssue,
  YieldParityReport,
} from "./yieldParity";

export function normalizeYield(rawYield: RawProtocolYield): NormalizedYield {
  const risk = calculateRiskScore({
    tvlUsd: rawYield.tvlUsd,
    ilVolatilityPct: rawYield.volatilityPct,
    protocolAgeDays: rawYield.protocolAgeDays,
  });

  // Full-precision percent. Rounding happens once, where each value is emitted.
  const baseApyPrecise = bpsToApyPercent(rawYield.apyBps);
  let rewardApyPrecise = 0;
  const rewards: { symbol: string; apy: number; confidence?: "low" | "medium" | "high" }[] = [];

  if (rawYield.rewards && rawYield.tvlUsd > 0) {
    for (const reward of rawYield.rewards) {
      if (reward.tokenPrice <= 0) {
        console.warn(
          `Stale or missing price for reward token ${reward.tokenSymbol}`,
        );
        continue;
      }
      const apyPrecise =
        ((reward.emissionPerYear * reward.tokenPrice) / rawYield.tvlUsd) * 100;

      // Accumulate at full precision; rounding each stream first and summing
      // the rounded values is what used to make apy + rewardApy disagree with
      // totalApy by a cent of a percent.
      rewardApyPrecise += apyPrecise;

      const rewardEntry: { symbol: string; apy: number; confidence?: "low" | "medium" | "high" } = {
        symbol: reward.tokenSymbol,
        apy: normalizeApyPercent(apyPrecise),
      };

      if (reward.confidence) {
        rewardEntry.confidence = reward.confidence;
      }

      rewards.push(rewardEntry);
    }
  }

  const baseApy = normalizeApyPercent(baseApyPrecise);
  const rewardApy = normalizeApyPercent(rewardApyPrecise);
  const totalApy = normalizeApyPercent(baseApyPrecise + rewardApyPrecise);

  // Contract rule: downstream values are derived from the *emitted* gross APY,
  // never from a privately recomputed intermediate. `/api/yields` re-derives
  // net yield from `totalApy`; deriving it here from anything else is exactly
  // the mismatch the parity checks exist to catch.
  const netYield = calculateNetYield(totalApy);
  const capitalEfficiency = calculateCapitalEfficiency({
    utilizationPct: Math.min(100, 45 + baseApy * 2.5),
    feeDragPct: netYield.feeDragApy,
    rotationCostPct: Math.min(15, rawYield.volatilityPct * 0.6),
    liquidityDepthUsd: rawYield.tvlUsd,
  });

  return {
    protocol: rawYield.protocolName,
    asset: rawYield.protocolType === "soroswap" ? "XLM-USDC" : "USDC",
    risk: risk.label,
    protocolName: rawYield.protocolName,
    apy: baseApy,
    rewardApy,
    totalApy,
    netApy: netYield.netApy,
    feeDragApy: netYield.feeDragApy,
    tvl: normalizeUsd(rawYield.tvlUsd),
    riskScore: risk.score,
    source: rawYield.source,
    fetchedAt: rawYield.fetchedAt,
    liquidityUsd: rawYield.liquidityUsd,
    rebalancingBehavior: rawYield.rebalancingBehavior,
    managementFeeBps: rawYield.managementFeeBps,
    performanceFeeBps: rawYield.performanceFeeBps,
    capitalEfficiencyPct: rawYield.capitalEfficiencyPct,
    netYieldAssumptions: netYield.assumptions,
    netYieldSensitivity: netYield.sensitivity,
    capitalEfficiency,
    rewards,
    attribution: rawYield.attribution || {
      baseYield: normalizeApyPercent(baseApyPrecise * 0.7),
      incentives: normalizeApyPercent(baseApyPrecise * 0.2),
      compounding: normalizeApyPercent(baseApyPrecise * 0.05),
      tacticalRotation: normalizeApyPercent(baseApyPrecise * 0.05),
    },
  };
}

export function normalizeYields(
  rawYields: RawProtocolYield[],
): NormalizedYield[] {
  return rawYields.map(normalizeYield);
}
