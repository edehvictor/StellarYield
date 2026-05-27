/**
 * Pure projection math for the Interactive Yield Curve Explorer.
 *
 * Formulas:
 *   blendedApy   = Σ (weight_i / 100) * apy_i
 *   netApy       = max(0, blendedApy - feeDrag)
 *   scenarioApy  = max(0, netApy * scenario.apy - scenario.extraFeeDragPct)
 *
 *   Per-period growth is determined by `compounding`:
 *     - daily       → r/365 over 365 periods/yr
 *     - weekly      → r/52  over 52  periods/yr
 *     - monthly     → r/12  over 12  periods/yr
 *     - continuous  → e^(r * t_years)
 *
 *   For non-continuous compounding the per-day factor is computed by
 *   converting the periodic APY into an equivalent daily growth factor
 *   so that the daily series is smooth and consistent regardless of
 *   the compounding cadence.
 *
 * Returns are illustrative. The explorer UI must clearly label outputs
 * as "scenario projections" and not as guaranteed returns.
 */

import type {
  AllocationLeg,
  CompoundFrequency,
  Horizon,
  ProjectionAssumptions,
  ProjectionPoint,
  ScenarioConfig,
  ScenarioName,
  ScenarioProjection,
  YieldCurveResult,
} from "./types";

export const HORIZON_DAYS: Record<Horizon, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
};

export const DEFAULT_SCENARIOS: ScenarioConfig = {
  best: { apy: 1.2, extraFeeDragPct: 0 },
  base: { apy: 1.0, extraFeeDragPct: 0 },
  stress: { apy: 0.6, extraFeeDragPct: 1.0 },
};

const PERIODS_PER_YEAR: Record<Exclude<CompoundFrequency, "continuous">, number> = {
  daily: 365,
  weekly: 52,
  monthly: 12,
};

/**
 * Sum of weighted APY contributions. Invalid legs (non-finite or negative)
 * are clamped to 0 to keep downstream math stable.
 */
export function calculateBlendedApy(allocations: AllocationLeg[]): number {
  if (!allocations.length) return 0;
  return allocations.reduce((sum, leg) => {
    const weight = Number.isFinite(leg.weightPct) ? Math.max(0, leg.weightPct) : 0;
    const apy = Number.isFinite(leg.apyPct) ? Math.max(0, leg.apyPct) : 0;
    return sum + (weight / 100) * apy;
  }, 0);
}

/**
 * Sum of allocation weights. Used to validate that legs sum to ~100%.
 */
export function totalWeight(allocations: AllocationLeg[]): number {
  return allocations.reduce(
    (sum, leg) => sum + (Number.isFinite(leg.weightPct) ? leg.weightPct : 0),
    0,
  );
}

/**
 * Returns true if allocation weights sum to 100% within `tolerancePct`.
 * Default tolerance accommodates floating-point drift from slider UIs.
 */
export function isValidAllocation(
  allocations: AllocationLeg[],
  tolerancePct = 0.01,
): boolean {
  if (!allocations.length) return false;
  return Math.abs(totalWeight(allocations) - 100) <= tolerancePct;
}

/**
 * Converts an annual rate `r` (decimal) under `compounding` into a daily
 * growth factor `g` such that `g^365 = (1+r/n)^n` (or e^r for continuous).
 *
 * Using a daily series regardless of compounding gives the chart a
 * uniform x-axis without distorting end-of-period values.
 */
export function dailyGrowthFactor(
  annualRatePct: number,
  compounding: CompoundFrequency,
): number {
  const r = Math.max(0, annualRatePct) / 100;

  if (compounding === "continuous") {
    return Math.exp(r / 365);
  }

  const n = PERIODS_PER_YEAR[compounding];
  // Effective annual return under periodic compounding.
  const effectiveAnnual = Math.pow(1 + r / n, n) - 1;
  return Math.pow(1 + effectiveAnnual, 1 / 365);
}

/**
 * Apply scenario multipliers to a net APY. Floors at 0 — a scenario
 * cannot turn yield negative on its own; capital loss must be modelled
 * separately (out of scope for this projection).
 */
export function applyScenario(netApyPct: number, name: ScenarioName, config = DEFAULT_SCENARIOS): number {
  const scen = config[name];
  return Math.max(0, netApyPct * scen.apy - scen.extraFeeDragPct);
}

/**
 * Build a daily projection series of length horizonDays + 1 (inclusive of t=0).
 */
export function buildSeries(
  principalUsd: number,
  scenarioApyPct: number,
  compounding: CompoundFrequency,
  horizonDays: number,
): ProjectionPoint[] {
  const safePrincipal = Math.max(0, principalUsd);
  const factor = dailyGrowthFactor(scenarioApyPct, compounding);
  const points: ProjectionPoint[] = [];
  for (let day = 0; day <= horizonDays; day += 1) {
    points.push({
      day,
      valueUsd: safePrincipal * Math.pow(factor, day),
    });
  }
  return points;
}

/**
 * Validation errors for assumptions. Returns an array of human-readable
 * messages; empty array means the inputs are valid.
 */
export function validateAssumptions(a: ProjectionAssumptions): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(a.principalUsd) || a.principalUsd < 0) {
    errors.push("Principal must be a non-negative number.");
  }
  if (a.principalUsd > 1_000_000_000) {
    errors.push("Principal exceeds the maximum supported value.");
  }
  if (!Number.isFinite(a.feeDragPct) || a.feeDragPct < 0) {
    errors.push("Fee drag must be a non-negative number.");
  }
  if (a.feeDragPct > 100) {
    errors.push("Fee drag cannot exceed 100%.");
  }
  if (!a.allocations.length) {
    errors.push("At least one allocation leg is required.");
  }
  if (a.allocations.some((leg) => !Number.isFinite(leg.apyPct) || leg.apyPct < 0)) {
    errors.push("Each allocation must have a non-negative APY.");
  }
  if (!isValidAllocation(a.allocations)) {
    errors.push("Allocation weights must sum to 100%.");
  }
  return errors;
}

/**
 * Run the full projection across all three scenarios for a given horizon.
 */
export function projectYieldCurve(
  horizon: Horizon,
  assumptions: ProjectionAssumptions,
  scenarios: ScenarioConfig = DEFAULT_SCENARIOS,
): YieldCurveResult {
  const errors = validateAssumptions(assumptions);
  if (errors.length) {
    throw new Error(`Invalid projection assumptions: ${errors.join(" ")}`);
  }

  const horizonDays = HORIZON_DAYS[horizon];
  const blendedApyPct = calculateBlendedApy(assumptions.allocations);
  const netApyPct = Math.max(0, blendedApyPct - assumptions.feeDragPct);

  const scenarioNames: ScenarioName[] = ["best", "base", "stress"];
  const result: Partial<Record<ScenarioName, ScenarioProjection>> = {};

  for (const name of scenarioNames) {
    const effectiveApy = applyScenario(netApyPct, name, scenarios);
    const points = buildSeries(
      assumptions.principalUsd,
      effectiveApy,
      assumptions.compounding,
      horizonDays,
    );
    const finalValue = points[points.length - 1].valueUsd;
    const totalReturnPct =
      assumptions.principalUsd > 0
        ? ((finalValue - assumptions.principalUsd) / assumptions.principalUsd) * 100
        : 0;

    result[name] = {
      scenario: name,
      effectiveApyPct: effectiveApy,
      finalValueUsd: finalValue,
      totalReturnPct,
      points,
    };
  }

  return {
    horizon,
    horizonDays,
    blendedApyPct,
    netApyPct,
    scenarios: result as Record<ScenarioName, ScenarioProjection>,
  };
}
