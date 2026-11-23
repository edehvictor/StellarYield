import { describe, expect, it } from "vitest";
import {
  calculateCompoundProjection,
  calculateProjectionMetrics,
  formatCurrency,
  formatPercentage,
  validateConfig,
} from "../compoundMath";

describe("compound math boundary hardening", () => {
  it("validates normal and zero boundary inputs", () => {
    expect(
      validateConfig({
        principal: 0,
        apy: 0,
        monthlyContribution: 0,
        years: 1,
      }),
    ).toEqual([]);
  });

  it("rejects non-finite and out-of-range boundary inputs", () => {
    expect(
      validateConfig({
        principal: Number.NaN,
        apy: Number.POSITIVE_INFINITY,
        monthlyContribution: Number.NaN,
        years: Number.POSITIVE_INFINITY,
      }).length,
    ).toBeGreaterThan(0);

    expect(
      validateConfig({
        principal: -1,
        apy: -1,
        monthlyContribution: -1,
        years: 0,
      }),
    ).toEqual(
      expect.arrayContaining([
        "Initial deposit cannot be negative",
        "APY cannot be negative",
        "Monthly contribution cannot be negative",
        "Time horizon must be at least 1 year",
      ]),
    );
  });

  it("formats non-finite display values safely", () => {
    expect(formatCurrency(Number.NaN)).toBe("—");
    expect(formatCurrency(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatPercentage(Number.NaN)).toBe("—%");
    expect(formatPercentage(Number.NEGATIVE_INFINITY)).toBe("—%");
  });

  it("returns finite projections and metrics for near-limit valid inputs", () => {
    const projections = calculateCompoundProjection({
      principal: 1_000_000_000,
      apy: 1000,
      monthlyContribution: 1_000_000,
      years: 50,
    });

    expect(projections.length).toBe(50 * 12 + 1);
    const last = projections[projections.length - 1];
    expect(Number.isFinite(last.compoundValue)).toBe(true);
    expect(Number.isFinite(last.simpleValue)).toBe(true);
    expect(Number.isFinite(last.principalOnly)).toBe(true);
    expect(Number.isFinite(last.totalInterest)).toBe(true);

    const metrics = calculateProjectionMetrics(projections);
    expect(Number.isFinite(metrics.finalValue)).toBe(true);
    expect(Number.isFinite(metrics.totalContributions)).toBe(true);
    expect(Number.isFinite(metrics.totalInterest)).toBe(true);
    expect(Number.isFinite(metrics.totalReturnPercent)).toBe(true);
    expect(Number.isFinite(metrics.annualizedReturn)).toBe(true);
  });

  it("fails safely for invalid config by returning no projections", () => {
    const projections = calculateCompoundProjection({
      principal: Number.NaN,
      apy: 5,
      monthlyContribution: 0,
      years: 5,
    });
    expect(projections).toEqual([]);
  });
});
