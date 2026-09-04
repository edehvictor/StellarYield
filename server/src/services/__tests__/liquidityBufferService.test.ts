import {
  recommendLiquidityBuffer,
  recommendLiquidityBuffers,
  classifyLiquidityBand,
  classifyRouteRisk,
} from "../liquidityBufferService";

describe("liquidityBufferService", () => {
  describe("baseline stress classification and compatibility", () => {
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
      expect(rec.liquidityBand).toBe("deep");
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
      expect(rec.liquidityBand).toBe("normal");
      expect(rec.recommendedBufferPct).toBeGreaterThanOrEqual(0.14);
    });

    it("computes stressed buffer and ambiguity guard", () => {
      const rec = recommendLiquidityBuffer({
        strategyId: "s3",
        strategyVolatilityPct: 18,
        withdrawalVelocityPctPerDay: 15,
        protocolHealthScore: 44,
        liquidityDepthUsd: 200_000,
        strategyTvlUsd: 1_000_000,
        ambiguousStressSignal: true,
      });

      expect(rec.stressLevel).toBe("stressed");
      expect(rec.liquidityBand).toBe("thin");
      expect(rec.recommendedBufferPct).toBeGreaterThanOrEqual(0.22);
    });
  });

  describe("liquidity bands: thin, normal, and deep", () => {
    it("handles thin liquidity with elevated buffer and conservative safe route size", () => {
      const rec = recommendLiquidityBuffer({
        strategyId: "thin_route",
        strategyVolatilityPct: 5,
        withdrawalVelocityPctPerDay: 3,
        protocolHealthScore: 85,
        liquidityDepthUsd: 150_000,
        strategyTvlUsd: 1_000_000,
      });

      expect(rec.liquidityBand).toBe("thin");
      expect(rec.recommendedBufferPct).toBeGreaterThan(0.12);
      expect(rec.safeExecutionSizeUsd).toBeLessThanOrEqual(150_000 * 0.05);
      expect(rec.rationale.some((r) => r.includes("thin liquidity band"))).toBe(true);
    });

    it("handles normal liquidity with standard buffer and moderate execution size", () => {
      const rec = recommendLiquidityBuffer({
        strategyId: "normal_route",
        strategyVolatilityPct: 5,
        withdrawalVelocityPctPerDay: 3,
        protocolHealthScore: 85,
        liquidityDepthUsd: 1_000_000,
        strategyTvlUsd: 1_000_000,
      });

      expect(rec.liquidityBand).toBe("normal");
      expect(rec.safeExecutionSizeUsd).toBeGreaterThan(150_000 * 0.05);
      expect(rec.rationale.some((r) => r.includes("normal liquidity band"))).toBe(true);
    });

    it("handles deep liquidity with low slippage penalty and large safe execution capacity", () => {
      const rec = recommendLiquidityBuffer({
        strategyId: "deep_route",
        strategyVolatilityPct: 5,
        withdrawalVelocityPctPerDay: 3,
        protocolHealthScore: 85,
        liquidityDepthUsd: 5_000_000,
        strategyTvlUsd: 1_000_000,
      });

      expect(rec.liquidityBand).toBe("deep");
      expect(rec.safeExecutionSizeUsd).toBeGreaterThan(1_000_000 * 0.08);
      expect(rec.rationale.some((r) => r.includes("deep liquidity band"))).toBe(true);
    });

    it("classifies explicit liquidity band overrides correctly", () => {
      expect(classifyLiquidityBand(100_000, 1_000_000)).toBe("thin");
      expect(classifyLiquidityBand(1_000_000, 1_000_000)).toBe("normal");
      expect(classifyLiquidityBand(3_000_000, 1_000_000)).toBe("deep");
      expect(classifyLiquidityBand(0, 1_000_000)).toBe("thin");
      expect(classifyLiquidityBand(1_000_000, 1_000_000, "deep")).toBe("deep");
    });
  });

  describe("route risk scaling", () => {
    it("increases recommended buffer as route risk increases from low to medium to high", () => {
      const baseInput = {
        strategyId: "route_test",
        strategyVolatilityPct: 5,
        withdrawalVelocityPctPerDay: 3,
        protocolHealthScore: 85,
        liquidityDepthUsd: 1_000_000,
        strategyTvlUsd: 1_000_000,
      };

      const lowRiskRec = recommendLiquidityBuffer({
        ...baseInput,
        routeRisk: "low",
      });

      const medRiskRec = recommendLiquidityBuffer({
        ...baseInput,
        routeRisk: "medium",
      });

      const highRiskRec = recommendLiquidityBuffer({
        ...baseInput,
        routeRisk: "high",
      });

      expect(lowRiskRec.routeRiskLevel).toBe("low");
      expect(medRiskRec.routeRiskLevel).toBe("medium");
      expect(highRiskRec.routeRiskLevel).toBe("high");

      expect(medRiskRec.recommendedBufferPct).toBeGreaterThan(
        lowRiskRec.recommendedBufferPct
      );
      expect(highRiskRec.recommendedBufferPct).toBeGreaterThan(
        medRiskRec.recommendedBufferPct
      );

      // Safe execution sizing should be stricter on high risk routes
      expect(highRiskRec.safeExecutionSizeUsd).toBeLessThan(
        lowRiskRec.safeExecutionSizeUsd
      );
    });

    it("scales buffer using numeric route risk scores and hop counts", () => {
      const directRec = recommendLiquidityBuffer({
        strategyId: "direct",
        strategyVolatilityPct: 4,
        withdrawalVelocityPctPerDay: 2,
        protocolHealthScore: 90,
        liquidityDepthUsd: 2_000_000,
        strategyTvlUsd: 1_000_000,
        hopCount: 1,
      });

      const multiHopRec = recommendLiquidityBuffer({
        strategyId: "multi_hop",
        strategyVolatilityPct: 4,
        withdrawalVelocityPctPerDay: 2,
        protocolHealthScore: 90,
        liquidityDepthUsd: 2_000_000,
        strategyTvlUsd: 1_000_000,
        hopCount: 3,
      });

      expect(directRec.routeRiskLevel).toBe("low");
      expect(multiHopRec.routeRiskLevel).toBe("high");
      expect(multiHopRec.recommendedBufferPct).toBeGreaterThan(
        directRec.recommendedBufferPct
      );
    });

    it("classifies route risk correctly across various formats", () => {
      expect(classifyRouteRisk("low").level).toBe("low");
      expect(classifyRouteRisk("medium").level).toBe("medium");
      expect(classifyRouteRisk("high").level).toBe("high");
      expect(classifyRouteRisk(undefined, 85).level).toBe("high");
      expect(classifyRouteRisk(0.85).level).toBe("high");
      expect(classifyRouteRisk(undefined, undefined, 3).level).toBe("high");
    });
  });

  describe("execution route sizing guidance", () => {
    it("caps maxRecommendedExecutionAmountUsd when target amount exceeds safe size", () => {
      const rec = recommendLiquidityBuffer({
        strategyId: "large_exec",
        strategyVolatilityPct: 5,
        withdrawalVelocityPctPerDay: 2,
        protocolHealthScore: 90,
        liquidityDepthUsd: 500_000,
        strategyTvlUsd: 1_000_000,
        executionAmountUsd: 200_000, // Exceeds safe pool fraction
      });

      expect(rec.maxRecommendedExecutionAmountUsd).toBeLessThan(200_000);
      expect(rec.maxRecommendedExecutionAmountUsd).toBe(rec.safeExecutionSizeUsd);
    });

    it("allows execution amount within safe bounds", () => {
      const rec = recommendLiquidityBuffer({
        strategyId: "small_exec",
        strategyVolatilityPct: 5,
        withdrawalVelocityPctPerDay: 2,
        protocolHealthScore: 90,
        liquidityDepthUsd: 5_000_000,
        strategyTvlUsd: 1_000_000,
        executionAmountUsd: 10_000,
      });

      expect(rec.maxRecommendedExecutionAmountUsd).toBe(10_000);
    });
  });

  describe("batch recommendations", () => {
    it("supports portfolio-wide recommendations with diverse liquidity bands", () => {
      const recs = recommendLiquidityBuffers([
        {
          strategyId: "deep_strat",
          strategyVolatilityPct: 3,
          withdrawalVelocityPctPerDay: 1,
          protocolHealthScore: 95,
          liquidityDepthUsd: 3_000_000,
          strategyTvlUsd: 1_000_000,
          routeRisk: "low",
        },
        {
          strategyId: "thin_strat",
          strategyVolatilityPct: 12,
          withdrawalVelocityPctPerDay: 8,
          protocolHealthScore: 60,
          liquidityDepthUsd: 200_000,
          strategyTvlUsd: 1_000_000,
          routeRisk: "high",
        },
      ]);

      expect(recs).toHaveLength(2);
      expect(recs[0].liquidityBand).toBe("deep");
      expect(recs[1].liquidityBand).toBe("thin");
      expect(recs[1].recommendedBufferPct).toBeGreaterThan(
        recs[0].recommendedBufferPct
      );
    });
  });
});

