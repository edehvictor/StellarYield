import {
  computeFeeDeviationAlert,
  checkFeeDeviation,
  resetFeeBaseline,
} from "../feeOracleService";

beforeEach(() => {
  resetFeeBaseline();
});

describe("computeFeeDeviationAlert", () => {
  it("returns normal when fee equals baseline", () => {
    const alert = computeFeeDeviationAlert(100, 100);
    expect(alert.level).toBe("normal");
    expect(alert.deviationPct).toBe(0);
  });

  it("returns warning at 25% above baseline", () => {
    const alert = computeFeeDeviationAlert(125, 100);
    expect(alert.level).toBe("warning");
    expect(alert.deviationPct).toBeGreaterThanOrEqual(20);
  });

  it("returns critical at 60% above baseline", () => {
    const alert = computeFeeDeviationAlert(160, 100);
    expect(alert.level).toBe("critical");
    expect(alert.deviationPct).toBeGreaterThanOrEqual(50);
  });

  it("returns normal for small deviation below baseline", () => {
    const alert = computeFeeDeviationAlert(90, 100);
    expect(alert.level).toBe("normal");
  });

  it("returns warning for large drop below baseline", () => {
    const alert = computeFeeDeviationAlert(70, 100);
    expect(alert.level).toBe("warning");
    expect(alert.deviationPct).toBeLessThan(0);
  });

  it("handles zero baseline gracefully", () => {
    const alert = computeFeeDeviationAlert(100, 0);
    expect(alert.level).toBe("normal");
    expect(alert.deviationPct).toBe(0);
  });

  it("includes all required fields", () => {
    const alert = computeFeeDeviationAlert(200, 100);
    expect(alert).toMatchObject({
      currentFee: 200,
      baselineFee: 100,
      warningThresholdPct: 20,
      criticalThresholdPct: 50,
    });
    expect(alert.message).toBeTruthy();
    expect(alert.generatedAt).toBeTruthy();
  });
});

describe("checkFeeDeviation (stateful)", () => {
  it("baseline initialises to first observation", () => {
    const alert = checkFeeDeviation(100);
    expect(alert.level).toBe("normal");
    expect(alert.baselineFee).toBe(100);
  });

  it("detects spike after baseline is established", () => {
    checkFeeDeviation(100);
    checkFeeDeviation(100);
    checkFeeDeviation(100);
    const spike = checkFeeDeviation(500);
    expect(spike.level).not.toBe("normal");
  });

  it("baseline resets after resetFeeBaseline()", () => {
    checkFeeDeviation(1000);
    resetFeeBaseline();
    const alert = checkFeeDeviation(100);
    expect(alert.baselineFee).toBe(100);
  });
});
