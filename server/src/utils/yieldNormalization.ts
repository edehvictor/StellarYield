import { calculateRiskScore } from "./riskScoring";
import type { NormalizedYield, RawProtocolYield } from "../types/yields";
import { calculateNetYield } from "../services/netYieldEngine";
import { calculateCapitalEfficiency } from "../services/capitalEfficiencyService";

const roundTo = (value: number, digits: number) =>
  Math.round(value * 10 ** digits) / 10 ** digits;

export function normalizeYield(rawYield: RawProtocolYield): NormalizedYield {
  const risk = calculateRiskScore({
    tvlUsd: rawYield.tvlUsd,
    ilVolatilityPct: rawYield.volatilityPct,
    protocolAgeDays: rawYield.protocolAgeDays,
  });

  const baseApy = roundTo(rawYield.apyBps / 100, 2);
  let rewardApy = 0;
  const rewards: { symbol: string; apy: number }[] = [];

  if (rawYield.rewards && rawYield.tvlUsd > 0) {
    for (const reward of rawYield.rewards) {
      if (reward.tokenPrice <= 0) {
        console.warn(
          `Stale or missing price for reward token ${reward.tokenSymbol}`,
        );
        continue;
      }
      const apy = (reward.emissionPerYear * reward.tokenPrice) / rawYield.tvlUsd;
      const roundedApy = roundTo(apy * 100, 2);
      rewardApy += roundedApy;
      rewards.push({
        symbol: reward.tokenSymbol,
        apy: roundedApy,
      });
    }
  }

  const netYield = calculateNetYield(baseApy + rewardApy);
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
    rewardApy: roundTo(rewardApy, 2),
    totalApy: roundTo(baseApy + rewardApy, 2),
    netApy: netYield.netApy,
    feeDragApy: netYield.feeDragApy,
    tvl: roundTo(rawYield.tvlUsd, 2),
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
      baseYield: roundTo(rawYield.apyBps / 100 * 0.7, 2),
      incentives: roundTo(rawYield.apyBps / 100 * 0.2, 2),
      compounding: roundTo(rawYield.apyBps / 100 * 0.05, 2),
      tacticalRotation: roundTo(rawYield.apyBps / 100 * 0.05, 2),
    },
  };
}

export function normalizeYields(
  rawYields: RawProtocolYield[],
): NormalizedYield[] {
  return rawYields.map(normalizeYield);
}
