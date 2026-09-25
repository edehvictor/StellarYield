import { describe, expect, it } from "vitest";
import {
  applyScenario,
  buildSeries,
  calculateBlendedApy,
  dailyGrowthFactor,
  DEFAULT_SCENARIOS,
  HORIZON_DAYS,
  isValidAllocation,
  projectYieldCurve,
  totalWeight,
  validateAssumptions,
} from "../yieldProjection";
import type {
  AllocationLeg,
  Horizon,
  ProjectionAssumptions,
} from "../types";

const makeAlloc = (overrides: Partial<AllocationLeg> = {}): AllocationLeg => ({
  id: "blend",
  label: "Blend",
  apyPct: 8,
  weightPct: 100,
  ...overrides,
});

const makeAssumptions = (
  overrides: Partial<ProjectionAssumptions> = {},
): ProjectionAssumptions => ({
  principalUsd: 10_000,
  compounding: "daily",
  feeDragPct: 0,
  allocations: [makeAlloc()],
  ...overrides,
});

describe("calculateBlendedApy", () => {
  it("equals the leg APY when 100% allocated to one leg", () => {
    expect(calculateBlendedApy([makeAlloc({ apyPct: 8 })])).toBeCloseTo(8);
  });

  it("weights APYs by their share", () => {
    const blended = calculateBlendedApy([
      makeAlloc({ id: "a", apyPct: 10, weightPct: 50 }),
      makeAlloc({ id: "b", apyPct: 20, weightPct: 50 }),
    ]);
    expect(blended).toBeCloseTo(15);
  });

  it("clamps negative weights and APYs to zero", () => {
    const blended = calculateBlendedApy([
      makeAlloc({ id: "a", apyPct: -5, weightPct: 50 }),
      makeAlloc({ id: "b", apyPct: 20, weightPct: 50 }),
    ]);
    expect(blended).toBeCloseTo(10);
  });

  it("returns 0 for an empty allocation list", () => {
    expect(calculateBlendedApy([])).toBe(0);
  });

  it("ignores non-finite leg values", () => {
    const blended = calculateBlendedApy([
      makeAlloc({ id: "a", apyPct: Number.NaN, weightPct: 50 }),
      makeAlloc({ id: "b", apyPct: 10, weightPct: 50 }),
    ]);
    expect(blended).toBeCloseTo(5);
  });
});

describe("totalWeight & isValidAllocation", () => {
  it("sums weights", () => {
    expect(
      totalWeight([
        makeAlloc({ weightPct: 30 }),
        makeAlloc({ weightPct: 70 }),
      ]),
    ).toBe(100);
  });

  it("accepts allocations summing to exactly 100", () => {
    expect(
      isValidAllocation([
        makeAlloc({ id: "a", weightPct: 60 }),
        makeAlloc({ id: "b", weightPct: 40 }),
      ]),
    ).toBe(true);
  });

  it("rejects allocations outside the tolerance band", () => {
    expect(
      isValidAllocation([
        makeAlloc({ id: "a", weightPct: 60 }),
        makeAlloc({ id: "b", weightPct: 50 }),
      ]),
    ).toBe(false);
  });

  it("accepts tiny floating-point drift inside the default tolerance", () => {
    expect(
      isValidAllocation([
        makeAlloc({ id: "a", weightPct: 33.333 }),
        makeAlloc({ id: "b", weightPct: 33.333 }),
        makeAlloc({ id: "c", weightPct: 33.334 }),
      ]),
    ).toBe(true);
  });

  it("rejects an empty allocation list", () => {
    expect(isValidAllocation([])).toBe(false);
  });
});

describe("dailyGrowthFactor", () => {
  it("returns 1 for a 0% rate", () => {
    expect(dailyGrowthFactor(0, "daily")).toBeCloseTo(1, 12);
    expect(dailyGrowthFactor(0, "monthly")).toBeCloseTo(1, 12);
    expect(dailyGrowthFactor(0, "continuous")).toBeCloseTo(1, 12);
  });

  it("higher compounding cadence yields a slightly larger daily factor", () => {
    const daily = dailyGrowthFactor(10, "daily");
    const monthly = dailyGrowthFactor(10, "monthly");
    const continuous = dailyGrowthFactor(10, "continuous");
    expect(daily).toBeGreaterThan(monthly);
    expect(continuous).toBeGreaterThanOrEqual(daily);
  });

  it("clamps negative APYs to zero", () => {
    expect(dailyGrowthFactor(-5, "daily")).toBeCloseTo(1, 12);
  });

  it("compounded over a year approximates the effective annual rate", () => {
    const factor = dailyGrowthFactor(10, "monthly");
    const annual = Math.pow(factor, 365);
    const effective = Math.pow(1 + 0.1 / 12, 12);
    expect(annual).toBeCloseTo(effective, 6);
  });
});

describe("applyScenario", () => {
  it("base scenario passes net APY through unchanged", () => {
    expect(applyScenario(8, "base")).toBeCloseTo(8);
  });

  it("best scenario amplifies APY", () => {
    const best = applyScenario(8, "best");
    expect(best).toBeGreaterThan(8);
  });

  it("stress scenario reduces APY and adds fee drag", () => {
    const stress = applyScenario(8, "stress");
    expect(stress).toBeLessThan(8);
  });

  it("never returns a negative effective APY", () => {
    expect(applyScenario(0.1, "stress")).toBeGreaterThanOrEqual(0);
  });

  it("respects custom scenario configuration", () => {
    const custom = applyScenario(10, "best", {
      ...DEFAULT_SCENARIOS,
      best: { apy: 2, extraFeeDragPct: 0 },
    });
    expect(custom).toBeCloseTo(20);
  });
});

describe("buildSeries", () => {
  it("starts at the principal at day 0", () => {
    const series = buildSeries(10_000, 8, "daily", 30);
    expect(series[0].day).toBe(0);
    expect(series[0].valueUsd).toBe(10_000);
  });

  it("returns horizonDays + 1 points", () => {
    const series = buildSeries(10_000, 8, "daily", 30);
    expect(series).toHaveLength(31);
  });

  it("is monotonically non-decreasing for non-negative APY", () => {
    const series = buildSeries(10_000, 5, "daily", 90);
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i].valueUsd).toBeGreaterThanOrEqual(series[i - 1].valueUsd);
    }
  });

  it("flat-lines for a 0% APY", () => {
    const series = buildSeries(10_000, 0, "daily", 30);
    expect(series.every((p) => p.valueUsd === 10_000)).toBe(true);
  });

  it("treats negative principal as zero", () => {
    const series = buildSeries(-100, 8, "daily", 7);
    expect(series.every((p) => p.valueUsd === 0)).toBe(true);
  });
});

describe("validateAssumptions", () => {
  it("accepts valid assumptions", () => {
    expect(validateAssumptions(makeAssumptions())).toEqual([]);
  });

  it("rejects negative principal", () => {
    const errs = validateAssumptions(makeAssumptions({ principalUsd: -1 }));
    expect(errs.join(" ")).toMatch(/Principal/);
  });

  it("rejects fee drag above 100%", () => {
    const errs = validateAssumptions(makeAssumptions({ feeDragPct: 150 }));
    expect(errs.join(" ")).toMatch(/Fee drag/);
  });

  it("rejects allocations that do not sum to 100", () => {
    const errs = validateAssumptions(
      makeAssumptions({
        allocations: [
          makeAlloc({ id: "a", weightPct: 60 }),
          makeAlloc({ id: "b", weightPct: 30 }),
        ],
      }),
    );
    expect(errs.join(" ")).toMatch(/sum to 100/);
  });

  it("rejects empty allocation list", () => {
    const errs = validateAssumptions(makeAssumptions({ allocations: [] }));
    expect(errs.join(" ")).toMatch(/At least one allocation/);
  });

  it("rejects negative APY in any leg", () => {
    const errs = validateAssumptions(
      makeAssumptions({
        allocations: [makeAlloc({ apyPct: -5, weightPct: 100 })],
      }),
    );
    expect(errs.join(" ")).toMatch(/non-negative APY/);
  });
});

describe("projectYieldCurve", () => {
  const horizons: Horizon[] = ["7d", "30d", "90d", "365d"];

  it("returns the requested horizon length", () => {
    for (const horizon of horizons) {
      const result = projectYieldCurve(horizon, makeAssumptions());
      expect(result.horizon).toBe(horizon);
      expect(result.horizonDays).toBe(HORIZON_DAYS[horizon]);
      expect(result.scenarios.base.points).toHaveLength(HORIZON_DAYS[horizon] + 1);
    }
  });

  it("net APY = blended APY - fee drag (floored at 0)", () => {
    const result = projectYieldCurve(
      "30d",
      makeAssumptions({
        feeDragPct: 1.5,
        allocations: [makeAlloc({ apyPct: 10 })],
      }),
    );
    expect(result.blendedApyPct).toBeCloseTo(10);
    expect(result.netApyPct).toBeCloseTo(8.5);
  });

  it("best scenario final value > base > stress", () => {
    const result = projectYieldCurve("365d", makeAssumptions());
    expect(result.scenarios.best.finalValueUsd).toBeGreaterThan(
      result.scenarios.base.finalValueUsd,
    );
    expect(result.scenarios.base.finalValueUsd).toBeGreaterThan(
      result.scenarios.stress.finalValueUsd,
    );
  });

  it("365d base scenario approximates the effective annual rate", () => {
    const result = projectYieldCurve(
      "365d",
      makeAssumptions({
        principalUsd: 10_000,
        compounding: "daily",
        feeDragPct: 0,
        allocations: [makeAlloc({ apyPct: 10 })],
      }),
    );
    // For daily compounding, EAR = (1 + 0.10/365)^365 ≈ 10.5156%.
    expect(result.scenarios.base.totalReturnPct).toBeGreaterThan(10);
    expect(result.scenarios.base.totalReturnPct).toBeLessThan(11);
  });

  it("returns 0% return when principal is zero", () => {
    const result = projectYieldCurve(
      "30d",
      makeAssumptions({ principalUsd: 0 }),
    );
    expect(result.scenarios.base.finalValueUsd).toBe(0);
    expect(result.scenarios.base.totalReturnPct).toBe(0);
  });

  it("throws when assumptions are invalid", () => {
    expect(() =>
      projectYieldCurve(
        "30d",
        makeAssumptions({ allocations: [makeAlloc({ weightPct: 50 })] }),
      ),
    ).toThrow(/Invalid projection assumptions/);
  });

  it("blended APY is correctly weighted across multiple legs", () => {
    const result = projectYieldCurve(
      "30d",
      makeAssumptions({
        allocations: [
          makeAlloc({ id: "a", apyPct: 4, weightPct: 25 }),
          makeAlloc({ id: "b", apyPct: 8, weightPct: 25 }),
          makeAlloc({ id: "c", apyPct: 12, weightPct: 50 }),
        ],
      }),
    );
    expect(result.blendedApyPct).toBeCloseTo(9);
  });

  it("respects custom scenario configuration", () => {
    const result = projectYieldCurve("30d", makeAssumptions(), {
      best: { apy: 1.0, extraFeeDragPct: 0 },
      base: { apy: 1.0, extraFeeDragPct: 0 },
      stress: { apy: 1.0, extraFeeDragPct: 0 },
    });
    expect(result.scenarios.best.finalValueUsd).toBeCloseTo(
      result.scenarios.base.finalValueUsd,
    );
    expect(result.scenarios.stress.finalValueUsd).toBeCloseTo(
      result.scenarios.base.finalValueUsd,
    );
  });
});
