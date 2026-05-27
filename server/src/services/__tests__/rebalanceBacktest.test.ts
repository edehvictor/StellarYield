import {
  runRebalanceBacktest,
  validateRebalanceBacktestParams,
  type RebalanceBacktestParams,
} from "../simulationService";

const BASE_PARAMS: RebalanceBacktestParams = {
  initialValueUsd: 10_000,
  startDate: "2024-01-01",
  endDate: "2024-03-31",
  allocations: [
    { label: "Blend", targetWeight: 60, apy: 8 },
    { label: "Soroswap", targetWeight: 40, apy: 12 },
  ],
  strategy: "schedule",
  rebalanceIntervalDays: 30,
  feeBps: 20,
};

describe("validateRebalanceBacktestParams", () => {
  it("accepts valid params", () => {
    expect(validateRebalanceBacktestParams(BASE_PARAMS)).toEqual([]);
  });

  it("rejects when startDate >= endDate", () => {
    const params = { ...BASE_PARAMS, startDate: "2024-03-31", endDate: "2024-01-01" };
    expect(validateRebalanceBacktestParams(params)).toContain(
      "startDate must be before endDate.",
    );
  });

  it("rejects when weights do not sum to 100", () => {
    const params = {
      ...BASE_PARAMS,
      allocations: [
        { label: "A", targetWeight: 50, apy: 8 },
        { label: "B", targetWeight: 40, apy: 12 },
      ],
    };
    const errors = validateRebalanceBacktestParams(params);
    expect(errors.some((e) => e.includes("sum to 100"))).toBe(true);
  });

  it("rejects invalid strategy", () => {
    const params = { ...BASE_PARAMS, strategy: "unknown" as "schedule" };
    expect(validateRebalanceBacktestParams(params)).toContain(
      "strategy must be 'schedule' or 'threshold'.",
    );
  });

  it("rejects non-positive initialValueUsd", () => {
    const params = { ...BASE_PARAMS, initialValueUsd: 0 };
    expect(validateRebalanceBacktestParams(params)).toContain(
      "initialValueUsd must be a positive number.",
    );
  });
});

describe("runRebalanceBacktest", () => {
  it("is marked simulation-only", () => {
    const result = runRebalanceBacktest(BASE_PARAMS);
    expect(result.isSimulationOnly).toBe(true);
  });

  it("produces one snapshot per day (91 days for Jan-Mar 2024)", () => {
    const result = runRebalanceBacktest(BASE_PARAMS);
    expect(result.snapshots.length).toBe(91);
  });

  it("portfolioReturnPct > 0 for positive APY allocations", () => {
    const result = runRebalanceBacktest(BASE_PARAMS);
    expect(result.portfolioReturnPct).toBeGreaterThan(0);
  });

  it("first snapshot date matches startDate", () => {
    const result = runRebalanceBacktest(BASE_PARAMS);
    expect(result.snapshots[0].date).toBe("2024-01-01");
  });

  it("last snapshot date matches endDate", () => {
    const result = runRebalanceBacktest(BASE_PARAMS);
    expect(result.snapshots[result.snapshots.length - 1].date).toBe("2024-03-31");
  });

  it("schedule strategy fires rebalance events on interval days", () => {
    const result = runRebalanceBacktest(BASE_PARAMS);
    expect(result.rebalanceCount).toBeGreaterThan(0);
    expect(result.rebalanceCount).toBeLessThanOrEqual(3);
  });

  it("threshold strategy fires rebalance when drift exceeds threshold", () => {
    const params: RebalanceBacktestParams = {
      ...BASE_PARAMS,
      strategy: "threshold",
      driftThresholdPct: 0.01,
    };
    const result = runRebalanceBacktest(params);
    expect(result.rebalanceCount).toBeGreaterThan(0);
  });

  it("higher feeBps reduces final portfolio value", () => {
    const withFees = runRebalanceBacktest({ ...BASE_PARAMS, feeBps: 200 });
    const noFees = runRebalanceBacktest({ ...BASE_PARAMS, feeBps: 0 });
    expect(withFees.finalPortfolioValue).toBeLessThan(noFees.finalPortfolioValue);
  });

  it("passive benchmark grows without rebalancing", () => {
    const result = runRebalanceBacktest(BASE_PARAMS);
    expect(result.finalPassiveValue).toBeGreaterThan(BASE_PARAMS.initialValueUsd);
  });

  it("throws for invalid params", () => {
    const bad = { ...BASE_PARAMS, initialValueUsd: -1 };
    expect(() => runRebalanceBacktest(bad)).toThrow("Invalid backtest parameters");
  });

  it("is deterministic — same inputs always produce same outputs", () => {
    const r1 = runRebalanceBacktest(BASE_PARAMS);
    const r2 = runRebalanceBacktest(BASE_PARAMS);
    expect(r1.finalPortfolioValue).toBe(r2.finalPortfolioValue);
    expect(r1.rebalanceCount).toBe(r2.rebalanceCount);
    expect(r1.snapshots.length).toBe(r2.snapshots.length);
  });
});
