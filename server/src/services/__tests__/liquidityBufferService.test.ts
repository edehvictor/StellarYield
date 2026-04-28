import {
  recommendLiquidityBuffer,
  recommendLiquidityBuffers,
} from "../liquidityBufferService";

describe("liquidityBufferService", () => {
  it("computes conservative buffer for low stress", () => {
    const rec = recommendLiquidityBuffer({
      strategyId: "s1",
      strategyVolatilityPct: 4,
      withdrawalVelocityPctPerDay: 2,
      protocolHealthScore: 92,
      liquidityDepthUsd: 2_000_000,
      strategyTvlUsd: 1_000_000,
    });

    expect(rec.stressLevel).toBe("low");
    expect(rec.recommendedBufferPct).toBeGreaterThanOrEqual(0.08);
  });

  it("computes medium stress buffer", () => {
    const rec = recommendLiquidityBuffer({
      strategyId: "s2",
      strategyVolatilityPct: 10,
      withdrawalVelocityPctPerDay: 7,
      protocolHealthScore: 72,
      liquidityDepthUsd: 900_000,
      strategyTvlUsd: 1_000_000,
    });

    expect(rec.stressLevel).toBe("medium");
    expect(rec.recommendedBufferPct).toBeGreaterThanOrEqual(0.14);
  });

  it("computes stressed buffer and ambiguity guard", () => {
    const rec = recommendLiquidityBuffer({
      strategyId: "s3",
      strategyVolatilityPct: 18,
      withdrawalVelocityPctPerDay: 15,
      protocolHealthScore: 44,
      liquidityDepthUsd: 250_000,
      strategyTvlUsd: 1_000_000,
      ambiguousStressSignal: true,
    });

    expect(rec.stressLevel).toBe("stressed");
    expect(rec.recommendedBufferPct).toBeGreaterThanOrEqual(0.22);
  });

  it("supports portfolio-wide recommendation", () => {
    const recs = recommendLiquidityBuffers([
      {
        strategyId: "a",
        strategyVolatilityPct: 3,
        withdrawalVelocityPctPerDay: 1,
        protocolHealthScore: 90,
        liquidityDepthUsd: 2_000_000,
        strategyTvlUsd: 1_000_000,
      },
    ]);

    expect(recs).toHaveLength(1);
  });
});
