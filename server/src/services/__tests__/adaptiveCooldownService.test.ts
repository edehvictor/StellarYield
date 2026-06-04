/**
 * Tests for Issue #362: Adaptive Strategy Cooldown Optimizer
 * Tests for cooldown expansion, contraction, and floor/ceiling behavior.
 */

import {
  AdaptiveCooldownOptimizer,
  DEFAULT_COOLDOWN_CONFIG,
  type StrategyMetrics,
} from "../adaptiveCooldownService";

describe("AdaptiveCooldownOptimizer", () => {
  let optimizer: AdaptiveCooldownOptimizer;

  beforeEach(() => {
    optimizer = new AdaptiveCooldownOptimizer(DEFAULT_COOLDOWN_CONFIG);
  });

  describe("recommendCooldown", () => {
    it("should return baseline cooldown for normal conditions", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Conservative Strategy",
        rebalanceFrequency: 0.1,
        volatility: 30,
        liquidityScore: 80,
        executionSuccessRate: 0.95,
        lastRebalanceAt: new Date(),
        consecutiveFailures: 0,
        averageSlippage: 5,
      };

      const recommendation = optimizer.recommendCooldown(metrics, false);

      expect(recommendation.recommendedCooldownMs).toBe(
        DEFAULT_COOLDOWN_CONFIG.baselineCooldownMs,
      );
      expect(recommendation.reason).toContain("Normal market conditions");
    });

    it("should expand cooldown for high volatility", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Strategy High Vol",
        rebalanceFrequency: 0.1,
        volatility: 80, // High volatility
        liquidityScore: 80,
        executionSuccessRate: 0.95,
        lastRebalanceAt: new Date(),
        consecutiveFailures: 0,
        averageSlippage: 5,
      };

      const recommendation = optimizer.recommendCooldown(metrics, false);

      expect(recommendation.recommendedCooldownMs).toBeGreaterThan(
        DEFAULT_COOLDOWN_CONFIG.baselineCooldownMs,
      );
      expect(recommendation.reason).toContain("high volatility");
    });

    it("should expand cooldown for low liquidity", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Strategy Low Liq",
        rebalanceFrequency: 0.1,
        volatility: 30,
        liquidityScore: 20, // Low liquidity
        executionSuccessRate: 0.95,
        lastRebalanceAt: new Date(),
        consecutiveFailures: 0,
        averageSlippage: 5,
      };

      const recommendation = optimizer.recommendCooldown(metrics, false);

      expect(recommendation.recommendedCooldownMs).toBeGreaterThan(
        DEFAULT_COOLDOWN_CONFIG.baselineCooldownMs,
      );
      expect(recommendation.reason).toContain("low liquidity");
    });

    it("should expand cooldown for consecutive failures", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Strategy Failures",
        rebalanceFrequency: 0.1,
        volatility: 30,
        liquidityScore: 80,
        executionSuccessRate: 0.5,
        lastRebalanceAt: new Date(),
        consecutiveFailures: 3,
        averageSlippage: 5,
      };

      const recommendation = optimizer.recommendCooldown(metrics, false);

      expect(recommendation.recommendedCooldownMs).toBeGreaterThan(
        DEFAULT_COOLDOWN_CONFIG.baselineCooldownMs,
      );
      expect(recommendation.reason).toContain("consecutive failures");
    });

    it("should apply market stress multiplier", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Strategy Normal",
        rebalanceFrequency: 0.1,
        volatility: 30,
        liquidityScore: 80,
        executionSuccessRate: 0.95,
        lastRebalanceAt: new Date(),
        consecutiveFailures: 0,
        averageSlippage: 5,
      };

      const normalRecommendation = optimizer.recommendCooldown(metrics, false);
      const stressRecommendation = optimizer.recommendCooldown(metrics, true);

      expect(stressRecommendation.recommendedCooldownMs).toBeGreaterThan(
        normalRecommendation.recommendedCooldownMs,
      );
    });

    it("should respect minimum cooldown floor", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Strategy Floor Test",
        rebalanceFrequency: 0.1,
        volatility: 10, // Low volatility
        liquidityScore: 95, // High liquidity
        executionSuccessRate: 1.0, // Perfect execution
        lastRebalanceAt: new Date(),
        consecutiveFailures: 0,
        averageSlippage: 0,
      };

      const recommendation = optimizer.recommendCooldown(metrics, false);

      expect(recommendation.recommendedCooldownMs).toBeGreaterThanOrEqual(
        DEFAULT_COOLDOWN_CONFIG.minCooldownMs,
      );
    });

    it("should respect maximum cooldown ceiling", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Strategy Ceiling Test",
        rebalanceFrequency: 10, // Very high frequency
        volatility: 95, // Extreme volatility
        liquidityScore: 5, // Extreme illiquidity
        executionSuccessRate: 0.0, // All failures
        lastRebalanceAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Long ago
        consecutiveFailures: 10,
        averageSlippage: 100,
      };

      const recommendation = optimizer.recommendCooldown(metrics, true);

      expect(recommendation.recommendedCooldownMs).toBeLessThanOrEqual(
        DEFAULT_COOLDOWN_CONFIG.maxCooldownMs,
      );
    });

    it("should provide detailed expansion factors", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Strategy Factors",
        rebalanceFrequency: 0.1,
        volatility: 70,
        liquidityScore: 30,
        executionSuccessRate: 0.7,
        lastRebalanceAt: new Date(),
        consecutiveFailures: 2,
        averageSlippage: 15,
      };

      const recommendation = optimizer.recommendCooldown(metrics, false);

      expect(recommendation.factors).toBeDefined();
      expect(recommendation.factors.volatilityFactor).toBeGreaterThan(0);
      expect(recommendation.factors.liquidityFactor).toBeGreaterThan(0);
      expect(recommendation.factors.failuresFactor).toBeGreaterThan(0);
      expect(recommendation.totalMultiplier).toBeGreaterThan(0);
    });

    it("should calculate confidence score", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Strategy Confidence",
        rebalanceFrequency: 0.1,
        volatility: 30,
        liquidityScore: 80,
        executionSuccessRate: 0.95,
        lastRebalanceAt: new Date(),
        consecutiveFailures: 0,
        averageSlippage: 5,
      };

      const recommendation = optimizer.recommendCooldown(metrics, false);

      expect(recommendation.confidence).toBeGreaterThan(0);
      expect(recommendation.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe("shouldExpandCooldown", () => {
    it("should detect expansion needed for poor conditions", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Strategy Expand",
        rebalanceFrequency: 0.1,
        volatility: 85,
        liquidityScore: 15,
        executionSuccessRate: 0.5,
        lastRebalanceAt: new Date(),
        consecutiveFailures: 3,
        averageSlippage: 20,
      };

      const shouldExpand = optimizer.shouldExpandCooldown(metrics, false);

      expect(shouldExpand).toBe(true);
    });

    it("should not expand for good conditions", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Strategy Good",
        rebalanceFrequency: 0.1,
        volatility: 20,
        liquidityScore: 90,
        executionSuccessRate: 0.98,
        lastRebalanceAt: new Date(),
        consecutiveFailures: 0,
        averageSlippage: 2,
      };

      const shouldExpand = optimizer.shouldExpandCooldown(metrics, false);

      expect(shouldExpand).toBe(false);
    });
  });

  describe("shouldContractCooldown", () => {
    it("should detect contraction possible for excellent conditions", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_1",
        strategyName: "Strategy Excellent",
        rebalanceFrequency: 0.1,
        volatility: 10,
        liquidityScore: 95,
        executionSuccessRate: 0.99,
        lastRebalanceAt: new Date(),
        consecutiveFailures: 0,
        averageSlippage: 1,
      };

      const shouldContract = optimizer.shouldContractCooldown(metrics, false);

      expect(shouldContract).toBe(true);
    });
  });

  describe("recommendCooldownsBatch", () => {
    it("should batch recommend for multiple strategies", () => {
      const metrics: StrategyMetrics[] = [
        {
          strategyId: "strat_1",
          strategyName: "Strategy 1",
          rebalanceFrequency: 0.1,
          volatility: 30,
          liquidityScore: 80,
          executionSuccessRate: 0.95,
          lastRebalanceAt: new Date(),
          consecutiveFailures: 0,
          averageSlippage: 5,
        },
        {
          strategyId: "strat_2",
          strategyName: "Strategy 2",
          rebalanceFrequency: 0.1,
          volatility: 70,
          liquidityScore: 40,
          executionSuccessRate: 0.7,
          lastRebalanceAt: new Date(),
          consecutiveFailures: 2,
          averageSlippage: 10,
        },
      ];

      const recommendations = optimizer.recommendCooldownsBatch(
        metrics,
        false,
      );

      expect(recommendations).toHaveLength(2);
      expect(recommendations[0].recommendedCooldownMs).toBeLessThan(
        recommendations[1].recommendedCooldownMs,
      );
    });
  });

  describe("formatDuration", () => {
    it("should format milliseconds to human-readable duration", () => {
      expect(AdaptiveCooldownOptimizer.formatDuration(3600000)).toBe("1h");
      expect(AdaptiveCooldownOptimizer.formatDuration(86400000)).toBe("1d 0h");
      expect(AdaptiveCooldownOptimizer.formatDuration(90000000)).toBe("1d 1h");
    });
  });
});
