/**
 * Strategy Outcome Benchmarking Against Passive Hold (#390)
 *
 * Benchmarks active strategy outcomes against passive hold baselines so users
 * can understand whether active complexity is earning its keep.
 *
 * IMPORTANT: Benchmark outputs are comparative analytics only and must NOT be
 * presented as guaranteed future outperformance.
 */

import NodeCache from "node-cache";
import { freezeService } from "./freezeService";

// ── Types ───────────────────────────────────────────────────────────────

export type AssetProfile = "stablecoin" | "blue-chip" | "defi-token" | "volatile" | "custom";

export interface PassiveHoldBaseline {
  assetId: string;
  assetName: string;
  profile: AssetProfile;
  /** Starting price at benchmark period start (USD) */
  startPrice: number;
  /** Ending price at benchmark period end (USD) */
  endPrice: number;
  /** Passive hold return percentage (e.g., 5.2 = 5.2%) */
  passiveReturn: number;
  /** Annualized passive return percentage */
  annualizedReturn: number;
  /** Volatility (standard deviation of returns) */
  volatility: number;
  /** Period start timestamp */
  periodStart: string;
  /** Period end timestamp */
  periodEnd: string;
  /** Data source for baseline calculation */
  dataSource: string;
}

export interface StrategyOutcome {
  strategyId: string;
  strategyName: string;
  /** Realized or projected return percentage */
  realizedReturn: number;
  /** Annualized return percentage */
  annualizedReturn: number;
  /** Strategy volatility */
  volatility: number;
  /** Sharpe ratio (risk-adjusted return) */
  sharpeRatio?: number;
  /** Period start timestamp */
  periodStart: string;
  /** Period end timestamp */
  periodEnd: string;
  /** Whether this is projected or realized data */
  dataType: "realized" | "projected";
}

export interface BenchmarkDelta {
  strategyId: string;
  strategyName: string;
  assetId: string;
  assetName: string;
  /** Strategy return minus passive return (percentage points) */
  returnDelta: number;
  /** Strategy annualized minus passive annualized */
  annualizedDelta: number;
  /** Volatility difference (strategy - passive) */
  volatilityDelta: number;
  /** Whether strategy outperformed passive hold */
  outperformed: boolean;
  /** Outperformance magnitude classification */
  magnitude: "significant_outperformance" | "marginal_outperformance" | "underperformance" | "significant_underperformance";
  /** Risk-adjusted comparison (Sharpe difference) */
  sharpeDelta?: number;
  /** Confidence level in the benchmark comparison */
  confidenceLevel: number; // 0-1
  /** Disclaimer that this is comparative analytics, not guarantees */
  disclaimer: string;
}

export interface BenchmarkResult {
  strategyOutcome: StrategyOutcome;
  passiveBaseline: PassiveHoldBaseline;
  delta: BenchmarkDelta;
  /** Additional context and methodology notes */
  methodology: string;
  /** Timestamp when benchmark was computed */
  computedAt: string;
}

export interface BenchmarkConfig {
  /** Default benchmark period in days */
  defaultPeriodDays: number;
  /** Risk-free rate for Sharpe ratio calculation (annualized) */
  riskFreeRate: number;
  /** Threshold for significant outperformance (percentage points) */
  significantOutperformanceThreshold: number;
  /** Threshold for significant underperformance (percentage points) */
  negativeSignificantThreshold: number;
  /** Cache results for this many minutes */
  cacheMinutes: number;
}

// ── Configuration ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: BenchmarkConfig = {
  defaultPeriodDays: 90,
  riskFreeRate: 0.05, // 5% annual risk-free rate
  significantOutperformanceThreshold: 2.0, // 2 percentage points
  negativeSignificantThreshold: -2.0,
  cacheMinutes: 30,
};

const DISCLAIMER = "Benchmark comparisons are for analytical purposes only and do not guarantee future performance. Past performance does not indicate future results.";

const METHODOLOGY = "Passive hold baselines assume buying and holding the underlying asset for the entire benchmark period without any active management. Strategy outcomes reflect active management returns. All returns are calculated net of fees where applicable.";

// Default volatility assumptions by asset profile (annualized)
const PROFILE_VOLATILITY_ASSUMPTIONS: Record<AssetProfile, number> = {
  stablecoin: 0.02,    // 2% annual volatility
  "blue-chip": 0.15,   // 15% annual volatility
  "defi-token": 0.35,  // 35% annual volatility
  volatile: 0.50,      // 50% annual volatility
  custom: 0.25,        // 25% default for custom
};

const cache = new NodeCache({
  stdTTL: DEFAULT_CONFIG.cacheMinutes * 60,
  checkperiod: 60,
  useClones: false,
});

// ── Benchmark Engine ────────────────────────────────────────────────────

export class BenchmarkEngine {
  private config: BenchmarkConfig;
  private historicalPriceData: Map<string, number[]>;

  constructor(config: Partial<BenchmarkConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.historicalPriceData = new Map();
  }

  /**
   * Define passive hold baseline for an asset profile
   */
  async definePassiveBaseline(
    assetId: string,
    assetName: string,
    profile: AssetProfile,
    periodDays?: number,
  ): Promise<PassiveHoldBaseline> {
    if (freezeService.isFrozen()) {
      throw new Error("Benchmark service is frozen");
    }

    const days = periodDays || this.config.defaultPeriodDays;
    const periodStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const periodEnd = new Date();

    // Fetch or simulate price data
    const priceData = await this.fetchPriceHistory(assetId, days);
    
    const startPrice = priceData[0];
    const endPrice = priceData[priceData.length - 1];

    // Calculate passive return
    const passiveReturn = ((endPrice - startPrice) / startPrice) * 100;
    
    // Annualize return
    const annualizedReturn = this.annualizeReturn(passiveReturn, days);
    
    // Calculate volatility from price data
    const volatility = this.calculateVolatility(priceData);

    return {
      assetId,
      assetName,
      profile,
      startPrice,
      endPrice,
      passiveReturn: Math.round(passiveReturn * 100) / 100,
      annualizedReturn: Math.round(annualizedReturn * 100) / 100,
      volatility: Math.round(volatility * 10000) / 10000,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      dataSource: "historical_price_feed",
    };
  }

  /**
   * Compare strategy outcome against passive hold baseline
   */
  async compareAgainstPassive(
    strategyOutcome: StrategyOutcome,
    baseline: PassiveHoldBaseline,
  ): Promise<BenchmarkResult> {
    const returnDelta = strategyOutcome.realizedReturn - baseline.passiveReturn;
    const annualizedDelta = strategyOutcome.annualizedReturn - baseline.annualizedReturn;
    const volatilityDelta = strategyOutcome.volatility - baseline.volatility;

    // Calculate Sharpe ratios
    const strategySharpe = this.calculateSharpeRatio(strategyOutcome.annualizedReturn, strategyOutcome.volatility);
    const passiveSharpe = this.calculateSharpeRatio(baseline.annualizedReturn, baseline.volatility);
    const sharpeDelta = strategySharpe - passiveSharpe;

    const outperformed = returnDelta > 0;
    const magnitude = this.classifyMagnitude(returnDelta);

    // Calculate confidence based on data quality and period length
    const confidenceLevel = this.calculateConfidenceLevel(
      strategyOutcome,
      baseline,
    );

    const delta: BenchmarkDelta = {
      strategyId: strategyOutcome.strategyId,
      strategyName: strategyOutcome.strategyName,
      assetId: baseline.assetId,
      assetName: baseline.assetName,
      returnDelta: Math.round(returnDelta * 100) / 100,
      annualizedDelta: Math.round(annualizedDelta * 100) / 100,
      volatilityDelta: Math.round(volatilityDelta * 10000) / 10000,
      outperformed,
      magnitude,
      sharpeDelta: Math.round(sharpeDelta * 1000) / 1000,
      confidenceLevel: Math.round(confidenceLevel * 1000) / 1000,
      disclaimer: DISCLAIMER,
    };

    return {
      strategyOutcome,
      passiveBaseline: baseline,
      delta,
      methodology: METHODOLOGY,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Compute full benchmark for a strategy against its underlying asset
   */
  async computeBenchmark(
    strategyId: string,
    strategyName: string,
    assetId: string,
    assetName: string,
    profile: AssetProfile,
    strategyReturn: number,
    strategyVolatility: number,
    periodDays?: number,
    dataType: "realized" | "projected" = "realized",
  ): Promise<BenchmarkResult> {
    const cacheKey = `benchmark:${strategyId}:${assetId}:${periodDays || this.config.defaultPeriodDays}`;
    const cached = cache.get<BenchmarkResult>(cacheKey);
    
    if (cached) {
      return cached;
    }

    const days = periodDays || this.config.defaultPeriodDays;
    
    // Generate passive baseline
    const baseline = await this.definePassiveBaseline(assetId, assetName, profile, days);
    
    // Calculate strategy annualized return
    const strategyAnnualized = this.annualizeReturn(strategyReturn, days);

    const strategyOutcome: StrategyOutcome = {
      strategyId,
      strategyName,
      realizedReturn: strategyReturn,
      annualizedReturn: Math.round(strategyAnnualized * 100) / 100,
      volatility: strategyVolatility,
      sharpeRatio: this.calculateSharpeRatio(strategyAnnualized, strategyVolatility),
      periodStart: baseline.periodStart,
      periodEnd: baseline.periodEnd,
      dataType,
    };

    const result = await this.compareAgainstPassive(strategyOutcome, baseline);
    
    cache.set(cacheKey, result);
    
    return result;
  }

  /**
   * Batch compute benchmarks for multiple strategies
   */
  async batchComputeBenchmarks(
    strategies: Array<{
      strategyId: string;
      strategyName: string;
      assetId: string;
      assetName: string;
      profile: AssetProfile;
      strategyReturn: number;
      strategyVolatility: number;
    }>,
    periodDays?: number,
  ): Promise<BenchmarkResult[]> {
    const promises = strategies.map(s =>
      this.computeBenchmark(
        s.strategyId,
        s.strategyName,
        s.assetId,
        s.assetName,
        s.profile,
        s.strategyReturn,
        s.strategyVolatility,
        periodDays,
      ),
    );
    
    return Promise.all(promises);
  }

  // ── Private Helper Methods ──────────────────────────────────────────────

  /**
   * Fetch historical price data (mock implementation - would integrate with price feeds)
   */
  private async fetchPriceHistory(assetId: string, days: number): Promise<number[]> {
    // Check cache first
    const cacheKey = `prices:${assetId}:${days}`;
    const cached = this.historicalPriceData.get(cacheKey);
    if (cached) return cached;

    // Mock price data generation based on asset profile
    // In production, this would fetch from actual price APIs
    const profile = this.inferAssetProfile(assetId);
    const volatility = PROFILE_VOLATILITY_ASSUMPTIONS[profile];
    
    // Generate realistic price series with geometric Brownian motion
    const prices: number[] = [];
    let price = this.getBasePrice(assetId);
    const dailyVol = volatility / Math.sqrt(365);
    const drift = 0.0001; // Small positive drift

    for (let i = 0; i <= days; i++) {
      prices.push(price);
      // Random walk with drift
      const shock = this.gaussianRandom() * dailyVol;
      price = price * Math.exp(drift + shock);
    }

    this.historicalPriceData.set(cacheKey, prices);
    return prices;
  }

  /**
   * Infer asset profile from asset ID
   */
  private inferAssetProfile(assetId: string): AssetProfile {
    const lowerId = assetId.toLowerCase();
    if (lowerId.includes("usdc") || lowerId.includes("usdt") || lowerId.includes("dai")) {
      return "stablecoin";
    }
    if (lowerId.includes("btc") || lowerId.includes("eth") || lowerId.includes("xlm")) {
      return "blue-chip";
    }
    if (lowerId.includes("defi") || lowerId.includes("yield")) {
      return "defi-token";
    }
    return "volatile";
  }

  /**
   * Get base price for asset (mock)
   */
  private getBasePrice(assetId: string): number {
    const lowerId = assetId.toLowerCase();
    if (lowerId.includes("usdc") || lowerId.includes("usdt")) return 1.0;
    if (lowerId.includes("btc")) return 45000;
    if (lowerId.includes("eth")) return 2500;
    if (lowerId.includes("xlm")) return 0.12;
    return 100; // Default base price
  }

  /**
   * Calculate annualized return from period return
   */
  private annualizeReturn(periodReturn: number, days: number): number {
    const returnDecimal = periodReturn / 100;
    const years = days / 365;
    if (years <= 0) return 0;
    
    // Compound annualization
    const annualized = (Math.pow(1 + returnDecimal, 1 / years) - 1) * 100;
    return annualized;
  }

  /**
   * Calculate volatility (standard deviation of returns)
   */
  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;

    // Calculate daily returns
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }

    // Calculate mean return
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    
    // Calculate variance
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    
    // Annualize volatility
    const dailyVol = Math.sqrt(variance);
    const annualVol = dailyVol * Math.sqrt(365);
    
    return annualVol;
  }

  /**
   * Calculate Sharpe ratio
   */
  private calculateSharpeRatio(annualizedReturn: number, volatility: number): number {
    if (volatility === 0) return 0;
    
    const riskFreeRate = this.config.riskFreeRate * 100; // Convert to percentage
    const excessReturn = annualizedReturn - riskFreeRate;
    const sharpe = excessReturn / volatility;
    
    return sharpe;
  }

  /**
   * Classify outperformance magnitude
   */
  private classifyMagnitude(returnDelta: number): BenchmarkDelta["magnitude"] {
    if (returnDelta >= this.config.significantOutperformanceThreshold) {
      return "significant_outperformance";
    }
    if (returnDelta > 0) {
      return "marginal_outperformance";
    }
    if (returnDelta <= this.config.negativeSignificantThreshold) {
      return "significant_underperformance";
    }
    return "underperformance";
  }

  /**
   * Calculate confidence level in benchmark comparison
   */
  private calculateConfidenceLevel(
    strategyOutcome: StrategyOutcome,
    baseline: PassiveHoldBaseline,
  ): number {
    let confidence = 0.8; // Base confidence

    // Reduce confidence for projected data
    if (strategyOutcome.dataType === "projected") {
      confidence -= 0.2;
    }

    // Reduce confidence for short periods
    const periodDays = (new Date(baseline.periodEnd).getTime() - new Date(baseline.periodStart).getTime()) / (24 * 60 * 60 * 1000);
    if (periodDays < 30) {
      confidence -= 0.15;
    } else if (periodDays < 90) {
      confidence -= 0.05;
    }

    // Reduce confidence for high volatility
    if (baseline.volatility > 0.5) {
      confidence -= 0.1;
    }

    return Math.max(0.3, Math.min(1.0, confidence));
  }

  /**
   * Generate standard normal random variable (Box-Muller transform)
   */
  private gaussianRandom(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<BenchmarkConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): BenchmarkConfig {
    return { ...this.config };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    cache.flushAll();
    this.historicalPriceData.clear();
  }
}

// ── Export singleton instance ─────────────────────────────────────────────

export const benchmarkEngine = new BenchmarkEngine();

// ── Helper Functions ─────────────────────────────────────────────────────

/**
 * Format benchmark result for API response
 */
export function formatBenchmarkResult(result: BenchmarkResult): BenchmarkResult {
  return {
    ...result,
    delta: {
      ...result.delta,
      returnDelta: Math.round(result.delta.returnDelta * 100) / 100,
      annualizedDelta: Math.round(result.delta.annualizedDelta * 100) / 100,
      confidenceLevel: Math.round(result.delta.confidenceLevel * 1000) / 1000,
    },
  };
}

/**
 * Get benchmark summary for UI display
 */
export function getBenchmarkSummary(result: BenchmarkResult): {
  verdict: string;
  color: string;
  message: string;
} {
  const { delta } = result;
  
  if (delta.magnitude === "significant_outperformance") {
    return {
      verdict: "Outperforming",
      color: "green",
      message: `Strategy outperformed passive hold by ${delta.returnDelta.toFixed(2)}%`,
    };
  }
  if (delta.magnitude === "marginal_outperformance") {
    return {
      verdict: "Slightly Outperforming",
      color: "lightgreen",
      message: `Strategy marginally outperformed passive hold by ${delta.returnDelta.toFixed(2)}%`,
    };
  }
  if (delta.magnitude === "significant_underperformance") {
    return {
      verdict: "Underperforming",
      color: "red",
      message: `Strategy underperformed passive hold by ${Math.abs(delta.returnDelta).toFixed(2)}%`,
    };
  }
  return {
    verdict: "Slightly Underperforming",
    color: "orange",
    message: `Strategy slightly underperformed passive hold by ${Math.abs(delta.returnDelta).toFixed(2)}%`,
  };
}
