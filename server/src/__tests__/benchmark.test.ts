import {
  BenchmarkEngine,
  benchmarkEngine,
  formatBenchmarkResult,
  getBenchmarkSummary,
  AssetProfile,
} from "../services/benchmarkService";

describe("BenchmarkEngine", () => {
  let engine: BenchmarkEngine;

  beforeEach(() => {
    engine = new BenchmarkEngine();
    engine.clearCache();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("definePassiveBaseline", () => {
    it("should create a passive hold baseline for stablecoin", async () => {
      const baseline = await engine.definePassiveBaseline(
        "USDC",
        "USD Coin",
        "stablecoin",
        90,
      );

      expect(baseline).toBeDefined();
      expect(baseline.assetId).toBe("USDC");
      expect(baseline.assetName).toBe("USD Coin");
      expect(baseline.profile).toBe("stablecoin");
      expect(baseline.startPrice).toBeGreaterThan(0);
      expect(baseline.endPrice).toBeGreaterThan(0);
      expect(baseline.passiveReturn).toBeDefined();
      expect(baseline.annualizedReturn).toBeDefined();
      expect(baseline.volatility).toBeGreaterThanOrEqual(0);
      expect(baseline.periodStart).toBeDefined();
      expect(baseline.periodEnd).toBeDefined();
      expect(baseline.dataSource).toBe("historical_price_feed");
    });

    it("should create baseline for blue-chip asset", async () => {
      const baseline = await engine.definePassiveBaseline(
        "BTC",
        "Bitcoin",
        "blue-chip",
        180,
      );

      expect(baseline).toBeDefined();
      expect(baseline.assetId).toBe("BTC");
      expect(baseline.profile).toBe("blue-chip");
      expect(baseline.startPrice).toBeGreaterThan(10000); // BTC base price ~45000
    });

    it("should calculate correct passive return", async () => {
      const baseline = await engine.definePassiveBaseline(
        "ETH",
        "Ethereum",
        "blue-chip",
        90,
      );

      const expectedReturn =
        ((baseline.endPrice - baseline.startPrice) / baseline.startPrice) * 100;
      expect(baseline.passiveReturn).toBeCloseTo(expectedReturn, 2);
    });

    it("should use default period when not specified", async () => {
      const baseline = await engine.definePassiveBaseline(
        "USDC",
        "USD Coin",
        "stablecoin",
      );

      expect(baseline).toBeDefined();
      const periodDays =
        (new Date(baseline.periodEnd).getTime() -
          new Date(baseline.periodStart).getTime()) /
        (24 * 60 * 60 * 1000);
      expect(periodDays).toBeCloseTo(90, 0); // Default is 90 days
    });

    it("should throw error when service is frozen", async () => {
      const mockFreezeService = require("../services/freezeService");
      jest.spyOn(mockFreezeService.freezeService, "isFrozen").mockReturnValue(true);

      await expect(
        engine.definePassiveBaseline("USDC", "USD Coin", "stablecoin"),
      ).rejects.toThrow("Benchmark service is frozen");

      mockFreezeService.freezeService.isFrozen.mockRestore();
    });
  });

  describe("compareAgainstPassive", () => {
    it("should calculate correct return delta", async () => {
      const baseline = await engine.definePassiveBaseline(
        "USDC",
        "USD Coin",
        "stablecoin",
        90,
      );

      const strategyOutcome = {
        strategyId: "strat_1",
        strategyName: "Test Strategy",
        realizedReturn: 8.5,
        annualizedReturn: 35.0,
        volatility: 0.05,
        periodStart: baseline.periodStart,
        periodEnd: baseline.periodEnd,
        dataType: "realized" as const,
      };

      const result = await engine.compareAgainstPassive(
        strategyOutcome,
        baseline,
      );

      const expectedDelta = strategyOutcome.realizedReturn - baseline.passiveReturn;
      expect(result.delta.returnDelta).toBeCloseTo(expectedDelta, 2);
    });

    it("should correctly identify outperformance", async () => {
      const baseline = await engine.definePassiveBaseline(
        "USDC",
        "USD Coin",
        "stablecoin",
        90,
      );

      // Strategy with high return
      const strategyOutcome = {
        strategyId: "strat_1",
        strategyName: "Test Strategy",
        realizedReturn: 10.0,
        annualizedReturn: 40.0,
        volatility: 0.10,
        periodStart: baseline.periodStart,
        periodEnd: baseline.periodEnd,
        dataType: "realized" as const,
      };

      const result = await engine.compareAgainstPassive(
        strategyOutcome,
        baseline,
      );

      expect(result.delta.outperformed).toBe(true);
    });

    it("should correctly identify underperformance", async () => {
      const baseline = await engine.definePassiveBaseline(
        "BTC",
        "Bitcoin",
        "blue-chip",
        90,
      );

      // Strategy with low return
      const strategyOutcome = {
        strategyId: "strat_2",
        strategyName: "Poor Strategy",
        realizedReturn: -5.0,
        annualizedReturn: -20.0,
        volatility: 0.20,
        periodStart: baseline.periodStart,
        periodEnd: baseline.periodEnd,
        dataType: "realized" as const,
      };

      const result = await engine.compareAgainstPassive(
        strategyOutcome,
        baseline,
      );

      expect(result.delta.outperformed).toBe(false);
    });

    it("should calculate Sharpe ratio delta", async () => {
      const baseline = await engine.definePassiveBaseline(
        "USDC",
        "USD Coin",
        "stablecoin",
        90,
      );

      const strategyOutcome = {
        strategyId: "strat_1",
        strategyName: "Test Strategy",
        realizedReturn: 8.5,
        annualizedReturn: 35.0,
        volatility: 0.05,
        periodStart: baseline.periodStart,
        periodEnd: baseline.periodEnd,
        dataType: "realized" as const,
      };

      const result = await engine.compareAgainstPassive(
        strategyOutcome,
        baseline,
      );

      expect(result.delta.sharpeDelta).toBeDefined();
      expect(typeof result.delta.sharpeDelta).toBe("number");
    });

    it("should include disclaimer in delta", async () => {
      const baseline = await engine.definePassiveBaseline(
        "USDC",
        "USD Coin",
        "stablecoin",
        90,
      );

      const strategyOutcome = {
        strategyId: "strat_1",
        strategyName: "Test Strategy",
        realizedReturn: 8.5,
        annualizedReturn: 35.0,
        volatility: 0.05,
        periodStart: baseline.periodStart,
        periodEnd: baseline.periodEnd,
        dataType: "realized" as const,
      };

      const result = await engine.compareAgainstPassive(
        strategyOutcome,
        baseline,
      );

      expect(result.delta.disclaimer).toContain("comparative analytics");
      expect(result.delta.disclaimer).toContain("guarantee");
    });

    it("should include methodology in result", async () => {
      const baseline = await engine.definePassiveBaseline(
        "USDC",
        "USD Coin",
        "stablecoin",
        90,
      );

      const strategyOutcome = {
        strategyId: "strat_1",
        strategyName: "Test Strategy",
        realizedReturn: 8.5,
        annualizedReturn: 35.0,
        volatility: 0.05,
        periodStart: baseline.periodStart,
        periodEnd: baseline.periodEnd,
        dataType: "realized" as const,
      };

      const result = await engine.compareAgainstPassive(
        strategyOutcome,
        baseline,
      );

      expect(result.methodology).toBeDefined();
      expect(result.methodology).toContain("Passive hold baselines");
    });
  });

  describe("computeBenchmark", () => {
    it("should compute full benchmark for a strategy", async () => {
      const result = await engine.computeBenchmark(
        "strat_1",
        "Yield Strategy",
        "USDC",
        "USD Coin",
        "stablecoin",
        8.5,
        0.05,
        90,
        "realized",
      );

      expect(result).toBeDefined();
      expect(result.strategyOutcome.strategyId).toBe("strat_1");
      expect(result.passiveBaseline.assetId).toBe("USDC");
      expect(result.delta).toBeDefined();
      expect(result.computedAt).toBeDefined();
    });

    it("should use default period when not specified", async () => {
      const result = await engine.computeBenchmark(
        "strat_1",
        "Yield Strategy",
        "USDC",
        "USD Coin",
        "stablecoin",
        8.5,
        0.05,
      );

      expect(result).toBeDefined();
    });

    it("should cache results", async () => {
      const result1 = await engine.computeBenchmark(
        "strat_1",
        "Yield Strategy",
        "USDC",
        "USD Coin",
        "stablecoin",
        8.5,
        0.05,
        90,
      );

      const result2 = await engine.computeBenchmark(
        "strat_1",
        "Yield Strategy",
        "USDC",
        "USD Coin",
        "stablecoin",
        8.5,
        0.05,
        90,
      );

      expect(result1.computedAt).toBe(result2.computedAt);
    });

    it("should handle projected data type", async () => {
      const result = await engine.computeBenchmark(
        "strat_1",
        "Yield Strategy",
        "USDC",
        "USD Coin",
        "stablecoin",
        8.5,
        0.05,
        90,
        "projected",
      );

      expect(result.strategyOutcome.dataType).toBe("projected");
      expect(result.delta.confidenceLevel).toBeLessThan(0.8); // Reduced for projected
    });
  });

  describe("batchComputeBenchmarks", () => {
    it("should compute benchmarks for multiple strategies", async () => {
      const strategies = [
        {
          strategyId: "strat_1",
          strategyName: "Strategy 1",
          assetId: "USDC",
          assetName: "USD Coin",
          profile: "stablecoin" as AssetProfile,
          strategyReturn: 8.5,
          strategyVolatility: 0.05,
        },
        {
          strategyId: "strat_2",
          strategyName: "Strategy 2",
          assetId: "BTC",
          assetName: "Bitcoin",
          profile: "blue-chip" as AssetProfile,
          strategyReturn: 15.0,
          strategyVolatility: 0.15,
        },
      ];

      const results = await engine.batchComputeBenchmarks(strategies, 90);

      expect(results).toHaveLength(2);
      expect(results[0].strategyOutcome.strategyId).toBe("strat_1");
      expect(results[1].strategyOutcome.strategyId).toBe("strat_2");
    });

    it("should handle empty strategy list", async () => {
      const results = await engine.batchComputeBenchmarks([], 90);
      expect(results).toHaveLength(0);
    });
  });

  describe("magnitude classification", () => {
    it("should classify significant outperformance", async () => {
      const baseline = await engine.definePassiveBaseline(
        "USDC",
        "USD Coin",
        "stablecoin",
        90,
      );

      const strategyOutcome = {
        strategyId: "strat_1",
        strategyName: "Test Strategy",
        realizedReturn: 10.0, // Much higher than passive
        annualizedReturn: 40.0,
        volatility: 0.10,
        periodStart: baseline.periodStart,
        periodEnd: baseline.periodEnd,
        dataType: "realized" as const,
      };

      const result = await engine.compareAgainstPassive(
        strategyOutcome,
        baseline,
      );

      expect(result.delta.magnitude).toBe("significant_outperformance");
    });

    it("should classify significant underperformance", async () => {
      const baseline = await engine.definePassiveBaseline(
        "BTC",
        "Bitcoin",
        "blue-chip",
        90,
      );

      const strategyOutcome = {
        strategyId: "strat_2",
        strategyName: "Poor Strategy",
        realizedReturn: -10.0, // Much lower
        annualizedReturn: -40.0,
        volatility: 0.30,
        periodStart: baseline.periodStart,
        periodEnd: baseline.periodEnd,
        dataType: "realized" as const,
      };

      const result = await engine.compareAgainstPassive(
        strategyOutcome,
        baseline,
      );

      expect(result.delta.magnitude).toBe("significant_underperformance");
    });
  });

  describe("confidence level calculation", () => {
    it("should reduce confidence for projected data", async () => {
      const baseline = await engine.definePassiveBaseline(
        "USDC",
        "USD Coin",
        "stablecoin",
        90,
      );

      const projectedOutcome = {
        strategyId: "strat_1",
        strategyName: "Test Strategy",
        realizedReturn: 8.5,
        annualizedReturn: 35.0,
        volatility: 0.05,
        periodStart: baseline.periodStart,
        periodEnd: baseline.periodEnd,
        dataType: "projected" as const,
      };

      const realizedOutcome = {
        ...projectedOutcome,
        dataType: "realized" as const,
      };

      const projectedResult = await engine.compareAgainstPassive(
        projectedOutcome,
        baseline,
      );
      const realizedResult = await engine.compareAgainstPassive(
        realizedOutcome,
        baseline,
      );

      expect(projectedResult.delta.confidenceLevel).toBeLessThan(
        realizedResult.delta.confidenceLevel,
      );
    });

    it("should reduce confidence for short periods", async () => {
      const shortBaseline = await engine.definePassiveBaseline(
        "USDC",
        "USD Coin",
        "stablecoin",
        15, // Short period
      );

      const longBaseline = await engine.definePassiveBaseline(
        "USDC",
        "USD Coin",
        "stablecoin",
        120, // Long period
      );

      const strategyOutcome = {
        strategyId: "strat_1",
        strategyName: "Test Strategy",
        realizedReturn: 8.5,
        annualizedReturn: 35.0,
        volatility: 0.05,
        periodStart: shortBaseline.periodStart,
        periodEnd: shortBaseline.periodEnd,
        dataType: "realized" as const,
      };

      const shortResult = await engine.compareAgainstPassive(
        strategyOutcome,
        shortBaseline,
      );
      const longResult = await engine.compareAgainstPassive(
        { ...strategyOutcome, periodStart: longBaseline.periodStart, periodEnd: longBaseline.periodEnd },
        longBaseline,
      );

      expect(shortResult.delta.confidenceLevel).toBeLessThanOrEqual(
        longResult.delta.confidenceLevel,
      );
    });
  });

  describe("configuration", () => {
    it("should update configuration", () => {
      const newConfig = {
        defaultPeriodDays: 180,
        riskFreeRate: 0.03,
      };

      engine.updateConfig(newConfig);
      const config = engine.getConfig();

      expect(config.defaultPeriodDays).toBe(180);
      expect(config.riskFreeRate).toBe(0.03);
    });

    it("should maintain default configuration", () => {
      const defaultEngine = new BenchmarkEngine();
      const config = defaultEngine.getConfig();

      expect(config.defaultPeriodDays).toBe(90);
      expect(config.riskFreeRate).toBe(0.05);
      expect(config.cacheMinutes).toBe(30);
    });
  });

  describe("clearCache", () => {
    it("should clear all cached data", async () => {
      await engine.computeBenchmark(
        "strat_1",
        "Yield Strategy",
        "USDC",
        "USD Coin",
        "stablecoin",
        8.5,
        0.05,
        90,
      );

      engine.clearCache();

      // After clearing, new computation should have different timestamp
      const result = await engine.computeBenchmark(
        "strat_1",
        "Yield Strategy",
        "USDC",
        "USD Coin",
        "stablecoin",
        8.5,
        0.05,
        90,
      );

      expect(result).toBeDefined();
    });
  });
});

describe("formatBenchmarkResult", () => {
  it("should format benchmark result correctly", async () => {
    const engine = new BenchmarkEngine();
    const result = await engine.computeBenchmark(
      "strat_1",
      "Yield Strategy",
      "USDC",
      "USD Coin",
      "stablecoin",
      8.5,
      0.05,
      90,
    );

    const formatted = formatBenchmarkResult(result);

    expect(formatted).toBeDefined();
    expect(formatted.delta.returnDelta).toBeDefined();
    expect(formatted.delta.annualizedDelta).toBeDefined();
    expect(formatted.delta.confidenceLevel).toBeGreaterThanOrEqual(0);
    expect(formatted.delta.confidenceLevel).toBeLessThanOrEqual(1);
  });
});

describe("getBenchmarkSummary", () => {
  it("should return outperforming summary for significant outperformance", async () => {
    const engine = new BenchmarkEngine();
    const result = await engine.computeBenchmark(
      "strat_1",
      "Yield Strategy",
      "USDC",
      "USD Coin",
      "stablecoin",
      10.0,
      0.05,
      90,
    );

    const summary = getBenchmarkSummary(result);

    expect(summary.verdict).toBeDefined();
    expect(summary.color).toBeDefined();
    expect(summary.message).toBeDefined();
  });

  it("should return underperforming summary for significant underperformance", async () => {
    const engine = new BenchmarkEngine();
    const result = await engine.computeBenchmark(
      "strat_2",
      "Poor Strategy",
      "BTC",
      "Bitcoin",
      "blue-chip",
      -10.0,
      0.30,
      90,
    );

    const summary = getBenchmarkSummary(result);

    expect(summary.verdict).toBeDefined();
    expect(summary.color).toBe("red");
  });
});

describe("Singleton instance", () => {
  it("should export benchmarkEngine singleton", () => {
    expect(benchmarkEngine).toBeDefined();
    expect(benchmarkEngine).toBeInstanceOf(BenchmarkEngine);
  });
});
