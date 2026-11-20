import { describe, it, expect } from "vitest";
import {
  formatBps,
  sumTargetWeightBps,
  isTargetWeightSumValid,
  hasUnavailableData,
  type BasketRebalancePreview,
} from "./basketRebalancePreview";

describe("formatBps", () => {
  it("formats bps as a percent string", () => {
    expect(formatBps(6000)).toBe("60.00%");
    expect(formatBps(0)).toBe("0.00%");
    expect(formatBps(10000)).toBe("100.00%");
  });
});

describe("sumTargetWeightBps / isTargetWeightSumValid", () => {
  it("sums target weights and validates against 10000 bps", () => {
    const legs = [{ targetWeightBps: 6000 }, { targetWeightBps: 4000 }];
    expect(sumTargetWeightBps(legs)).toBe(10000);
    expect(isTargetWeightSumValid(legs)).toBe(true);
  });

  it("flags an invalid sum", () => {
    const legs = [{ targetWeightBps: 6000 }, { targetWeightBps: 3000 }];
    expect(sumTargetWeightBps(legs)).toBe(9000);
    expect(isTargetWeightSumValid(legs)).toBe(false);
  });
});

describe("hasUnavailableData", () => {
  const base: BasketRebalancePreview = {
    contractId: "C1",
    totalDeposited: "0",
    legs: [],
    rebalanceNeeded: false,
    source: "onchain",
    warnings: [],
  };

  it("is false when source is onchain", () => {
    expect(hasUnavailableData(base)).toBe(false);
  });

  it("is true when source is unavailable", () => {
    expect(hasUnavailableData({ ...base, source: "unavailable" })).toBe(true);
  });
});
