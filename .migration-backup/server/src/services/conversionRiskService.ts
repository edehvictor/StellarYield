import { getZapQuote, ZapQuoteBody } from "./zapQuote";
import { createGuardrailsService } from "./guardrailsService";

export interface ConversionRiskAssessment {
  sourceAsset: string;
  targetAsset: string;
  bestPath: string[];
  alternativePaths: string[][];
  expectedOutput: string;
  slippagePercent: number;
  liquidityScore: number;
  timingRiskScore: number;
  aggregateRiskScore: number;
  riskLevel: "low" | "medium" | "high" | "blocked";
  blocked: boolean;
  warnings: string[];
}

function calculateLiquidityScore(amountIn: bigint, tvl: bigint): number {
  if (tvl === BigInt(0)) return 100;
  return Math.min(Number((amountIn * BigInt(100)) / tvl), 100);
}

function calculateTimingRisk(pathLength: number): number {
  if (pathLength <= 1) return 10;
  if (pathLength === 2) return 25;
  if (pathLength === 3) return 50;
  return 80;
}

function calculateAggregateRisk(
  slippage: number,
  liquidity: number,
  timing: number
): number {
  return slippage * 40 + liquidity * 0.3 + timing * 0.3;
}

function determineRiskLevel(score: number): "low" | "medium" | "high" | "blocked" {
  if (score > 80) return "blocked";
  if (score > 60) return "high";
  if (score > 30) return "medium";
  return "low";
}

export async function assessConversionRisk(
  body: ZapQuoteBody,
  strategyId: string
): Promise<ConversionRiskAssessment> {
  const quote = await getZapQuote(body);

  const amountIn = BigInt(body.amountInStroops);
  const expectedOut = BigInt(quote.amountOutAfterSlippage);

  const liquidityScore = calculateLiquidityScore(
    amountIn,
    expectedOut > BigInt(0) ? expectedOut * BigInt(10) : BigInt(1)
  );

  const timingRisk = calculateTimingRisk(quote.path.length);

  const aggregateRisk = calculateAggregateRisk(
    quote.slippageApplied * 100,
    liquidityScore,
    timingRisk
  );

  const riskLevel = determineRiskLevel(aggregateRisk);

  const guardrails = createGuardrailsService();
  const guardrailResult = guardrails.evaluateGuardrails({
    strategyId,
    slippage: quote.slippageApplied * 100,
    liquidity: Number(expectedOut),
  });

  return {
    sourceAsset: body.inputTokenContract,
    targetAsset: body.vaultTokenContract,
    bestPath: quote.path.map(p => p.contractId),
    alternativePaths: [],
    expectedOutput: quote.amountOutAfterSlippage,
    slippagePercent: quote.slippageApplied * 100,
    liquidityScore,
    timingRiskScore: timingRisk,
    aggregateRiskScore: aggregateRisk,
    riskLevel: guardrailResult.passed ? riskLevel : "blocked",
    blocked: !guardrailResult.passed,
    warnings: guardrailResult.warnings,
  };
}