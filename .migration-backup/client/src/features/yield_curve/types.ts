/**
 * Types for the Interactive Yield Curve Explorer.
 *
 * Projections are illustrative. They use historical APY assumptions and
 * configurable scenario multipliers and DO NOT represent guaranteed returns.
 * The UI surfaces this distinction explicitly.
 */

export type Horizon = "7d" | "30d" | "90d" | "365d";

export type CompoundFrequency = "daily" | "weekly" | "monthly" | "continuous";

export type ScenarioName = "best" | "base" | "stress";

export interface AllocationLeg {
  /** Stable identifier (e.g. protocol name lowercased). */
  id: string;
  /** Display label. */
  label: string;
  /** Base APY in percent (e.g. 8.5 for 8.5%). */
  apyPct: number;
  /** Allocation weight in percent (0-100). All legs must sum to 100. */
  weightPct: number;
}

export interface ProjectionAssumptions {
  /** Initial principal in USD. */
  principalUsd: number;
  /** Compounding frequency. */
  compounding: CompoundFrequency;
  /** Annual fee drag in percent (subtracted from APY). */
  feeDragPct: number;
  /** Allocation across legs; weights must sum to ~100%. */
  allocations: AllocationLeg[];
}

export interface ScenarioMultipliers {
  /** Multiplier applied to net APY (e.g. 1.2 = 20% upside). */
  apy: number;
  /** Additional fee drag in percent points (e.g. 0.5 = +0.5pp drag). */
  extraFeeDragPct: number;
}

export type ScenarioConfig = Record<ScenarioName, ScenarioMultipliers>;

export interface ProjectionPoint {
  /** Days since t=0. */
  day: number;
  /** Projected portfolio value in USD. */
  valueUsd: number;
}

export interface ScenarioProjection {
  scenario: ScenarioName;
  /** Effective annual APY in percent after fees and scenario adjustment. */
  effectiveApyPct: number;
  /** End-of-horizon value in USD. */
  finalValueUsd: number;
  /** Total return in percent over the horizon. */
  totalReturnPct: number;
  /** Daily projection series. */
  points: ProjectionPoint[];
}

export interface YieldCurveResult {
  horizon: Horizon;
  horizonDays: number;
  /** Blended base APY in percent (weighted, before fees). */
  blendedApyPct: number;
  /** Blended APY net of fee drag, before scenario multipliers. */
  netApyPct: number;
  scenarios: Record<ScenarioName, ScenarioProjection>;
}
