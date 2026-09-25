import { describe, it, expect } from "vitest";
import {
  normalizeDailySnapshots,
  normalizePnLData,
  hasNoData,
  hasPartialData,
  isSparseChartData,
} from "./pnlChartUtils";

describe("pnlChartUtils", () => {
  it("filters invalid snapshot rows", () => {
    const result = normalizeDailySnapshots([
      { date: "2024-01-01", cumulativePnL: 100, portfolioValue: 10100, sharePrice: 1.01 },
      { date: "invalid", cumulativePnL: 50, portfolioValue: 10050, sharePrice: 1.0 },
      { cumulativePnL: 25, portfolioValue: 10025, sharePrice: 1.0 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2024-01-01");
  });

  it("sorts out-of-order snapshots by date", () => {
    const result = normalizeDailySnapshots([
      { date: "2024-01-03", cumulativePnL: 300, portfolioValue: 10300, sharePrice: 1.03 },
      { date: "2024-01-01", cumulativePnL: 100, portfolioValue: 10100, sharePrice: 1.01 },
      { date: "2024-01-02", cumulativePnL: 200, portfolioValue: 10200, sharePrice: 1.02 },
    ]);

    expect(result.map((p) => p.date)).toEqual([
      "2024-01-01",
      "2024-01-02",
      "2024-01-03",
    ]);
  });

  it("deduplicates snapshots by date (last wins)", () => {
    const result = normalizeDailySnapshots([
      { date: "2024-01-01", cumulativePnL: 100, portfolioValue: 10100, sharePrice: 1.01 },
      { date: "2024-01-01", cumulativePnL: 150, portfolioValue: 10150, sharePrice: 1.015 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].cumulativePnL).toBe(150);
  });

  it("normalizes mixed-format API payload", () => {
    const data = normalizePnLData({
      totalDeposited: "10000",
      totalWithdrawn: 0,
      currentValue: "10500",
      costBasis: 10000,
      absolutePnL: "500",
      twrPercent: "5",
      dailySnapshots: [
        { date: "2024-01-02", cumulativePnL: "200", portfolioValue: 10200, sharePrice: "1.02" },
        { date: "2024-01-01", cumulativePnL: 100, portfolioValue: 10100, sharePrice: 1.01 },
      ],
    } as unknown as Parameters<typeof normalizePnLData>[0]);

    expect(data.totalDeposited).toBe(10000);
    expect(data.dailySnapshots[0].date).toBe("2024-01-01");
    expect(hasNoData(data)).toBe(false);
    expect(hasPartialData(data)).toBe(false);
  });

  it("detects empty and partial datasets", () => {
    expect(hasNoData(normalizePnLData({ totalDeposited: 0, dailySnapshots: [] }))).toBe(true);
    expect(
      hasPartialData(
        normalizePnLData({ totalDeposited: 5000, dailySnapshots: [] }),
      ),
    ).toBe(true);
  });

  it("flags sparse chart data", () => {
    expect(isSparseChartData([{ date: "2024-01-01", cumulativePnL: 0, portfolioValue: 100, sharePrice: 1 }])).toBe(true);
    expect(
      isSparseChartData([
        { date: "2024-01-01", cumulativePnL: 0, portfolioValue: 100, sharePrice: 1 },
        { date: "2024-01-02", cumulativePnL: 10, portfolioValue: 110, sharePrice: 1.01 },
        { date: "2024-01-03", cumulativePnL: 20, portfolioValue: 120, sharePrice: 1.02 },
      ]),
    ).toBe(false);
  });
});
