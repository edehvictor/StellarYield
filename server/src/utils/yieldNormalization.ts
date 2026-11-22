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

function safeDefaultNormalizedYield(): NormalizedYield {
  return {
    protocol: "USDC",
    asset: "USDC",
    risk: "Medium",
    protocolName: "Unknown",
    apy: 0,
    rewardApy: 0,
    totalApy: 0,
    netApy: 0,
    feeDragApy: 0,
    tvl: 0,
    riskScore: 50,
    source: "",
    fetchedAt: new Date().toISOString(),
    liquidityUsd: 0,
    rebalancingBehavior: "Standard",
    managementFeeBps: 0,
    performanceFeeBps: 0,
    capitalEfficiencyPct: 0,
    netYieldAssumptions: {
      protocolFeeBps: 0,
      vaultFeeBps: 0,
      rebalanceCostBps: 0,
      slippageBps: 0,
    },
    netYieldSensitivity: [],
    capitalEfficiency: {
      score: 0,
      grade: "C",
      components: {
        utilization: 0,
        feeDrag: 0,
        rotationCost: 0,
        liquidityDepth: 0,
      },
      hasMissingInputs: true,
    },
    rewards: [],
    attribution: {
      baseYield: 0,
      incentives: 0,
      compounding: 0,
      tacticalRotation: 0,
    },
  };
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeYield(rawYield: RawProtocolYield): NormalizedYield {
  // Validate untrusted fields at the boundary - reject malformed data
  // without mutating state. Return a safe, finite default on validation failure.
  const protocolName =
    typeof rawYield?.protocolName === "string" && rawYield.protocolName.trim().length > 0
      ? rawYield.protocolName
      : null;
  const protocolType = rawYield?.protocolType;
  const apyBps = toFiniteNumber(rawYield?.apyBps);
  const tvlUsd = toFiniteNumber(rawYield?.tvlUsd);
  const volatilityPct = toFiniteNumber(rawYield?.volatilityPct);
  const protocolAgeDays = toFiniteNumber(rawYield?.protocolAgeDays);
  const source = typeof rawYield?.source === "string" ? rawYield.source : null;
  const fetchedAt =
    typeof rawYield?.fetchedAt === "string" ? rawYield.fetchedAt : null;
  const managementFeeBps = toFiniteNumber(rawYield?.managementFeeBps);
  const performanceFeeBps = toFiniteNumber(rawYield?.performanceFeeBps);
  const capitalEfficiencyPct = toFiniteNumber(rawYield?.capitalEfficiencyPct);

  if (
    !protocolName ||
    !["blend", "soroswap", "defindex"].includes(protocolType) ||
    apyBps === null ||
    tvlUsd === null ||
    tvlUsd < 0 ||
    volatilityPct === null ||
    volatilityPct < 0 ||
    protocolAgeDays === null ||
    protocolAgeDays < 0 ||
    source === null ||
    fetchedAt === null ||
    managementFeeBps === null ||
    managementFeeBps < 0 ||
    performanceFeeBps === null ||
    performanceFeeBps < 0 ||
    capitalEfficiencyPct === null ||
    !Number.isFinite(capitalEfficiencyPct)
  ) {
    return safeDefaultNormalizedYield();
  }

  // Checked, bounded arithmetic for boundary values (zero, minima, maxima, near-limits).
  // Keep inputs within safe finite ranges so emitted yield data remains display-safe.
  const safeApyBps = clamp(apyBps, -1_000_000, 10_000_000); // -10,000% .. 100,000%
  const safeTvlUsd = clamp(tvlUsd, 0, 1_000_000_000_000_000);
  const safeVolatilityPct = clamp(volatilityPct, 0, 10_000);
  const safeProtocolAgeDays = clamp(Math.floor(protocolAgeDays), 0, 365_000);
  const safeManagementFeeBps = clamp(managementFeeBps, 0, 10_000);
  const safePerformanceFeeBps = clamp(performanceFeeBps, 0, 10_000);
  const safeCapitalEfficiencyPct = clamp(capitalEfficiencyPct, 0, 10_000);
  const safeLiquidityUsd =
    toFiniteNumber(rawYield.liquidityUsd) !== null
      ? clamp(toFiniteNumber(rawYield.liquidityUsd) as number, 0, 1_000_000_000_000_000)
      : 0;
  const safeRebalancingBehavior =
    typeof rawYield.rebalancingBehavior === "string"
      ? rawYield.rebalancingBehavior
      : "Standard";

  const risk = calculateRiskScore({
    tvlUsd: safeTvlUsd,
    ilVolatilityPct: safeVolatilityPct,
    protocolAgeDays: safeProtocolAgeDays,
  });

  // Full-precision percent. Rounding happens once, where each value is emitted.
  const baseApyPrecise = bpsToApyPercent(safeApyBps);
  let rewardApyPrecise = 0;
  const rewards: {
    symbol: string;
    apy: number;
    confidence?: "low" | "medium" | "high";
  }[] = [];

  if (Array.isArray(rawYield.rewards) && safeTvlUsd > 0) {
    for (const reward of rawYield.rewards) {
      const emissionPerYear = toFiniteNumber(reward?.emissionPerYear);
      const tokenPrice = toFiniteNumber(reward?.tokenPrice);
      const tokenSymbol =
        typeof reward?.tokenSymbol === "string" ? reward.tokenSymbol : "UNKNOWN";

      if (emissionPerYear === null || tokenPrice === null) {
        continue;
      }
      if (tokenPrice <= 0) {
        console.warn(
          `Stale or missing price for reward token ${tokenSymbol}`,
        );
        continue;
      }
      if (emissionPerYear <= 0) {
        continue;
      }

      const apyPrecise =
        ((emissionPerYear * tokenPrice) / safeTvlUsd) * 100;
      if (!Number.isFinite(apyPrecise) || apyPrecise < 0) {
        continue;
      }

      // Accumulate at full precision; rounding each stream first and summing
      // the rounded values is what used to make apy + rewardApy disagree with
      // totalApy by a cent of a percent.
      rewardApyPrecise += apyPrecise;

      const rewardEntry: {
        symbol: string;
        apy: number;
        confidence?: "low" | "medium" | "high";
      } = {
        symbol: tokenSymbol,
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
    rotationCostPct: Math.min(15, safeVolatilityPct * 0.6),
    liquidityDepthUsd: safeTvlUsd,
  });

  return {
    protocol: protocolName,
    asset: protocolType === "soroswap" ? "XLM-USDC" : "USDC",
    risk: risk.label,
    protocolName,
    apy: baseApy,
    rewardApy,
    totalApy,
    netApy: netYield.netApy,
    feeDragApy: netYield.feeDragApy,
    tvl: normalizeUsd(safeTvlUsd),
    riskScore: risk.score,
    source,
    fetchedAt,
    liquidityUsd: normalizeUsd(safeLiquidityUsd),
    rebalancingBehavior: safeRebalancingBehavior,
    managementFeeBps: safeManagementFeeBps,
    performanceFeeBps: safePerformanceFeeBps,
    capitalEfficiencyPct: safeCapitalEfficiencyPct,
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
