/**
 * Issue #362: Adaptive Strategy Cooldown Optimizer
 *
 * Dynamically adjusts strategy cooldown windows based on volatility,
 * liquidity, recent execution outcomes, and market stress conditions.
 * Ensures critical safety pauses are never disabled.
 */

export interface StrategyMetrics {
  strategyId: string;
  strategyName: string;
  /** Recent rebalance frequency (rebalances per day). */
  rebalanceFrequency: number;
  /** Current volatility estimate (0-100 scale). */
  volatility: number;
  /** Liquidity score (0-100 scale, higher = better). */
  liquidityScore: number;
  /** Recent execution success rate (0-1). */
  executionSuccessRate: number;
  /** Last rebalance timestamp. */
  lastRebalanceAt: Date;
  /** Number of consecutive failed executions. */
  consecutiveFailures: number;
  /** Average slippage from last 10 executions (0-100 basis points). */
  averageSlippage: number;
}

export interface CooldownExpansionFactors {
  /** Factor due to high volatility (multiplier). */
  volatilityFactor: number;
  /** Factor due to poor liquidity (multiplier). */
  liquidityFactor: number;
  /** Factor due to recent failures (multiplier). */
  failuresFactor: number;
  /** Factor due to market stress (multiplier). */
  marketStressFactor: number;
}

export interface CooldownRecommendation {
  strategyId: string;
  strategyName: string;
  /** Recommended cooldown in milliseconds. */
  recommendedCooldownMs: number;
  /** Current baseline cooldown. */
  baselineCooldownMs: number;
  /** Reason for expansion/contraction. */
  reason: string;
  /** Breakdown of all expansion factors. */
  factors: CooldownExpansionFactors;
  /** Total multiplier applied. */
  totalMultiplier: number;
  /** Confidence in recommendation (0-1). */
  confidence: number;
  /** Time this recommendation was generated. */
  generatedAt: Date;
}

export interface CooldownOptimizerConfig {
  /** Baseline cooldown for all strategies (ms). */
  baselineCooldownMs: number;
  /** Minimum cooldown floor (never go below). */
  minCooldownMs: number;
  /** Maximum cooldown ceiling (never go above). */
  maxCooldownMs: number;
  /** Volatility threshold for expansion (0-100). */
  volatilityThreshold: number;
  /** Liquidity threshold for expansion (0-100). */
  liquidityThreshold: number;
  /** Max consecutive failures before expanding cooldown. */
  maxConsecutiveFailures: number;
  /** Market stress multiplier. */
  marketStressMultiplier: number;
}

export const DEFAULT_COOLDOWN_CONFIG: CooldownOptimizerConfig = {
  baselineCooldownMs: 24 * 60 * 60 * 1000, // 24 hours
  minCooldownMs: 60 * 60 * 1000, // 1 hour (safety floor)
  maxCooldownMs: 14 * 24 * 60 * 60 * 1000, // 14 days (ceiling)
  volatilityThreshold: 60,
  liquidityThreshold: 40,
  maxConsecutiveFailures: 3,
  marketStressMultiplier: 1.5,
};

/**
 * Adaptive Cooldown Optimizer Service
 *
 * Computes dynamic cooldown recommendations per strategy based on:
 * - Market volatility
 * - Liquidity conditions
 * - Recent execution outcomes
 * - Market stress levels
 * - Failure patterns
 *
 * All recommendations respect configured floor/ceiling constraints.
 */
export class AdaptiveCooldownOptimizer {
  constructor(private config: CooldownOptimizerConfig = DEFAULT_COOLDOWN_CONFIG) {}

  /**
   * Computes expansion factors based on strategy metrics.
   */
  private computeExpansionFactors(
    metrics: StrategyMetrics,
    isUnderMarketStress: boolean,
  ): CooldownExpansionFactors {
    // Volatility factor: higher volatility = longer cooldown
    const volatilityFactor = Math.max(
      1.0,
      1 +
        Math.max(0, metrics.volatility - this.config.volatilityThreshold) /
          100 *
          0.5, // Up to 50% expansion
    );

    // Liquidity factor: lower liquidity = longer cooldown
    const liquidityFactor = Math.max(
      1.0,
      1 +
        Math.max(0, this.config.liquidityThreshold - metrics.liquidityScore) /
          100 *
          0.5, // Up to 50% expansion
    );

    // Failures factor: consecutive failures = longer cooldown
    const failuresFactor = Math.max(
      1.0,
      1 +
        Math.min(
          metrics.consecutiveFailures,
          this.config.maxConsecutiveFailures,
        ) /
          this.config.maxConsecutiveFailures *
          0.75, // Up to 75% expansion
    );

    // Execution success rate: lower success = expansion
    const successFactor = Math.max(
      1.0,
      1 + (1 - metrics.executionSuccessRate) * 0.4, // Up to 40% expansion
    );

    // Slippage factor: higher slippage = expansion
    const slippageFactor = Math.max(1.0, 1 + metrics.averageSlippage / 100 * 0.3); // Up to 30% expansion

    // Market stress: global override for stress conditions
    const marketStressFactor = isUnderMarketStress
      ? this.config.marketStressMultiplier
      : 1.0;

    return {
      volatilityFactor,
      liquidityFactor,
      failuresFactor,
      marketStressFactor,
    };
  }

  /**
   * Generates a cooldown recommendation for a strategy.
   *
   * @param metrics Strategy performance and market metrics
   * @param isUnderMarketStress Whether system is under stress
   * @returns CooldownRecommendation with detailed reasoning
   */
  recommendCooldown(
    metrics: StrategyMetrics,
    isUnderMarketStress: boolean = false,
  ): CooldownRecommendation {
    const factors = this.computeExpansionFactors(metrics, isUnderMarketStress);

    // Aggregate all multipliers
    const totalMultiplier =
      factors.volatilityFactor *
      factors.liquidityFactor *
      factors.failuresFactor *
      factors.marketStressFactor;

    // Apply multiplier to baseline
    let recommendedMs = this.config.baselineCooldownMs * totalMultiplier;

    // Enforce floor and ceiling
    recommendedMs = Math.max(
      this.config.minCooldownMs,
      Math.min(this.config.maxCooldownMs, recommendedMs),
    );

    // Build reason string
    const reasons: string[] = [];
    if (factors.volatilityFactor > 1.0) {
      reasons.push(`high volatility (${metrics.volatility.toFixed(1)})`);
    }
    if (factors.liquidityFactor > 1.0) {
      reasons.push(`low liquidity (${metrics.liquidityScore.toFixed(1)})`);
    }
    if (factors.failuresFactor > 1.0) {
      reasons.push(`${metrics.consecutiveFailures} consecutive failures`);
    }
    if (isUnderMarketStress) {
      reasons.push("market stress detected");
    }

    const reason =
      reasons.length > 0
        ? `Cooldown expanded due to: ${reasons.join(", ")}`
        : "Normal market conditions";

    // Confidence: lower when multiple factors are pushing expansion
    const expansionCount = [
      factors.volatilityFactor > 1.0,
      factors.liquidityFactor > 1.0,
      factors.failuresFactor > 1.0,
      isUnderMarketStress,
    ].filter(Boolean).length;

    const confidence = Math.max(0.5, 1 - expansionCount * 0.15);

    return {
      strategyId: metrics.strategyId,
      strategyName: metrics.strategyName,
      recommendedCooldownMs: Math.round(recommendedMs),
      baselineCooldownMs: this.config.baselineCooldownMs,
      reason,
      factors,
      totalMultiplier,
      confidence,
      generatedAt: new Date(),
    };
  }

  /**
   * Batch recommend cooldowns for multiple strategies.
   */
  recommendCooldownsBatch(
    metrics: StrategyMetrics[],
    isUnderMarketStress: boolean = false,
  ): CooldownRecommendation[] {
    return metrics.map((m) => this.recommendCooldown(m, isUnderMarketStress));
  }

  /**
   * Format cooldown duration for display.
   */
  static formatDuration(ms: number): string {
    const hours = Math.floor(ms / (60 * 60 * 1000));
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    }
    return `${hours}h`;
  }

  /**
   * Check if a strategy needs cooldown expansion.
   */
  shouldExpandCooldown(
    metrics: StrategyMetrics,
    isUnderMarketStress: boolean = false,
  ): boolean {
    const recommendation = this.recommendCooldown(metrics, isUnderMarketStress);
    return (
      recommendation.recommendedCooldownMs >
      this.config.baselineCooldownMs * 1.1
    );
  }

  /**
   * Check if a strategy can contract cooldown.
   */
  shouldContractCooldown(
    metrics: StrategyMetrics,
    isUnderMarketStress: boolean = false,
  ): boolean {
    const recommendation = this.recommendCooldown(metrics, isUnderMarketStress);
    return (
      recommendation.recommendedCooldownMs <
      this.config.baselineCooldownMs * 0.9
    );
  }
}
