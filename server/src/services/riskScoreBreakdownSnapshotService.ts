import {
  calculateRiskScore,
  type RiskInput,
  type RiskResult,
} from "../utils/riskScoring";

export type PortfolioRiskRegime = "calm" | "balanced" | "stressed" | "extreme";

export interface RiskScoreBreakdownSnapshot {
  regime: PortfolioRiskRegime;
  portfolioRiskScore: number;
  label: RiskResult["label"];
  breakdown: RiskResult["breakdown"];
  weights: {
    tvl: 0.4;
    volatility: 0.35;
    age: 0.25;
  };
  inputs: RiskInput;
  /** Fixed reference timestamp so fixture snapshots stay deterministic. */
  computedAt: string;
}

export const RISK_SCORE_WEIGHTS = {
  tvl: 0.4,
  volatility: 0.35,
  age: 0.25,
} as const;

/** Canonical portfolio inputs for each reference regime. */
export const REGIME_RISK_INPUTS: Record<PortfolioRiskRegime, RiskInput> = {
  calm: {
    tvlUsd: 12_000_000,
    ilVolatilityPct: 2,
    protocolAgeDays: 400,
  },
  balanced: {
    tvlUsd: 50_000,
    ilVolatilityPct: 6,
    protocolAgeDays: 60,
  },
  stressed: {
    tvlUsd: 10_000,
    ilVolatilityPct: 9,
    protocolAgeDays: 25,
  },
  extreme: {
    tvlUsd: 1_000,
    ilVolatilityPct: 12,
    protocolAgeDays: 5,
  },
};

const REGIME_COMPUTED_AT: Record<PortfolioRiskRegime, string> = {
  calm: "2026-01-01T00:00:00.000Z",
  balanced: "2026-01-01T00:00:00.000Z",
  stressed: "2026-01-01T00:00:00.000Z",
  extreme: "2026-01-01T00:00:00.000Z",
};

export function buildRiskScoreBreakdownSnapshot(
  regime: PortfolioRiskRegime,
  inputs: RiskInput = REGIME_RISK_INPUTS[regime],
): RiskScoreBreakdownSnapshot {
  const result = calculateRiskScore(inputs);

  return {
    regime,
    portfolioRiskScore: result.score,
    label: result.label,
    breakdown: result.breakdown,
    weights: RISK_SCORE_WEIGHTS,
    inputs,
    computedAt: REGIME_COMPUTED_AT[regime],
  };
}

export function buildRegimeBreakdownSnapshots(): RiskScoreBreakdownSnapshot[] {
  return (Object.keys(REGIME_RISK_INPUTS) as PortfolioRiskRegime[]).map((regime) =>
    buildRiskScoreBreakdownSnapshot(regime),
  );
}

/** Identify which sub-score contributed most to the final risk score. */
export function dominantRiskComponent(
  snapshot: Pick<RiskScoreBreakdownSnapshot, "breakdown" | "weights">,
): keyof RiskScoreBreakdownSnapshot["breakdown"] {
  const weighted = [
    { key: "tvl" as const, value: snapshot.breakdown.tvl * snapshot.weights.tvl },
    { key: "volatility" as const, value: snapshot.breakdown.volatility * snapshot.weights.volatility },
    { key: "age" as const, value: snapshot.breakdown.age * snapshot.weights.age },
  ];
  return weighted.sort((a, b) => b.value - a.value)[0].key;
}
