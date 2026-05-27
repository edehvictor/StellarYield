/**
 * Governance Proposal Impact Forecast Service
 *
 * Estimates the impact of governance parameter changes on yield, exposure,
 * and fee behavior. Forecasts are modeled outcomes, not guaranteed results.
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

function forecastFeeChange(
  params: Record<string, number>,
  baseline: GovernanceForecastInput["baseline"],
): { delta: ForecastDelta; warnings: string[] } {
  const warnings: string[] = [];
  const newFeeRate = params.feeRatePct ?? baseline.feeRatePct;

  if (newFeeRate < 0 || newFeeRate > 100) {
    warnings.push("feeRatePct must be between 0 and 100");
  }

  const clampedFee = Math.max(0, Math.min(100, newFeeRate));
  const feeRateDelta = clampedFee - baseline.feeRatePct;

  const yieldImpactPct = -(feeRateDelta / 100) * baseline.yieldPct;

  const feeRevenueDeltaUsd =
    (feeRateDelta / 100) * baseline.tvlUsd * (baseline.yieldPct / 100);

  return {
    delta: {
      yieldDeltaPct: Math.round(yieldImpactPct * 10000) / 10000 || 0,
      exposureDeltaPct: 0,
      feeRevenueDeltaUsd: Math.round(feeRevenueDeltaUsd * 100) / 100 || 0,
      projectedYieldPct:
        Math.round((baseline.yieldPct + yieldImpactPct) * 10000) / 10000 || 0,
      projectedExposurePct: baseline.exposurePct,
      projectedFeeRatePct: clampedFee,
    },
    warnings,
  };
}

function forecastAllocationLimit(
  params: Record<string, number>,
  baseline: GovernanceForecastInput["baseline"],
): { delta: ForecastDelta; warnings: string[] } {
  const warnings: string[] = [];
  const newMaxConcentration = params.maxConcentrationPct ?? baseline.exposurePct;

  if (newMaxConcentration < 0 || newMaxConcentration > 100) {
    warnings.push("maxConcentrationPct must be between 0 and 100");
  }

  const clampedMax = Math.max(0, Math.min(100, newMaxConcentration));
  const exposureDelta = clampedMax - baseline.exposurePct;

  const diversificationBonus = exposureDelta < 0 ? Math.abs(exposureDelta) * 0.02 : 0;
  const yieldDelta = -diversificationBonus;

  return {
    delta: {
      yieldDeltaPct: Math.round(yieldDelta * 10000) / 10000,
      exposureDeltaPct: Math.round(exposureDelta * 10000) / 10000,
      feeRevenueDeltaUsd: 0,
      projectedYieldPct:
        Math.round((baseline.yieldPct + yieldDelta) * 10000) / 10000,
      projectedExposurePct: clampedMax,
      projectedFeeRatePct: baseline.feeRatePct,
    },
    warnings,
  };
}

function forecastStrategyParam(
  params: Record<string, number>,
  baseline: GovernanceForecastInput["baseline"],
): { delta: ForecastDelta; warnings: string[] } {
  const warnings: string[] = [];
  const apyMultiplier = params.apyMultiplier ?? 1;
  const riskMultiplier = params.riskMultiplier ?? 1;

  if (apyMultiplier <= 0) warnings.push("apyMultiplier must be > 0");
  if (riskMultiplier <= 0) warnings.push("riskMultiplier must be > 0");

  const safeApyMul = Math.max(0.01, apyMultiplier);
  const yieldDelta = baseline.yieldPct * (safeApyMul - 1);
  const exposureDelta = baseline.exposurePct * (riskMultiplier - 1);

  return {
    delta: {
      yieldDeltaPct: Math.round(yieldDelta * 10000) / 10000,
      exposureDeltaPct: Math.round(exposureDelta * 10000) / 10000,
      feeRevenueDeltaUsd:
        Math.round(
          (baseline.feeRatePct / 100) *
            baseline.tvlUsd *
            (yieldDelta / 100) *
            100,
        ) / 100,
      projectedYieldPct:
        Math.round((baseline.yieldPct + yieldDelta) * 10000) / 10000,
      projectedExposurePct: Math.min(
        100,
        Math.max(0, baseline.exposurePct + exposureDelta),
      ),
      projectedFeeRatePct: baseline.feeRatePct,
    },
    warnings,
  };
}

function forecastRewardChange(
  params: Record<string, number>,
  baseline: GovernanceForecastInput["baseline"],
): { delta: ForecastDelta; warnings: string[] } {
  const warnings: string[] = [];
  const rewardApyDelta = params.rewardApyDelta ?? 0;
  const isHighConfidence = params.isHighConfidence === 1;

  if (!isHighConfidence) {
    warnings.push("Unknown or incomplete schedules must not be treated as high-confidence positive yield.");
  }

  const projectedYield = baseline.yieldPct + rewardApyDelta;

  return {
    delta: {
      yieldDeltaPct: Math.round(rewardApyDelta * 10000) / 10000,
      exposureDeltaPct: 0,
      feeRevenueDeltaUsd: 0,
      projectedYieldPct: Math.round(projectedYield * 10000) / 10000,
      projectedExposurePct: baseline.exposurePct,
      projectedFeeRatePct: baseline.feeRatePct,
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

  const baselineRisk = input.baseline.riskScore ?? 50;
  const projectedRisk =
    baselineRisk +
    Math.max(0, delta.projectedExposurePct - input.baseline.exposurePct) * 0.6 +
    (input.proposalType === "strategy_param" ? 8 : 0) +
    (input.proposalType === "reward_change" ? 4 : 0);

  const riskLevel =
    warnings.length > 0 || projectedRisk >= 75
      ? "high"
      : projectedRisk >= 55
        ? "medium"
        : "low";

  const affectedVaultCount = Math.max(1, input.baseline.vaultCount ?? 3);
  const affectedVaults = Array.from(
    { length: Math.min(affectedVaultCount, 4) },
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
          projectedYieldPct: input.baseline.yieldPct,
          projectedExposurePct: input.baseline.exposurePct,
          projectedFeeRatePct: input.baseline.feeRatePct,
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
