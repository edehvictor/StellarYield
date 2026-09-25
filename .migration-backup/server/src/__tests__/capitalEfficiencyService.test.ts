import { calculateCapitalEfficiency } from "../services/capitalEfficiencyService";

describe("capitalEfficiencyService", () => {
  it("normalizes score and assigns rank", () => {
    const result = calculateCapitalEfficiency({
      utilizationPct: 88,
      feeDragPct: 1.2,
      rotationCostPct: 1.5,
      liquidityDepthUsd: 4_200_000,
    });

    expect(result.score).toBeGreaterThan(70);
    expect(result.grade).toMatch(/[AB]/);
    expect(result.hasMissingInputs).toBe(false);
  });

  it("handles missing fields safely without misleading rankings", () => {
    const result = calculateCapitalEfficiency({
      utilizationPct: 50,
    });

    expect(result.hasMissingInputs).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
