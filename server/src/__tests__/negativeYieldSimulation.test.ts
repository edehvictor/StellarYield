/**
 * Negative yield periods in the strategy simulators (#1407).
 *
 * The preview and the backtest used to reject any APY below zero, so a user
 * could not model a depeg, a slashing event or a strategy that costs more than
 * it earns. These tests pin the new behaviour: negative yields are accepted
 * within explicit bounds, applied as losses to principal, and reported through
 * drawdown metrics and structured warnings.
 */

import express from "express";
import request from "supertest";

import simulatorRouter from "../routes/simulator";
import {
  MIN_ANNUAL_APY_PCT,
  MIN_DAILY_APY_PCT,
  runRebalanceBacktest,
  simulateRebalance,
  validateRebalanceBacktestParams,
  validateRebalanceParams,
  type RebalanceAllocationRule,
  type RebalanceBacktestParams,
  type RebalanceParams,
} from "../services/simulationService";

const YEAR = { startDate: "2025-01-01", endDate: "2025-12-31" }; // 365 simulated days

/** A week-long window: 7 simulated days, day indexes 0..6. */
const WEEK = { startDate: "2025-03-01", endDate: "2025-03-07" };

function backtest(
  allocations: RebalanceAllocationRule[],
  overrides: Partial<RebalanceBacktestParams> = {},
): RebalanceBacktestParams {
  return {
    initialValueUsd: 10_000,
    ...WEEK,
    allocations,
    strategy: "schedule",
    rebalanceIntervalDays: 30,
    feeBps: 0,
    ...overrides,
  };
}

const single = (apy: number, dailyApy?: number[]): RebalanceAllocationRule[] => [
  { label: "Vault", targetWeight: 100, apy, ...(dailyApy ? { dailyApy } : {}) },
];

const codes = (result: { warnings: Array<{ code: string }> }) => result.warnings.map((w) => w.code);

// ── Validation ────────────────────────────────────────────────────────────

describe("validateRebalanceBacktestParams — negative yields", () => {
  it("accepts a negative annual APY", () => {
    expect(validateRebalanceBacktestParams(backtest(single(-5)))).toEqual([]);
  });

  it("accepts the annual floor of -100% and rejects anything below it", () => {
    expect(validateRebalanceBacktestParams(backtest(single(MIN_ANNUAL_APY_PCT)))).toEqual([]);

    const errors = validateRebalanceBacktestParams(backtest(single(MIN_ANNUAL_APY_PCT - 0.01)));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`at least ${MIN_ANNUAL_APY_PCT}%`);
  });

  it.each([NaN, Infinity, -Infinity, "5", null, undefined])("rejects the non-numeric apy %p", (apy) => {
    const errors = validateRebalanceBacktestParams(backtest(single(apy as unknown as number)));

    expect(errors.some((e) => e.includes("must be a finite number"))).toBe(true);
  });

  describe("dailyApy", () => {
    it("accepts negative entries, including the one-day wipe-out floor", () => {
      const errors = validateRebalanceBacktestParams(
        backtest(single(5, [1, -50, MIN_DAILY_APY_PCT, 0, 3])),
      );

      expect(errors).toEqual([]);
    });

    it("rejects an entry below the floor and names its index", () => {
      const errors = validateRebalanceBacktestParams(
        backtest(single(5, [1, 2, MIN_DAILY_APY_PCT - 1])),
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("dailyApy[2]");
      expect(errors[0]).toContain(`${MIN_DAILY_APY_PCT}%`);
    });

    it.each([NaN, Infinity, "3"])("rejects the non-numeric entry %p", (bad) => {
      const errors = validateRebalanceBacktestParams(
        backtest(single(5, [1, bad as unknown as number])),
      );

      expect(errors.some((e) => e.includes("dailyApy[1]"))).toBe(true);
    });

    it("rejects a value that is not an array", () => {
      const errors = validateRebalanceBacktestParams(
        backtest([{ label: "Vault", targetWeight: 100, apy: 5, dailyApy: "nope" as unknown as number[] }]),
      );

      expect(errors.some((e) => e.includes("must be an array"))).toBe(true);
    });

    it("rejects an oversized series", () => {
      const errors = validateRebalanceBacktestParams(
        backtest(single(5, new Array(1827).fill(1))),
      );

      expect(errors.some((e) => e.includes("too many entries"))).toBe(true);
    });

    it("accepts a series shorter than the window (later days use the fallback apy)", () => {
      expect(validateRebalanceBacktestParams(backtest(single(5, [1, 2])))).toEqual([]);
    });
  });
});

describe("validateRebalanceParams (preview) — negative yields", () => {
  const preview = (apy: number): RebalanceParams => ({
    totalValueUsd: 10_000,
    allocations: [
      { label: "A", currentWeight: 50, targetWeight: 50, apy },
      { label: "B", currentWeight: 50, targetWeight: 50, apy: 5 },
    ],
  });

  it("accepts a negative APY and the -100% floor", () => {
    expect(validateRebalanceParams(preview(-3))).toEqual([]);
    expect(validateRebalanceParams(preview(MIN_ANNUAL_APY_PCT))).toEqual([]);
  });

  it("rejects an APY below the floor with a clear message", () => {
    const errors = validateRebalanceParams(preview(-101));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/at least -100%/);
  });

  it("still rejects non-finite input", () => {
    expect(validateRebalanceParams(preview(NaN))[0]).toMatch(/finite number/);
  });
});

// ── Backtest engine ───────────────────────────────────────────────────────

describe("runRebalanceBacktest — negative yield", () => {
  it("compounds a constant negative APY as a loss to principal", () => {
    const result = runRebalanceBacktest(backtest(single(-10), YEAR));

    const expected = 10_000 * Math.pow(1 + -10 / 100 / 365, 365);
    expect(result.finalPortfolioValue).toBeCloseTo(expected, 1);
    expect(result.finalPortfolioValue).toBeLessThan(10_000);
    expect(result.portfolioReturnPct).toBeLessThan(0);
    expect(result.snapshots).toHaveLength(365);
  });

  it("reports a negative blended APY on every day of the loss", () => {
    const result = runRebalanceBacktest(backtest(single(-4)));

    expect(result.snapshots.every((s) => s.blendedApyPct === -4)).toBe(true);
    expect(result.negativeYieldDays).toBe(7);
  });

  it("counts only the days whose blended yield is negative", () => {
    // Days 2, 3 and 5 are losses; the other four are gains or flat.
    const result = runRebalanceBacktest(backtest(single(0, [5, 0, -3, -8, 2, -1, 4])));

    expect(result.negativeYieldDays).toBe(3);
  });

  it("nets a negative allocation against a positive one in the blended yield", () => {
    const result = runRebalanceBacktest(
      backtest([
        { label: "Loser", targetWeight: 50, apy: -20 },
        { label: "Winner", targetWeight: 50, apy: 10 },
      ]),
    );

    // 0.5 * -20 + 0.5 * 10 = -5 on day 0 (weights start at target).
    expect(result.snapshots[0].blendedApyPct).toBeCloseTo(-5, 1);
    expect(result.negativeYieldDays).toBeGreaterThan(0);
  });

  describe("drawdown", () => {
    it("measures a one-day crash as a drawdown", () => {
      // -3650% APY is a 10% fall in one day (factor 0.9).
      const result = runRebalanceBacktest(backtest(single(0, [0, 0, -3650, 0, 0, 0, 0])));

      expect(result.finalPortfolioValue).toBeCloseTo(9_000, 1);
      expect(result.maxDrawdownPct).toBeCloseTo(10, 1);
      expect(result.passiveMaxDrawdownPct).toBeCloseTo(10, 1);
    });

    it("measures peak-to-trough, not the loss against the start", () => {
      // +10%, then -10%, then +10%: ends above the start but fell ~10% from the peak.
      const result = runRebalanceBacktest(backtest(single(0, [3650, -3650, 3650, 0, 0, 0, 0])));

      expect(result.finalPortfolioValue).toBeGreaterThan(10_000);
      expect(result.maxDrawdownPct).toBeCloseTo(10, 1);
    });

    it("reports zero drawdown when yield is never negative", () => {
      const result = runRebalanceBacktest(backtest(single(8)));

      expect(result.maxDrawdownPct).toBe(0);
      expect(result.passiveMaxDrawdownPct).toBe(0);
      expect(result.negativeYieldDays).toBe(0);
    });

    it("does not report drawdown for a steady rise", () => {
      const result = runRebalanceBacktest(backtest(single(0, [10, 20, 30, 40, 50, 60, 70])));

      expect(result.maxDrawdownPct).toBe(0);
    });
  });

  describe("wipe-out", () => {
    it("handles an allocation that loses all of its value in one day without producing NaN", () => {
      const result = runRebalanceBacktest(
        backtest(single(0, [0, MIN_DAILY_APY_PCT, 0, 0, 0, 0, 0])),
      );

      expect(result.finalPortfolioValue).toBe(0);
      expect(result.portfolioReturnPct).toBe(-100);
      expect(result.maxDrawdownPct).toBe(100);
      for (const snapshot of result.snapshots) {
        expect(Number.isFinite(snapshot.portfolioValue)).toBe(true);
        expect(Number.isFinite(snapshot.passiveValue)).toBe(true);
        expect(Number.isFinite(snapshot.blendedApyPct)).toBe(true);
      }
      expect(result.rebalanceCount).toBe(0);
      expect(result.totalFeesUsd).toBe(0);
    });

    it("never lets a value go below zero, even for the most extreme accepted input", () => {
      const result = runRebalanceBacktest(backtest(single(0, new Array(7).fill(MIN_DAILY_APY_PCT))));

      expect(result.snapshots.every((s) => s.portfolioValue >= 0)).toBe(true);
    });

    it("re-funds a wiped-out allocation from the survivors on rebalance", () => {
      const result = runRebalanceBacktest(
        backtest(
          [
            { label: "Wiped", targetWeight: 50, apy: 0, dailyApy: [0, MIN_DAILY_APY_PCT, 0, 0, 0, 0, 0] },
            { label: "Survivor", targetWeight: 50, apy: 0 },
          ],
          { strategy: "threshold", driftThresholdPct: 5, feeBps: 0 },
        ),
      );

      // Day 1: 5,000 is lost outright, leaving 5,000; drift is 50% > 5%.
      expect(result.rebalanceEvents[0].date).toBe("2025-03-02");
      expect(result.rebalanceEvents[0].maxDriftPct).toBeCloseTo(50, 1);
      expect(result.finalPortfolioValue).toBeCloseTo(5_000, 1);
      expect(result.finalPassiveValue).toBeCloseTo(5_000, 1);
    });
  });

  describe("threshold rebalancing under loss", () => {
    it("triggers when a loss pushes weights past the threshold", () => {
      // -18,250% APY halves one leg in a day: weights go 50/50 -> 33.3/66.7.
      const result = runRebalanceBacktest(
        backtest(
          [
            { label: "Falls", targetWeight: 50, apy: 0, dailyApy: [0, -18_250, 0, 0, 0, 0, 0] },
            { label: "Steady", targetWeight: 50, apy: 0 },
          ],
          { strategy: "threshold", driftThresholdPct: 5 },
        ),
      );

      expect(result.rebalanceEvents).toHaveLength(1);
      expect(result.rebalanceEvents[0].reason).toContain("exceeded 5% threshold");
      expect(result.rebalanceEvents[0].maxDriftPct).toBeCloseTo(16.67, 1);
    });

    it("charges the rebalance fee on top of the loss", () => {
      const withFee = runRebalanceBacktest(
        backtest(
          [
            { label: "Falls", targetWeight: 50, apy: 0, dailyApy: [0, -18_250, 0, 0, 0, 0, 0] },
            { label: "Steady", targetWeight: 50, apy: 0 },
          ],
          { strategy: "threshold", driftThresholdPct: 5, feeBps: 100 },
        ),
      );

      expect(withFee.totalFeesUsd).toBeGreaterThan(0);
      expect(withFee.finalPortfolioValue).toBeLessThan(withFee.finalPassiveValue);
    });
  });

  describe("warnings", () => {
    it("emits NEGATIVE_YIELD_PERIOD for an allocation with a negative APY", () => {
      const result = runRebalanceBacktest(backtest(single(-6)));

      const warning = result.warnings.find((w) => w.code === "NEGATIVE_YIELD_PERIOD");
      expect(warning).toMatchObject({
        severity: "warning",
        affectedField: "allocations[Vault].apy",
      });
      expect(warning?.message).toContain("7 of 7 simulated days");
      expect(warning?.message).toContain("-6%");
      expect(warning?.remediation).toMatch(/Performance fees apply only to positive yield/);
    });

    it("points at dailyApy when the losses come from the daily series", () => {
      const result = runRebalanceBacktest(backtest(single(5, [1, -40, 2, 3, 4, 5, 6])));

      const warning = result.warnings.find((w) => w.code === "NEGATIVE_YIELD_PERIOD");
      expect(warning?.affectedField).toBe("allocations[Vault].dailyApy");
      expect(warning?.message).toContain("1 of 7 simulated days");
      expect(warning?.message).toContain("-40%");
    });

    it("emits one warning per negative allocation and none for the others", () => {
      const result = runRebalanceBacktest(
        backtest([
          { label: "A", targetWeight: 34, apy: -1 },
          { label: "B", targetWeight: 33, apy: 6 },
          { label: "C", targetWeight: 33, apy: -2 },
        ]),
      );

      const negative = result.warnings.filter((w) => w.code === "NEGATIVE_YIELD_PERIOD");
      expect(negative.map((w) => w.affectedField)).toEqual([
        "allocations[A].apy",
        "allocations[C].apy",
      ]);
    });

    it("emits CAPITAL_LOSS when the portfolio ends below its starting value", () => {
      const result = runRebalanceBacktest(backtest(single(-50)));

      const warning = result.warnings.find((w) => w.code === "CAPITAL_LOSS");
      expect(warning).toBeDefined();
      expect(warning?.message).toMatch(/below its starting value of \$10000/);
    });

    it("does not emit CAPITAL_LOSS when a negative allocation is outweighed by gains", () => {
      const result = runRebalanceBacktest(
        backtest(
          [
            { label: "Loser", targetWeight: 50, apy: -5 },
            { label: "Winner", targetWeight: 50, apy: 60 },
          ],
          YEAR,
        ),
      );

      expect(codes(result)).toContain("NEGATIVE_YIELD_PERIOD");
      expect(codes(result)).not.toContain("CAPITAL_LOSS");
      expect(result.finalPortfolioValue).toBeGreaterThan(10_000);
    });

    it("emits neither warning when every yield is positive", () => {
      const result = runRebalanceBacktest(backtest(single(8)));

      expect(codes(result)).not.toContain("NEGATIVE_YIELD_PERIOD");
      expect(codes(result)).not.toContain("CAPITAL_LOSS");
    });

    it("counts a negative day only inside the simulated window", () => {
      // The series is longer than the 7-day window; only index < 7 is simulated.
      const result = runRebalanceBacktest(backtest(single(5, [1, 1, 1, 1, 1, 1, 1, -90, -90])));

      expect(codes(result)).not.toContain("NEGATIVE_YIELD_PERIOD");
      expect(result.negativeYieldDays).toBe(0);
    });
  });

  it("is deterministic", () => {
    const params = backtest(single(-7, [1, -2, -3, 4, 5, -6, 7]));

    expect(runRebalanceBacktest(params)).toEqual(runRebalanceBacktest(params));
  });

  it("leaves a positive-yield backtest unchanged apart from the new zeroed metrics", () => {
    const result = runRebalanceBacktest(backtest(single(8), YEAR));

    expect(result.negativeYieldDays).toBe(0);
    expect(result.maxDrawdownPct).toBe(0);
    expect(result.finalPortfolioValue).toBeCloseTo(10_000 * Math.pow(1 + 8 / 100 / 365, 365), 1);
  });

  it("throws on invalid input instead of simulating it", () => {
    expect(() => runRebalanceBacktest(backtest(single(-101)))).toThrow(/at least -100%/);
  });
});

// ── Rebalance preview ─────────────────────────────────────────────────────

describe("simulateRebalance — negative yield", () => {
  const params = (targetB: number): RebalanceParams => ({
    totalValueUsd: 10_000,
    snapshotTimestamp: new Date().toISOString(),
    allocations: [
      { label: "Steady", currentWeight: 50, targetWeight: 100 - targetB, apy: 10 },
      { label: "Bleeding", currentWeight: 50, targetWeight: targetB, apy: -8 },
    ],
  });

  it("blends a negative APY into the projected yield", () => {
    const preview = simulateRebalance(params(50));

    expect(preview.blendedApyBefore).toBeCloseTo(1, 2); // 0.5*10 + 0.5*-8
    expect(preview.blendedApyAfter).toBeCloseTo(1, 2);
  });

  it("shows the projected yield turning negative when the target favours the loser", () => {
    const preview = simulateRebalance(params(90));

    expect(preview.blendedApyAfter).toBeCloseTo(-6.2, 2);
    expect(preview.apyDeltaPct).toBeCloseTo(-7.2, 2);
  });

  it("warns about a negative-yield leg that keeps a target weight", () => {
    const preview = simulateRebalance(params(30));

    const warning = preview.warnings.find((w) => w.code === "NEGATIVE_YIELD_PERIOD");
    expect(warning?.affectedField).toBe("allocations[Bleeding].apy");
    expect(warning?.message).toContain("-8%");
    expect(warning?.message).toContain("30% target weight");
  });

  it("does not warn when the negative-yield leg is being exited", () => {
    const preview = simulateRebalance(params(0));

    expect(codes(preview)).not.toContain("NEGATIVE_YIELD_PERIOD");
  });

  it("does not warn when every yield is positive", () => {
    const positive: RebalanceParams = {
      ...params(50),
      allocations: params(50).allocations.map((a) => ({ ...a, apy: Math.abs(a.apy) })),
    };

    expect(codes(simulateRebalance(positive))).not.toContain("NEGATIVE_YIELD_PERIOD");
  });
});

// ── HTTP routes ───────────────────────────────────────────────────────────

describe("simulator routes — negative yield", () => {
  const app = express().use(express.json()).use("/api/simulator", simulatorRouter);

  it("POST /rebalance-backtest accepts a negative APY and returns loss metrics", async () => {
    const res = await request(app)
      .post("/api/simulator/rebalance-backtest")
      .send(backtest(single(-12), YEAR))
      .expect(200);

    expect(res.body.isSimulationOnly).toBe(true);
    expect(res.body.portfolioReturnPct).toBeLessThan(0);
    expect(res.body.negativeYieldDays).toBe(365);
    expect(res.body.maxDrawdownPct).toBeGreaterThan(0);
    expect(res.body.warnings.map((w: { code: string }) => w.code)).toEqual(
      expect.arrayContaining(["NEGATIVE_YIELD_PERIOD", "CAPITAL_LOSS"]),
    );
  });

  it("POST /rebalance-backtest rejects an APY below the floor with a 400 and details", async () => {
    const res = await request(app)
      .post("/api/simulator/rebalance-backtest")
      .send(backtest(single(-250)))
      .expect(400);

    expect(res.body.error).toBe("Invalid backtest parameters");
    expect(res.body.details[0]).toContain("at least -100%");
  });

  it("POST /rebalance-backtest rejects an out-of-range dailyApy entry", async () => {
    const res = await request(app)
      .post("/api/simulator/rebalance-backtest")
      .send(backtest(single(5, [1, -99_999])))
      .expect(400);

    expect(res.body.details[0]).toContain("dailyApy[1]");
  });

  it("POST /rebalance accepts a negative APY and warns about it", async () => {
    const res = await request(app)
      .post("/api/simulator/rebalance")
      .send({
        totalValueUsd: 10_000,
        snapshotTimestamp: new Date().toISOString(),
        allocations: [
          { label: "A", currentWeight: 60, targetWeight: 40, apy: 9 },
          { label: "B", currentWeight: 40, targetWeight: 60, apy: -2 },
        ],
      })
      .expect(200);

    expect(res.body.warnings.map((w: { code: string }) => w.code)).toContain("NEGATIVE_YIELD_PERIOD");
  });

  it("POST /rebalance rejects an APY below the floor", async () => {
    await request(app)
      .post("/api/simulator/rebalance")
      .send({
        totalValueUsd: 10_000,
        allocations: [
          { label: "A", currentWeight: 50, targetWeight: 50, apy: -500 },
          { label: "B", currentWeight: 50, targetWeight: 50, apy: 5 },
        ],
      })
      .expect(400);
  });
});
