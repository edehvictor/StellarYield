/**
 * Governance Proposal Impact Forecast Service
 *
 * Estimates the impact of governance parameter changes on yield, exposure,
 * and fee behavior. Forecasts are modeled outcomes, not guaranteed results.
 */

export type ProposalType = "fee_change" | "allocation_limit" | "strategy_param";

export interface GovernanceForecastInput {
  proposalType: ProposalType;
  parameters: Record<string, number>;
  baseline: {
    yieldPct: number;
    exposurePct: number;
    feeRatePct: number;
    tvlUsd: number;
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
    warnings: result.warnings,
    disclaimer: DISCLAIMER,
  };
}
