import { PROTOCOLS } from "../config/protocols";
import { calculateRiskScore } from "../utils/riskScoring";
import {
  rankStrategies,
  type StrategyInput,
  type RankedStrategy,
} from "./riskAdjustedYieldService";
import type { DrawdownToleranceProfile } from "./drawdownService";

export type UserRiskProfile = "conservative" | "balanced" | "aggressive";
export type TimeHorizon = "short" | "medium" | "long";
export type LiquidityNeed = "high" | "medium" | "low";

export interface DepositWizardInput {
  riskTolerance: UserRiskProfile;
  timeHorizon: TimeHorizon;
  liquidityNeeds: LiquidityNeed;
}

export interface VaultRecommendation extends RankedStrategy {
  explanation: string;
  matchScore: number;
}

export interface DepositRecommendationResult {
  profile: UserRiskProfile;
  drawdownProfile: DrawdownToleranceProfile;
  input: DepositWizardInput;
  recommendations: VaultRecommendation[];
  summary: string;
}

const PROFILE_TO_DRAWDOWN: Record<UserRiskProfile, DrawdownToleranceProfile> = {
  conservative: "conservative",
  balanced: "balanced",
  aggressive: "tolerant",
};

function buildStrategies(): StrategyInput[] {
  const now = new Date().toISOString();
  return PROTOCOLS.map((p) => {
    const riskResult = calculateRiskScore({
      tvlUsd: p.baseTvlUsd,
      ilVolatilityPct: p.volatilityPct,
      protocolAgeDays: p.protocolAgeDays,
    });
    return {
      id: p.protocolName.toLowerCase(),
      name: p.protocolName,
      strategyType: p.protocolType,
      apy: p.baseApyBps / 100,
      tvlUsd: p.baseTvlUsd,
      ilVolatilityPct: p.volatilityPct,
      riskScore: riskResult.score,
      fetchedAt: now,
    };
  });
}

function liquidityBonus(need: LiquidityNeed, tvlUsd: number): number {
  const tvlM = tvlUsd / 1_000_000;
  if (need === "high") return Math.min(15, tvlM * 2);
  if (need === "medium") return Math.min(8, tvlM);
  return Math.min(3, tvlM * 0.5);
}

function horizonBonus(horizon: TimeHorizon, riskScore: number): number {
  if (horizon === "short") return riskScore * 0.8;
  if (horizon === "medium") return riskScore * 0.5;
  return riskScore * 0.2;
}

function buildExplanation(
  strategy: RankedStrategy,
  input: DepositWizardInput,
  drawdownProfile: DrawdownToleranceProfile,
): string {
  const parts: string[] = [];

  parts.push(
    `Ranked #${strategy.rank} with risk-adjusted yield of ${strategy.riskAdjustedYield.toFixed(2)}%`,
  );

  if (input.riskTolerance === "conservative") {
    parts.push(
      `Risk score ${strategy.riskScore}/10 and estimated drawdown ${strategy.estimatedDrawdown.toFixed(1)}% align with your conservative tolerance`,
    );
  } else if (input.riskTolerance === "aggressive") {
    parts.push(
      `Higher APY (${strategy.apy.toFixed(2)}%) suits your aggressive profile under the ${drawdownProfile} drawdown model`,
    );
  } else {
    parts.push(
      `Balances ${strategy.apy.toFixed(2)}% APY with moderate volatility (${strategy.ilVolatilityPct.toFixed(1)}%)`,
    );
  }

  if (input.liquidityNeeds === "high" && strategy.tvlUsd >= 5_000_000) {
    parts.push(`Deep liquidity ($${(strategy.tvlUsd / 1_000_000).toFixed(1)}M TVL) supports your liquidity needs`);
  }

  if (input.timeHorizon === "long") {
    parts.push("Suitable for longer holding periods with stable yield characteristics");
  } else if (input.timeHorizon === "short") {
    parts.push("Prioritized for lower volatility given your short time horizon");
  }

  return parts.join(". ") + ".";
}

export function mapRiskProfileToDrawdown(profile: UserRiskProfile): DrawdownToleranceProfile {
  return PROFILE_TO_DRAWDOWN[profile];
}

export function generateDepositRecommendations(
  input: DepositWizardInput,
  limit = 3,
): DepositRecommendationResult {
  const drawdownProfile = mapRiskProfileToDrawdown(input.riskTolerance);
  const ranked = rankStrategies(buildStrategies(), drawdownProfile);

  const recommendations: VaultRecommendation[] = ranked.slice(0, limit).map((strategy) => {
    const matchScore =
      strategy.riskAdjustedYield +
      liquidityBonus(input.liquidityNeeds, strategy.tvlUsd) +
      horizonBonus(input.timeHorizon, strategy.riskScore);

    return {
      ...strategy,
      matchScore: Math.round(matchScore * 100) / 100,
      explanation: buildExplanation(strategy, input, drawdownProfile),
    };
  });

  const top = recommendations[0];
  const summary = top
    ? `For a ${input.riskTolerance} investor with ${input.timeHorizon}-term goals and ${input.liquidityNeeds} liquidity needs, we recommend ${top.name} first.`
    : "No vault recommendations available for the current market snapshot.";

  return {
    profile: input.riskTolerance,
    drawdownProfile,
    input,
    recommendations,
    summary,
  };
}
