export type LiquidityStressLevel = "low" | "medium" | "stressed";
export type LiquidityBand = "thin" | "normal" | "deep";
export type RouteRiskLevel = "low" | "medium" | "high";

export interface LiquidityBufferInput {
  strategyId: string;
  portfolioId?: string;
  strategyVolatilityPct: number;
  withdrawalVelocityPctPerDay: number;
  protocolHealthScore: number;
  liquidityDepthUsd: number;
  strategyTvlUsd: number;
  ambiguousStressSignal?: boolean;
  /** Route risk level ("low" | "medium" | "high") or numeric ratio (0-1) / score (0-100). */
  routeRisk?: RouteRiskLevel | number;
  /** Explicit route risk score (0-100). */
  routeRiskScore?: number;
  /** Explicit liquidity band if known ("thin" | "normal" | "deep"). */
  liquidityBand?: LiquidityBand;
  /** Hop count for the execution path. */
  hopCount?: number;
  /** Planned execution amount in USD for route sizing checks. */
  executionAmountUsd?: number;
}

export interface LiquidityBufferRecommendation {
  strategyId: string;
  portfolioId?: string;
  stressLevel: LiquidityStressLevel;
  liquidityBand: LiquidityBand;
  routeRiskLevel: RouteRiskLevel;
  routeRiskScore: number;
  recommendedBufferPct: number;
  recommendedBufferUsd: number;
  minBufferPct: number;
  safeExecutionSizeUsd: number;
  maxRecommendedExecutionAmountUsd?: number;
  rationale: string[];
  computedAt: string;
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function classifyLiquidityBand(
  liquidityDepthUsd: number,
  strategyTvlUsd: number = 0,
  explicitBand?: LiquidityBand
): LiquidityBand {
  if (explicitBand) return explicitBand;
  if (liquidityDepthUsd <= 0) return "thin";

  const ratio =
    strategyTvlUsd > 0
      ? liquidityDepthUsd / strategyTvlUsd
      : liquidityDepthUsd / 1_000_000;

  if (ratio < 0.5 || liquidityDepthUsd < 250_000) {
    return "thin";
  }
  if (ratio >= 2.0 || liquidityDepthUsd >= 2_000_000) {
    return "deep";
  }
  return "normal";
}

export function classifyRouteRisk(
  routeRisk?: RouteRiskLevel | number,
  routeRiskScore?: number,
  hopCount?: number
): { level: RouteRiskLevel; score: number } {
  if (typeof routeRiskScore === "number") {
    const score = clamp(routeRiskScore, 0, 100);
    const level: RouteRiskLevel =
      score >= 70 ? "high" : score >= 35 ? "medium" : "low";
    return { level, score };
  }
  if (typeof routeRisk === "number") {
    const score = clamp(
      routeRisk <= 1.0 ? routeRisk * 100 : routeRisk,
      0,
      100
    );
    const level: RouteRiskLevel =
      score >= 70 ? "high" : score >= 35 ? "medium" : "low";
    return { level, score };
  }
  if (typeof routeRisk === "string") {
    const score =
      routeRisk === "high" ? 80 : routeRisk === "medium" ? 50 : 15;
    return { level: routeRisk, score };
  }
  if (typeof hopCount === "number") {
    if (hopCount >= 3) return { level: "high", score: 75 };
    if (hopCount === 2) return { level: "medium", score: 45 };
    return { level: "low", score: 15 };
  }
  return { level: "low", score: 10 };
}

export function classifyStress(
  input: LiquidityBufferInput,
  routeRisk?: { level: RouteRiskLevel; score: number }
): LiquidityStressLevel {
  const isHighRouteRisk =
    routeRisk?.level === "high" || (routeRisk?.score ?? 0) >= 70;
  const isMedRouteRisk =
    routeRisk?.level === "medium" || (routeRisk?.score ?? 0) >= 40;

  if (
    input.withdrawalVelocityPctPerDay >= 12 ||
    input.protocolHealthScore < 50 ||
    input.liquidityDepthUsd < input.strategyTvlUsd * 0.4 ||
    isHighRouteRisk
  ) {
    return "stressed";
  }

  if (
    input.withdrawalVelocityPctPerDay >= 6 ||
    input.protocolHealthScore < 75 ||
    input.liquidityDepthUsd < input.strategyTvlUsd ||
    isMedRouteRisk
  ) {
    return "medium";
  }

  return "low";
}

export function recommendLiquidityBuffer(
  input: LiquidityBufferInput
): LiquidityBufferRecommendation {
  const routeRisk = classifyRouteRisk(
    input.routeRisk,
    input.routeRiskScore,
    input.hopCount
  );
  const liquidityBand = classifyLiquidityBand(
    input.liquidityDepthUsd,
    input.strategyTvlUsd,
    input.liquidityBand
  );
  const stressLevel = classifyStress(input, routeRisk);

  const baseByStress: Record<LiquidityStressLevel, number> = {
    low: 0.08,
    medium: 0.14,
    stressed: 0.22,
  };

  const volatilityAdd = clamp(input.strategyVolatilityPct / 100, 0, 0.15);
  const withdrawalAdd = clamp(
    input.withdrawalVelocityPctPerDay / 100,
    0,
    0.15
  );
  const healthPenalty = clamp(
    (100 - input.protocolHealthScore) / 250,
    0,
    0.2
  );

  let depthPenalty = 0;
  if (input.liquidityDepthUsd <= 0) {
    depthPenalty = 0.2;
  } else {
    const rawDepthPenalty = clamp(
      (input.strategyTvlUsd / input.liquidityDepthUsd - 1) / 5,
      0,
      0.15
    );
    const bandAdjustment =
      liquidityBand === "thin" ? 0.04 : liquidityBand === "deep" ? -0.02 : 0;
    depthPenalty = Math.max(0, rawDepthPenalty + bandAdjustment);
  }

  const routeRiskAdd = clamp((routeRisk.score / 100) * 0.12, 0, 0.15);
  const ambiguityGuard = input.ambiguousStressSignal ? 0.03 : 0;

  const minByStress: Record<LiquidityStressLevel, number> = {
    low: 0.08,
    medium: 0.14,
    stressed: 0.22,
  };

  const rawBuffer =
    baseByStress[stressLevel] +
    volatilityAdd +
    withdrawalAdd +
    healthPenalty +
    depthPenalty +
    routeRiskAdd +
    ambiguityGuard;

  const recommendedBufferPct = clamp(
    rawBuffer,
    minByStress[stressLevel],
    0.7
  );

  // Sizing guidance to maintain low-slippage execution
  const bandSafeRatio =
    liquidityBand === "thin" ? 0.03 : liquidityBand === "deep" ? 0.15 : 0.08;
  const routeRiskDiscount = clamp(
    1 - (routeRisk.score / 100) * 0.5,
    0.2,
    1.0
  );
  const safeExecutionSizeUsd =
    Math.round(
      Math.max(
        0,
        input.liquidityDepthUsd * bandSafeRatio * routeRiskDiscount
      ) * 100
    ) / 100;

  const maxRecommendedExecutionAmountUsd =
    input.executionAmountUsd !== undefined
      ? Math.min(input.executionAmountUsd, safeExecutionSizeUsd)
      : safeExecutionSizeUsd;

  const rationale = [
    `Stress level classified as ${stressLevel} (${liquidityBand} liquidity band) from withdrawal velocity, health, liquidity depth, and route risk.`,
    `Volatility adjustment added ${(volatilityAdd * 100).toFixed(1)}%.`,
    `Withdrawal adjustment added ${(withdrawalAdd * 100).toFixed(1)}%.`,
    `Protocol health and depth adjustments added ${(
      (healthPenalty + depthPenalty + ambiguityGuard) *
      100
    ).toFixed(1)}%.`,
    `Route risk (${routeRisk.level}, score: ${routeRisk.score}) added ${(
      routeRiskAdd * 100
    ).toFixed(1)}% buffer guidance for low-slippage execution.`,
  ];

  return {
    strategyId: input.strategyId,
    portfolioId: input.portfolioId,
    stressLevel,
    liquidityBand,
    routeRiskLevel: routeRisk.level,
    routeRiskScore: routeRisk.score,
    recommendedBufferPct,
    recommendedBufferUsd: input.strategyTvlUsd * recommendedBufferPct,
    minBufferPct: minByStress[stressLevel],
    safeExecutionSizeUsd,
    maxRecommendedExecutionAmountUsd,
    rationale,
    computedAt: new Date().toISOString(),
  };
}

export function recommendLiquidityBuffers(
  inputs: LiquidityBufferInput[]
): LiquidityBufferRecommendation[] {
  return inputs.map(recommendLiquidityBuffer);
}

