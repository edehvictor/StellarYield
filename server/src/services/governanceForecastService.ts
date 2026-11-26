/**
 * Governance Proposal Impact Forecast Service
 *
 * Estimates the impact of governance parameter changes on yield, exposure,
 * and fee behavior. Forecasts are modeled outcomes, not guaranteed results.
 *
 * Rounding & Boundary Calculation Policy:
 * - Calculations use checked arithmetic guarding against NaN, non-finite values, and division by zero.
 * - Yield and exposure deltas (yieldDeltaPct, exposureDeltaPct) are rounded half-up to 4 decimal places
 *   (0.0001% = 0.01 bps).
 * - Projected yield (projectedYieldPct) is rounded to 4 decimal places and clamped within the supported domain [-100, 1000].
 * - Projected exposure (projectedExposurePct) is rounded to 4 decimal places and clamped strictly within [0, 100].
 * - Fee rate (projectedFeeRatePct) is rounded to 4 decimal places and clamped strictly within [0, 100].
 * - Fee revenue delta (feeRevenueDeltaUsd) is rounded half-up to 2 decimal places (0.01 USD / cents).
 * - Multipliers (apyMultiplier, riskMultiplier) are strictly validated and clamped to safe positive ranges [0.01, 1000].
 * - Negative zeroes (-0) are sanitized to 0 across all projections.
 */

export type ProposalType = "fee_change" | "allocation_limit" | "strategy_param" | "reward_change";

export interface GovernanceForecastInput {
  proposalType: ProposalType;
  parameters: Record<string, number>;
  baseline: {
    yieldPct: number;
    exposurePct: number;
    feeRatePct: number;
    tvlUsd: number;
    riskScore?: number;
    vaultCount?: number;
  };
}

export interface ForecastDelta {
  yieldDeltaPct: number;
  exposureDeltaPct: number;
  feeRevenueDeltaUsd: number;
  projectedYieldPct: number;
  projectedExposurePct: number;
  projectedFeeRatePct: number;
}

export interface GovernanceForecastResult {
  proposalType: ProposalType;
  parameters: Record<string, number>;
  baseline: GovernanceForecastInput["baseline"];
  forecast: ForecastDelta;
  impactSummary: {
    headline: string;
    riskLevel: "low" | "medium" | "high";
    noOp: boolean;
    irreversible: boolean;
    affectedVaults: string[];
  };
  warnings: string[];
  disclaimer: string;
}

const DISCLAIMER =
  "Forecasts are modeled estimates based on current parameters. Actual outcomes may differ due to market conditions.";

/**
 * Standard rounding to fixed decimal places with round half-up behavior.
 * Sanitizes -0 to 0 and guards against non-finite values.
 */
export function roundToDecimals(val: number, decimals: number): number {
  if (!Number.isFinite(val)) return 0;
  const factor = Math.pow(10, decimals);
  const rounded = Math.round((val + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Clamps a numeric value within [min, max], guarding against non-finite values.
 */
export function clampNumber(val: number, min: number, max: number): number {
  if (Number.isNaN(val)) return min;
  if (val > max) return max;
  if (val < min) return min;
  return val;
}

function forecastFeeChange(
  params: Record<string, number>,
  baseline: GovernanceForecastInput["baseline"],
): { delta: ForecastDelta; warnings: string[] } {
  const warnings: string[] = [];
  const rawFeeRate = params.feeRatePct;
  const newFeeRate =
    typeof rawFeeRate === "number" && Number.isFinite(rawFeeRate)
      ? rawFeeRate
      : baseline.feeRatePct;

  if (newFeeRate < 0 || newFeeRate > 100) {
    warnings.push("feeRatePct must be between 0 and 100");
  }

  const clampedFee = clampNumber(newFeeRate, 0, 100);
  const safeBaseFee = clampNumber(baseline.feeRatePct, 0, 100);
  const safeBaseYield = Number.isFinite(baseline.yieldPct) ? baseline.yieldPct : 0;
  const safeBaseTvl = Math.max(0, Number.isFinite(baseline.tvlUsd) ? baseline.tvlUsd : 0);
  const safeBaseExposure = clampNumber(baseline.exposurePct, 0, 100);

  const feeRateDelta = clampedFee - safeBaseFee;

  // Documented rounding: yieldImpactPct = -(feeRateDelta / 100) * baseline.yieldPct
  const yieldImpactPct = -(feeRateDelta / 100) * safeBaseYield;

  const feeRevenueDeltaUsd =
    (feeRateDelta / 100) * safeBaseTvl * (safeBaseYield / 100);

  const roundedYieldDelta = roundToDecimals(yieldImpactPct, 4);
  const roundedFeeRevDelta = roundToDecimals(feeRevenueDeltaUsd, 2);
  const projectedYield = clampNumber(roundToDecimals(safeBaseYield + yieldImpactPct, 4), -100, 1000);

  return {
    delta: {
      yieldDeltaPct: roundedYieldDelta,
      exposureDeltaPct: 0,
      feeRevenueDeltaUsd: roundedFeeRevDelta,
      projectedYieldPct: projectedYield,
      projectedExposurePct: safeBaseExposure,
      projectedFeeRatePct: roundToDecimals(clampedFee, 4),
    },
    warnings,
  };
}

function forecastAllocationLimit(
  params: Record<string, number>,
  baseline: GovernanceForecastInput["baseline"],
): { delta: ForecastDelta; warnings: string[] } {
  const warnings: string[] = [];
  const rawMaxConcentration = params.maxConcentrationPct;
  const newMaxConcentration =
    typeof rawMaxConcentration === "number" && Number.isFinite(rawMaxConcentration)
      ? rawMaxConcentration
      : baseline.exposurePct;

  if (newMaxConcentration < 0 || newMaxConcentration > 100) {
    warnings.push("maxConcentrationPct must be between 0 and 100");
  }

  const clampedMax = clampNumber(newMaxConcentration, 0, 100);
  const safeBaseExposure = clampNumber(baseline.exposurePct, 0, 100);
  const safeBaseYield = Number.isFinite(baseline.yieldPct) ? baseline.yieldPct : 0;
  const safeBaseFee = clampNumber(baseline.feeRatePct, 0, 100);

  const exposureDelta = clampedMax - safeBaseExposure;

  // Documented rounding: 0.02 yield reduction per 1% concentration reduction bonus
  const diversificationBonus = exposureDelta < 0 ? Math.abs(exposureDelta) * 0.02 : 0;
  const yieldDelta = -diversificationBonus;

  return {
    delta: {
      yieldDeltaPct: roundToDecimals(yieldDelta, 4),
      exposureDeltaPct: roundToDecimals(exposureDelta, 4),
      feeRevenueDeltaUsd: 0,
      projectedYieldPct: clampNumber(roundToDecimals(safeBaseYield + yieldDelta, 4), -100, 1000),
      projectedExposurePct: roundToDecimals(clampedMax, 4),
      projectedFeeRatePct: roundToDecimals(safeBaseFee, 4),
    },
    warnings,
  };
}

function forecastStrategyParam(
  params: Record<string, number>,
  baseline: GovernanceForecastInput["baseline"],
): { delta: ForecastDelta; warnings: string[] } {
  const warnings: string[] = [];
  const rawApy = params.apyMultiplier;
  const rawRisk = params.riskMultiplier;

  const apyMultiplier = typeof rawApy === "number" && Number.isFinite(rawApy) ? rawApy : 1;
  const riskMultiplier = typeof rawRisk === "number" && Number.isFinite(rawRisk) ? rawRisk : 1;

  if (apyMultiplier <= 0) warnings.push("apyMultiplier must be > 0");
  if (riskMultiplier <= 0) warnings.push("riskMultiplier must be > 0");

  const safeApyMul = clampNumber(apyMultiplier, 0.01, 1000);
  const safeRiskMul = clampNumber(riskMultiplier, 0.01, 1000);

  const safeBaseYield = Number.isFinite(baseline.yieldPct) ? baseline.yieldPct : 0;
  const safeBaseExposure = clampNumber(baseline.exposurePct, 0, 100);
  const safeBaseFee = clampNumber(baseline.feeRatePct, 0, 100);
  const safeBaseTvl = Math.max(0, Number.isFinite(baseline.tvlUsd) ? baseline.tvlUsd : 0);

  const yieldDelta = safeBaseYield * (safeApyMul - 1);
  const exposureDelta = safeBaseExposure * (safeRiskMul - 1);

  const projectedExposure = clampNumber(safeBaseExposure + exposureDelta, 0, 100);

  const feeRevenueDeltaUsd =
    (safeBaseFee / 100) * safeBaseTvl * (yieldDelta / 100);

  return {
    delta: {
      yieldDeltaPct: roundToDecimals(yieldDelta, 4),
      exposureDeltaPct: roundToDecimals(exposureDelta, 4),
      feeRevenueDeltaUsd: roundToDecimals(feeRevenueDeltaUsd, 2),
      projectedYieldPct: clampNumber(roundToDecimals(safeBaseYield + yieldDelta, 4), -100, 1000),
      projectedExposurePct: roundToDecimals(projectedExposure, 4),
      projectedFeeRatePct: roundToDecimals(safeBaseFee, 4),
    },
    warnings,
  };
}

function forecastRewardChange(
  params: Record<string, number>,
  baseline: GovernanceForecastInput["baseline"],
): { delta: ForecastDelta; warnings: string[] } {
  const warnings: string[] = [];
  const rawReward = params.rewardApyDelta;
  const rewardApyDelta = typeof rawReward === "number" && Number.isFinite(rawReward) ? rawReward : 0;
  const isHighConfidence = params.isHighConfidence === 1;

  if (!isHighConfidence) {
    warnings.push("Unknown or incomplete schedules must not be treated as high-confidence positive yield.");
  }

  const safeBaseYield = Number.isFinite(baseline.yieldPct) ? baseline.yieldPct : 0;
  const safeBaseExposure = clampNumber(baseline.exposurePct, 0, 100);
  const safeBaseFee = clampNumber(baseline.feeRatePct, 0, 100);

  const clampedRewardDelta = clampNumber(rewardApyDelta, -100, 1000);
  const projectedYield = clampNumber(safeBaseYield + clampedRewardDelta, -100, 1000);

  return {
    delta: {
      yieldDeltaPct: roundToDecimals(clampedRewardDelta, 4),
      exposureDeltaPct: 0,
      feeRevenueDeltaUsd: 0,
      projectedYieldPct: roundToDecimals(projectedYield, 4),
      projectedExposurePct: roundToDecimals(safeBaseExposure, 4),
      projectedFeeRatePct: roundToDecimals(safeBaseFee, 4),
    },
    warnings,
  };
}

function buildImpactSummary(
  input: GovernanceForecastInput,
  delta: ForecastDelta,
  warnings: string[],
): GovernanceForecastResult["impactSummary"] {
  const noOp =
    Math.abs(delta.yieldDeltaPct) < 0.0001 &&
    Math.abs(delta.exposureDeltaPct) < 0.0001 &&
    Math.abs(delta.feeRevenueDeltaUsd) < 0.01 &&
    Math.abs(delta.projectedFeeRatePct - input.baseline.feeRatePct) < 0.0001;

  const irreversible =
    (input.proposalType === "fee_change" &&
      (delta.projectedFeeRatePct === 0 || delta.projectedFeeRatePct === 100)) ||
    (input.proposalType === "allocation_limit" &&
      delta.projectedExposurePct === 0);

  const baselineRisk = clampNumber(
    typeof input.baseline.riskScore === "number" && Number.isFinite(input.baseline.riskScore)
      ? input.baseline.riskScore
      : 50,
    0,
    100,
  );
  const projectedRisk = clampNumber(
    baselineRisk +
      Math.max(0, delta.projectedExposurePct - input.baseline.exposurePct) * 0.6 +
      (input.proposalType === "strategy_param" ? 8 : 0) +
      (input.proposalType === "reward_change" ? 4 : 0),
    0,
    100,
  );

  const riskLevel =
    warnings.length > 0 || projectedRisk >= 75
      ? "high"
      : projectedRisk >= 55
        ? "medium"
        : "low";

  const rawVaultCount = input.baseline.vaultCount;
  const safeVaultCount =
    typeof rawVaultCount === "number" && Number.isFinite(rawVaultCount)
      ? Math.max(1, Math.min(100, Math.floor(rawVaultCount)))
      : 3;
  const affectedVaults = Array.from(
    { length: Math.min(safeVaultCount, 4) },
    (_, index) => `Vault-${index + 1}`,
  );

  let headline = "Proposal impact appears manageable.";
  if (noOp) {
    headline = "Proposal is effectively a no-op against the current baseline.";
  } else if (riskLevel === "high") {
    headline =
      "Proposal may materially increase user risk or reduce reversibility.";
  } else if (delta.yieldDeltaPct > 0) {
    headline = "Proposal projects a positive yield change with bounded risk.";
  }

  return {
    headline,
    riskLevel,
    noOp,
    irreversible,
    affectedVaults,
  };
}

export function forecastGovernanceProposal(
  input: GovernanceForecastInput,
): GovernanceForecastResult {
  let result: { delta: ForecastDelta; warnings: string[] };

  switch (input.proposalType) {
    case "fee_change":
      result = forecastFeeChange(input.parameters, input.baseline);
      break;
    case "allocation_limit":
      result = forecastAllocationLimit(input.parameters, input.baseline);
      break;
    case "strategy_param":
      result = forecastStrategyParam(input.parameters, input.baseline);
      break;
    case "reward_change":
      result = forecastRewardChange(input.parameters, input.baseline);
      break;
    default:
      result = {
        delta: {
          yieldDeltaPct: 0,
          exposureDeltaPct: 0,
          feeRevenueDeltaUsd: 0,
          projectedYieldPct: roundToDecimals(input.baseline.yieldPct, 4),
          projectedExposurePct: roundToDecimals(input.baseline.exposurePct, 4),
          projectedFeeRatePct: roundToDecimals(input.baseline.feeRatePct, 4),
        },
        warnings: ["Unknown proposal type — no forecast computed"],
      };
  }

  return {
    proposalType: input.proposalType,
    parameters: input.parameters,
    baseline: input.baseline,
    forecast: result.delta,
    impactSummary: buildImpactSummary(input, result.delta, result.warnings),
    warnings: result.warnings,
    disclaimer: DISCLAIMER,
  };
}
