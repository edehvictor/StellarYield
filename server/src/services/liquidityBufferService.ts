export type LiquidityStressLevel = "low" | "medium" | "stressed";

export interface LiquidityBufferInput {
  strategyId: string;
  portfolioId?: string;
  strategyVolatilityPct: number;
  withdrawalVelocityPctPerDay: number;
  protocolHealthScore: number;
  liquidityDepthUsd: number;
  strategyTvlUsd: number;
  ambiguousStressSignal?: boolean;
}

export interface LiquidityBufferRecommendation {
  strategyId: string;
  portfolioId?: string;
  stressLevel: LiquidityStressLevel;
  recommendedBufferPct: number;
  recommendedBufferUsd: number;
  minBufferPct: number;
  rationale: string[];
  computedAt: string;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function classifyStress(input: LiquidityBufferInput): LiquidityStressLevel {
  if (
    input.withdrawalVelocityPctPerDay >= 12 ||
    input.protocolHealthScore < 50 ||
    input.liquidityDepthUsd < input.strategyTvlUsd * 0.4
  ) {
    return "stressed";
  }

  if (
    input.withdrawalVelocityPctPerDay >= 6 ||
    input.protocolHealthScore < 75 ||
    input.liquidityDepthUsd < input.strategyTvlUsd
  ) {
    return "medium";
  }

  return "low";
}

export function recommendLiquidityBuffer(input: LiquidityBufferInput): LiquidityBufferRecommendation {
  const stressLevel = classifyStress(input);
  const baseByStress: Record<LiquidityStressLevel, number> = {
    low: 0.08,
    medium: 0.14,
    stressed: 0.22,
  };

  const volatilityAdd = clamp(input.strategyVolatilityPct / 100, 0, 0.15);
  const withdrawalAdd = clamp(input.withdrawalVelocityPctPerDay / 100, 0, 0.15);
  const healthPenalty = clamp((100 - input.protocolHealthScore) / 250, 0, 0.2);
  const depthPenalty = input.liquidityDepthUsd <= 0
    ? 0.2
    : clamp((input.strategyTvlUsd / input.liquidityDepthUsd - 1) / 5, 0, 0.15);
  const ambiguityGuard = input.ambiguousStressSignal ? 0.03 : 0;

  const minByStress: Record<LiquidityStressLevel, number> = {
    low: 0.08,
    medium: 0.14,
    stressed: 0.22,
  };

  const rawBuffer = baseByStress[stressLevel] + volatilityAdd + withdrawalAdd + healthPenalty + depthPenalty + ambiguityGuard;
  const recommendedBufferPct = clamp(rawBuffer, minByStress[stressLevel], 0.65);

  const rationale = [
    `Stress level classified as ${stressLevel} from withdrawal velocity, health, and liquidity depth.`,
    `Volatility adjustment added ${(volatilityAdd * 100).toFixed(1)}%.`,
    `Withdrawal adjustment added ${(withdrawalAdd * 100).toFixed(1)}%.`,
    `Protocol health and depth adjustments added ${((healthPenalty + depthPenalty + ambiguityGuard) * 100).toFixed(1)}%.`,
  ];

  return {
    strategyId: input.strategyId,
    portfolioId: input.portfolioId,
    stressLevel,
    recommendedBufferPct,
    recommendedBufferUsd: input.strategyTvlUsd * recommendedBufferPct,
    minBufferPct: minByStress[stressLevel],
    rationale,
    computedAt: new Date().toISOString(),
  };
}

export function recommendLiquidityBuffers(inputs: LiquidityBufferInput[]): LiquidityBufferRecommendation[] {
  return inputs.map(recommendLiquidityBuffer);
}
