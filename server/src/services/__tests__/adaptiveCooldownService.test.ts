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

  describe("Determinism & Input Normalization", () => {
    const {
      normalizeStrategyMetrics,
      saveCooldownRecommendation,
      getLatestCooldownRecommendation,
      getCooldownRecommendationHistory,
      resetCooldownRecommendationStore,
      COOLDOWN_REASON_DESCRIPTIONS,
    } = require("../adaptiveCooldownService");

    beforeEach(() => {
      resetCooldownRecommendationStore();
    });

    it("should produce identical recommendation output across 100 repeated executions", () => {
      const metrics: StrategyMetrics = {
        strategyId: "strat_deterministic",
        strategyName: "Deterministic Strategy",
        rebalanceFrequency: 0.25,
        volatility: 65,
        liquidityScore: 35,
        executionSuccessRate: 0.88,
        lastRebalanceAt: new Date("2026-08-01T00:00:00Z"),
        consecutiveFailures: 2,
        averageSlippage: 8.5,
      };

      const baseline = optimizer.recommendCooldown(metrics, true);

      for (let i = 0; i < 100; i++) {
        const current = optimizer.recommendCooldown(metrics, true);
        expect(current.recommendedCooldownMs).toBe(baseline.recommendedCooldownMs);
        expect(current.primaryReasonCode).toBe(baseline.primaryReasonCode);
        expect(current.reasonCodes).toEqual(baseline.reasonCodes);
        expect(current.totalMultiplier).toBe(baseline.totalMultiplier);
        expect(current.confidence).toBe(baseline.confidence);
        expect(current.factors).toEqual(baseline.factors);
      }
    });

    it("should normalize floating point jitter in metrics", () => {
      const cleanMetrics: Partial<StrategyMetrics> = {
        strategyId: "strat_jitter",
        volatility: 70.0,
        liquidityScore: 30.0,
        executionSuccessRate: 0.90,
      };

      const jitteryMetrics: Partial<StrategyMetrics> = {
        strategyId: "strat_jitter",
        volatility: 70.00000000000001,
        liquidityScore: 30.00000000000002,
        executionSuccessRate: 0.9000000000000001,
      };

      const cleanRec = optimizer.recommendCooldown(cleanMetrics);
      const jitteryRec = optimizer.recommendCooldown(jitteryMetrics);

      expect(jitteryRec.recommendedCooldownMs).toBe(cleanRec.recommendedCooldownMs);
      expect(jitteryRec.primaryReasonCode).toBe(cleanRec.primaryReasonCode);
      expect(jitteryRec.reasonCodes).toEqual(cleanRec.reasonCodes);
      expect(jitteryRec.totalMultiplier).toBe(cleanRec.totalMultiplier);
    });

    it("should clamp out-of-bounds metrics safely", () => {
      const outOfBounds: Partial<StrategyMetrics> = {
        volatility: 250,
        liquidityScore: -50,
        executionSuccessRate: 5.0,
        consecutiveFailures: -3,
        averageSlippage: -10,
      };

      const normalized = normalizeStrategyMetrics(outOfBounds);
      expect(normalized.volatility).toBe(100);
      expect(normalized.liquidityScore).toBe(0);
      expect(normalized.executionSuccessRate).toBe(1);
      expect(normalized.consecutiveFailures).toBe(0);
      expect(normalized.averageSlippage).toBe(0);
    });

    it("should assign and describe all reason codes properly", () => {
      const stressedMetrics: Partial<StrategyMetrics> = {
        volatility: 85,
        liquidityScore: 20,
        consecutiveFailures: 4,
        executionSuccessRate: 0.70,
        averageSlippage: 15,
      };

      const rec = optimizer.recommendCooldown(stressedMetrics, true);

      expect(rec.reasonCodes).toContain("HIGH_VOLATILITY");
      expect(rec.reasonCodes).toContain("LOW_LIQUIDITY");
      expect(rec.reasonCodes).toContain("CONSECUTIVE_FAILURES");
      expect(rec.reasonCodes).toContain("LOW_EXECUTION_SUCCESS");
      expect(rec.reasonCodes).toContain("HIGH_SLIPPAGE");
      expect(rec.reasonCodes).toContain("MARKET_STRESS");

      for (const code of rec.reasonCodes) {
        expect(COOLDOWN_REASON_DESCRIPTIONS[code]).toBeDefined();
      }
    });

    it("should persist cooldown recommendation and allow retrieval", () => {
      const metrics: Partial<StrategyMetrics> = {
        strategyId: "strat_persist_test",
        volatility: 45,
      };

      const rec = optimizer.recommendCooldown(metrics);
      const retrieved = getLatestCooldownRecommendation("strat_persist_test");

      expect(retrieved).toBeDefined();
      expect(retrieved?.recommendedCooldownMs).toBe(rec.recommendedCooldownMs);
      expect(retrieved?.primaryReasonCode).toBe(rec.primaryReasonCode);

      const history = getCooldownRecommendationHistory("strat_persist_test");
      expect(history.length).toBeGreaterThanOrEqual(1);
    });
  });
});

