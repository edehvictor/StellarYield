export interface CapitalEfficiencyInput {
  utilizationPct?: number;
  feeDragPct?: number;
  rotationCostPct?: number;
  liquidityDepthUsd?: number;
}

export interface CapitalEfficiencyResult {
  score: number;
  grade: "A" | "B" | "C" | "D";
  components: {
    utilization: number;
    feeDrag: number;
    rotationCost: number;
    liquidityDepth: number;
  };
  hasMissingInputs: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeLiquidityDepth(liquidityDepthUsd: number): number {
  if (liquidityDepthUsd <= 0) return 0;
  const normalized = Math.log10(liquidityDepthUsd + 1) / 7;
  return clamp(normalized * 100, 0, 100);
}

export function calculateCapitalEfficiency(
  input: CapitalEfficiencyInput,
): CapitalEfficiencyResult {
  const utilization = clamp(input.utilizationPct ?? 0, 0, 100);
  const feeDrag = clamp(100 - (input.feeDragPct ?? 0) * 12, 0, 100);
  const rotationCost = clamp(100 - (input.rotationCostPct ?? 0) * 10, 0, 100);
  const liquidityDepth = normalizeLiquidityDepth(input.liquidityDepthUsd ?? 0);

  const score =
    utilization * 0.35 +
    feeDrag * 0.25 +
    rotationCost * 0.2 +
    liquidityDepth * 0.2;

  const roundedScore = round(score);
  const grade: CapitalEfficiencyResult["grade"] =
    roundedScore >= 85 ? "A" : roundedScore >= 70 ? "B" : roundedScore >= 55 ? "C" : "D";

  return {
    score: roundedScore,
    grade,
    components: {
      utilization: round(utilization),
      feeDrag: round(feeDrag),
      rotationCost: round(rotationCost),
      liquidityDepth: round(liquidityDepth),
    },
    hasMissingInputs:
      input.utilizationPct == null ||
      input.feeDragPct == null ||
      input.rotationCostPct == null ||
      input.liquidityDepthUsd == null,
  };
}
