import {
  recommendLiquidityBuffer,
  recommendLiquidityBuffers,
  classifyLiquidityBand,
  classifyRouteRisk,
} from "../services/liquidityBufferService";

describe("liquidityBufferService (Issue #1105)", () => {
  describe("Major Liquidity Bands: thin, normal, deep", () => {
    it("handles thin liquidity paths with high buffer recommendation and restricted sizing", () => {
      const rec = recommendLiquidityBuffer({
        strategyId: "thin_path",
        strategyVolatilityPct: 8,
        withdrawalVelocityPctPerDay: 4,
        protocolHealthScore: 80,
        liquidityDepthUsd: 180_000,
        strategyTvlUsd: 1_000_000,
      });

      expect(rec.liquidityBand).toBe("thin");
      expect(rec.recommendedBufferPct).toBeGreaterThan(0.12);
      expect(rec.safeExecutionSizeUsd).toBeLessThan(rec.liquidityDepthUsd * 0.05);
      expect(rec.rationale.some((r) => r.includes("thin liquidity band"))).toBe(true);
    });

    it("handles normal liquidity paths with standard buffer", () => {
      const rec = recommendLiquidityBuffer({
        strategyId: "normal_path",
        strategyVolatilityPct: 6,
        withdrawalVelocityPctPerDay: 3,
        protocolHealthScore: 85,
        liquidityDepthUsd: 1_200_000,
        strategyTvlUsd: 1_000_000,
      });

      expect(rec.liquidityBand).toBe("normal");
      expect(rec.safeExecutionSizeUsd).toBeGreaterThan(rec.liquidityDepthUsd * 0.05);
      expect(rec.rationale.some((r) => r.includes("normal liquidity band"))).toBe(true);
    });

    it("handles deep liquidity paths with low slippage penalty and large safe execution capacity", () => {
      const rec = recommendLiquidityBuffer({
        strategyId: "deep_path",
        strategyVolatilityPct: 4,
        withdrawalVelocityPctPerDay: 2,
        protocolHealthScore: 92,
        liquidityDepthUsd: 4_000_000,
        strategyTvlUsd: 1_000_000,
      });

      expect(rec.liquidityBand).toBe("deep");
      expect(rec.safeExecutionSizeUsd).toBeGreaterThan(rec.liquidityDepthUsd * 0.1);
      expect(rec.rationale.some((r) => r.includes("deep liquidity band"))).toBe(true);
    });
  });

  describe("Route Risk Guidance", () => {
    it("adjusts buffer recommendations progressively with route risk", () => {
      const base = {
        strategyId: "route_guidance",
        strategyVolatilityPct: 6,
        withdrawalVelocityPctPerDay: 3,
        protocolHealthScore: 85,
        liquidityDepthUsd: 1_500_000,
        strategyTvlUsd: 1_000_000,
      };

      const lowRisk = recommendLiquidityBuffer({ ...base, routeRisk: "low" });
      const medRisk = recommendLiquidityBuffer({ ...base, routeRisk: "medium" });
      const highRisk = recommendLiquidityBuffer({ ...base, routeRisk: "high" });

      expect(lowRisk.routeRiskLevel).toBe("low");
      expect(medRisk.routeRiskLevel).toBe("medium");
      expect(highRisk.routeRiskLevel).toBe("high");

      expect(medRisk.recommendedBufferPct).toBeGreaterThan(lowRisk.recommendedBufferPct);
      expect(highRisk.recommendedBufferPct).toBeGreaterThan(medRisk.recommendedBufferPct);
      expect(highRisk.safeExecutionSizeUsd).toBeLessThan(lowRisk.safeExecutionSizeUsd);
    });

    it("surfaces route risk and execution sizing in rationale", () => {
      const rec = recommendLiquidityBuffer({
        strategyId: "route_rationale",
        strategyVolatilityPct: 10,
        withdrawalVelocityPctPerDay: 5,
        protocolHealthScore: 70,
        liquidityDepthUsd: 800_000,
        strategyTvlUsd: 1_000_000,
        routeRiskScore: 75,
      });

      expect(rec.routeRiskLevel).toBe("high");
      expect(rec.routeRiskScore).toBe(75);
      expect(rec.rationale.some((r) => r.includes("Route risk (high, score: 75)"))).toBe(true);
    });
  });

  describe("Pre-Execution Visibility & Multi-Path Batching", () => {
    it("computes buffer recommendations for multiple routes across liquidity bands", () => {
      const results = recommendLiquidityBuffers([
        {
          strategyId: "path_a",
          strategyVolatilityPct: 5,
          withdrawalVelocityPctPerDay: 2,
          protocolHealthScore: 90,
          liquidityDepthUsd: 3_000_000,
          strategyTvlUsd: 1_000_000,
          routeRisk: "low",
        },
        {
          strategyId: "path_b",
          strategyVolatilityPct: 15,
          withdrawalVelocityPctPerDay: 10,
          protocolHealthScore: 55,
          liquidityDepthUsd: 150_000,
          strategyTvlUsd: 1_000_000,
          routeRisk: "high",
        },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].liquidityBand).toBe("deep");
      expect(results[0].routeRiskLevel).toBe("low");
      expect(results[1].liquidityBand).toBe("thin");
      expect(results[1].routeRiskLevel).toBe("high");
      expect(results[1].recommendedBufferPct).toBeGreaterThan(results[0].recommendedBufferPct);
    });
  });
});
