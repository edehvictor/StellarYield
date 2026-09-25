import { describe, expect, it } from "vitest";
import {
    calculateBlendedApy,
    applyScenario,
    buildSeries,
    dailyGrowthFactor,
    projectYieldCurve,
    validateAssumptions,
    DEFAULT_SCENARIOS,
} from "../yieldProjection";
import type { AllocationLeg, ProjectionAssumptions } from "../types";

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

describe("yieldProjection — extreme APY inputs", () => {
    it("calculateBlendedApy returns 0 for zero APY", () => {
        expect(calculateBlendedApy([makeAlloc({ apyPct: 0 })])).toBe(0);
    });

    it("calculateBlendedApy clamps NaN APY to zero", () => {
        const blended = calculateBlendedApy([
            makeAlloc({ apyPct: Number.NaN, weightPct: 100 }),
        ]);
        expect(blended).toBe(0);
    });

    it("calculateBlendedApy clamps Infinity APY to zero", () => {
        const blended = calculateBlendedApy([
            makeAlloc({ apyPct: Number.POSITIVE_INFINITY, weightPct: 100 }),
        ]);
        expect(blended).toBe(0);
    });

    it("calculateBlendedApy clamps very large APY to zero contribution", () => {
        const blended = calculateBlendedApy([
            makeAlloc({ apyPct: 999999, weightPct: 50 }),
            makeAlloc({ id: "b", apyPct: 10, weightPct: 50 }),
        ]);
        expect(blended).toBe(500004.5);
    });

    it("calculateBlendedApy clamps negative APY to zero contribution", () => {
        const blended = calculateBlendedApy([
            makeAlloc({ apyPct: -50, weightPct: 100 }),
        ]);
        expect(blended).toBe(0);
    });

    it("dailyGrowthFactor returns 1 for 0% rate", () => {
        expect(dailyGrowthFactor(0, "daily")).toBeCloseTo(1, 12);
        expect(dailyGrowthFactor(0, "weekly")).toBeCloseTo(1, 12);
        expect(dailyGrowthFactor(0, "monthly")).toBeCloseTo(1, 12);
        expect(dailyGrowthFactor(0, "continuous")).toBeCloseTo(1, 12);
    });

    it("dailyGrowthFactor clamps negative rate to zero", () => {
        expect(dailyGrowthFactor(-10, "daily")).toBeCloseTo(1, 12);
    });

    it("applyScenario floors at zero for very low APY under stress", () => {
        const result = applyScenario(0.01, "stress");
        expect(result).toBeGreaterThanOrEqual(0);
    });

    it("applyScenario with base multiplier passes through unchanged", () => {
        expect(applyScenario(5, "base")).toBeCloseTo(5);
    });

    it("applyScenario with best multiplier amplifies APY", () => {
        const result = applyScenario(10, "best");
        expect(result).toBeCloseTo(12);
    });

    it("applyScenario with stress multiplier reduces APY", () => {
        const result = applyScenario(10, "stress");
        expect(result).toBeLessThan(10);
        expect(result).toBeGreaterThanOrEqual(0);
    });

    it("applyScenario returns 0 when APY is 0", () => {
        expect(applyScenario(0, "best")).toBe(0);
        expect(applyScenario(0, "base")).toBe(0);
        expect(applyScenario(0, "stress")).toBe(0);
    });

    it("buildSeries starts at principal for day 0", () => {
        const series = buildSeries(1000, 8, "daily", 30);
        expect(series[0].valueUsd).toBe(1000);
        expect(series[0].day).toBe(0);
    });

    it("buildSeries returns correct length for horizon", () => {
        expect(buildSeries(1000, 8, "daily", 7)).toHaveLength(8);
        expect(buildSeries(1000, 8, "daily", 365)).toHaveLength(366);
    });

    it("buildSeries flat for 0% APY", () => {
        const series = buildSeries(10000, 0, "daily", 30);
        expect(series.every((p) => p.valueUsd === 10000)).toBe(true);
    });

    it("buildSeries treats negative principal as zero", () => {
        const series = buildSeries(-500, 10, "daily", 7);
        expect(series.every((p) => p.valueUsd === 0)).toBe(true);
    });

    it("buildSeries is monotonically non-decreasing for positive APY", () => {
        const series = buildSeries(10000, 15, "daily", 90);
        for (let i = 1; i < series.length; i++) {
            expect(series[i].valueUsd).toBeGreaterThanOrEqual(series[i - 1].valueUsd);
        }
    });
});

describe("yieldProjection — fee assumption boundaries", () => {
    it("zero fee drag yields net APY equal to blended APY", () => {
        const result = projectYieldCurve(
            "30d",
            makeAssumptions({
                feeDragPct: 0,
                allocations: [makeAlloc({ apyPct: 10 })],
            }),
        );
        expect(result.netApyPct).toBeCloseTo(10);
    });

    it("fee drag of 100% produces net APY of 0", () => {
        const result = projectYieldCurve(
            "30d",
            makeAssumptions({
                feeDragPct: 100,
                allocations: [makeAlloc({ apyPct: 10 })],
            }),
        );
        expect(result.netApyPct).toBe(0);
    });

    it("fee drag greater than APY floors net at 0", () => {
        const result = projectYieldCurve(
            "30d",
            makeAssumptions({
                feeDragPct: 20,
                allocations: [makeAlloc({ apyPct: 5 })],
            }),
        );
        expect(result.netApyPct).toBe(0);
    });

    it("very small fee drag (0.01%) produces near-APY net", () => {
        const result = projectYieldCurve(
            "30d",
            makeAssumptions({
                feeDragPct: 0.01,
                allocations: [makeAlloc({ apyPct: 10 })],
            }),
        );
        expect(result.netApyPct).toBeCloseTo(9.99);
    });

    it("validateAssumptions rejects feeDragPct > 100", () => {
        const errors = validateAssumptions(
            makeAssumptions({ feeDragPct: 150 }),
        );
        expect(errors.some((e) => e.includes("Fee drag"))).toBe(true);
    });

    it("validateAssumptions accepts feeDragPct exactly 100", () => {
        const errors = validateAssumptions(
            makeAssumptions({ feeDragPct: 100 }),
        );
        expect(errors).toHaveLength(0);
    });

    it("validateAssumptions rejects negative feeDragPct", () => {
        const errors = validateAssumptions(
            makeAssumptions({ feeDragPct: -5 }),
        );
        expect(errors.some((e) => e.includes("Fee drag"))).toBe(true);
    });
});

describe("yieldProjection — displayed totals remain sensible", () => {
    it("total return is positive for positive APY over 365d", () => {
        const result = projectYieldCurve("365d", makeAssumptions());
        expect(result.scenarios.base.totalReturnPct).toBeGreaterThan(0);
    });

    it("total return is 0% when principal is 0", () => {
        const result = projectYieldCurve(
            "30d",
            makeAssumptions({ principalUsd: 0 }),
        );
        expect(result.scenarios.base.totalReturnPct).toBe(0);
        expect(result.scenarios.base.finalValueUsd).toBe(0);
    });

    it("best scenario final value > base > stress for positive APY", () => {
        const result = projectYieldCurve("365d", makeAssumptions());
        expect(result.scenarios.best.finalValueUsd).toBeGreaterThan(
            result.scenarios.base.finalValueUsd,
        );
        expect(result.scenarios.base.finalValueUsd).toBeGreaterThan(
            result.scenarios.stress.finalValueUsd,
        );
    });

    it("all scenarios produce non-negative final values", () => {
        const result = projectYieldCurve("365d", makeAssumptions());
        expect(result.scenarios.best.finalValueUsd).toBeGreaterThanOrEqual(0);
        expect(result.scenarios.base.finalValueUsd).toBeGreaterThanOrEqual(0);
        expect(result.scenarios.stress.finalValueUsd).toBeGreaterThanOrEqual(0);
    });

    it("net APY equals blended APY minus fee drag (floored at 0)", () => {
        const result = projectYieldCurve(
            "30d",
            makeAssumptions({
                feeDragPct: 2,
                allocations: [makeAlloc({ apyPct: 8 })],
            }),
        );
        expect(result.netApyPct).toBeCloseTo(6);
    });

    it("horizon days match expected values", () => {
        const h7 = projectYieldCurve("7d", makeAssumptions());
        const h30 = projectYieldCurve("30d", makeAssumptions());
        const h90 = projectYieldCurve("90d", makeAssumptions());
        const h365 = projectYieldCurve("365d", makeAssumptions());

        expect(h7.horizonDays).toBe(7);
        expect(h30.horizonDays).toBe(30);
        expect(h90.horizonDays).toBe(90);
        expect(h365.horizonDays).toBe(365);
    });

    it("throws for invalid assumptions", () => {
        expect(() =>
            projectYieldCurve("30d", makeAssumptions({ allocations: [] })),
        ).toThrow(/Invalid projection assumptions/);
    });

    it("projection series length matches horizon", () => {
        for (const horizon of ["7d", "30d", "90d", "365d"] as const) {
            const result = projectYieldCurve(horizon, makeAssumptions());
            expect(result.scenarios.base.points).toHaveLength(
                result.horizonDays + 1,
            );
        }
    });
});
