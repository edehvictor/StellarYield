export type StressScenarioType = "apy-collapse" | "liquidity-drain" | "oracle-shock";

export interface StressScenarioRequest {
  scenario: StressScenarioType;
  initialValueUsd: number;
  baseApyPct: number;
  days: number;
}

export interface StressScenarioResult {
  scenario: StressScenarioType;
  projectedFinalValueUsd: number;
  expectedLossUsd: number;
  expectedLossPct: number;
  recoveryDaysEstimate: number;
  exposureBreakdown: {
    yieldExposurePct: number;
    liquidityExposurePct: number;
    oracleExposurePct: number;
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function runStressScenario(input: StressScenarioRequest): StressScenarioResult {
  const initialValueUsd = clamp(input.initialValueUsd, 1, 10_000_000_000);
  const baseApyPct = clamp(input.baseApyPct, -95, 500);
  const days = clamp(input.days, 1, 365);
  const baseGrowthFactor = 1 + (baseApyPct / 100) * (days / 365);
  const baselineFinal = initialValueUsd * Math.max(0, baseGrowthFactor);

  let shockFactor = 1;
  let exposureBreakdown = {
    yieldExposurePct: 40,
    liquidityExposurePct: 35,
    oracleExposurePct: 25,
  };

  if (input.scenario === "apy-collapse") {
    shockFactor = 0.82;
    exposureBreakdown = { yieldExposurePct: 70, liquidityExposurePct: 20, oracleExposurePct: 10 };
  } else if (input.scenario === "liquidity-drain") {
    shockFactor = 0.76;
    exposureBreakdown = { yieldExposurePct: 25, liquidityExposurePct: 65, oracleExposurePct: 10 };
  } else if (input.scenario === "oracle-shock") {
    shockFactor = 0.72;
    exposureBreakdown = { yieldExposurePct: 20, liquidityExposurePct: 25, oracleExposurePct: 55 };
  }

  const projectedFinalValueUsd = baselineFinal * shockFactor;
  const expectedLossUsd = Math.max(0, baselineFinal - projectedFinalValueUsd);
  const expectedLossPct = baselineFinal > 0 ? (expectedLossUsd / baselineFinal) * 100 : 0;
  const dailyRecoveryRate = Math.max(0.0005, (Math.max(baseApyPct, 0) / 100) / 365);
  const recoveryDaysEstimate =
    expectedLossUsd === 0
      ? 0
      : Math.ceil(expectedLossUsd / Math.max(initialValueUsd * dailyRecoveryRate, 1));

  return {
    scenario: input.scenario,
    projectedFinalValueUsd: round(projectedFinalValueUsd),
    expectedLossUsd: round(expectedLossUsd),
    expectedLossPct: round(expectedLossPct),
    recoveryDaysEstimate,
    exposureBreakdown,
  };
}
