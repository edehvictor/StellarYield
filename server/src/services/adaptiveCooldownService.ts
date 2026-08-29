/**
 * Issue #362: Adaptive Strategy Cooldown Optimizer
 *
 * Dynamically adjusts strategy cooldown windows based on volatility,
 * liquidity, recent execution outcomes, and market stress conditions.
 * Ensures critical safety pauses are never disabled.
 */

export type CooldownReasonCode =
  | "NORMAL_CONDITIONS"
  | "FAVORABLE_CONDITIONS_CONTRACTION"
  | "HIGH_VOLATILITY"
  | "LOW_LIQUIDITY"
  | "CONSECUTIVE_FAILURES"
  | "LOW_EXECUTION_SUCCESS"
  | "HIGH_SLIPPAGE"
  | "MARKET_STRESS"
  | "SAFETY_FLOOR_ENFORCED"
  | "MAX_CEILING_ENFORCED";

export const COOLDOWN_REASON_DESCRIPTIONS: Record<CooldownReasonCode, string> = {
  NORMAL_CONDITIONS: "Strategy performance and market indicators are within nominal parameters.",
  FAVORABLE_CONDITIONS_CONTRACTION: "Excellent conditions across all metrics allowed safe contraction below baseline.",
  HIGH_VOLATILITY: "Strategy volatility exceeds expansion threshold, extending cooldown window.",
  LOW_LIQUIDITY: "Liquidity score is below safety threshold, extending cooldown to protect against slippage.",
  CONSECUTIVE_FAILURES: "Recent consecutive execution failures triggered defensive cooldown expansion.",
  LOW_EXECUTION_SUCCESS: "Execution success rate fell below 95%, expanding rebalance cooldown.",
  HIGH_SLIPPAGE: "Observed execution slippage exceeded tolerance limit.",
  MARKET_STRESS: "System-wide market stress multiplier applied.",
  SAFETY_FLOOR_ENFORCED: "Cooldown reached minimum safety floor (safety pauses preserved).",
  MAX_CEILING_ENFORCED: "Cooldown bounded by maximum allowed duration.",
};

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
  /** Primary reason code for the decision. */
  primaryReasonCode: CooldownReasonCode;
  /** List of all triggered reason codes. */
  reasonCodes: CooldownReasonCode[];
  /** Reason for expansion/contraction. */
  reason: string;
  /** Breakdown of all expansion factors. */
  factors: CooldownExpansionFactors;
  /** Total multiplier applied. */
  totalMultiplier: number;
  /** Confidence in recommendation (0-1). */
  confidence: number;
  /** Normalized input metrics. */
  normalizedMetrics: StrategyMetrics;
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

function roundToPrecision(value: number, decimals: number = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Normalizes strategy metrics before scoring.
 * Clamps values to valid bounds and rounds floats to eliminate floating point noise.
 */
export function normalizeStrategyMetrics(raw: Partial<StrategyMetrics>): StrategyMetrics {
  const sanitizeNumber = (
    val: unknown,
    min: number,
    max: number,
    defaultVal: number,
    decimals: number = 4,
  ): number => {
    if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val)) {
      return defaultVal;
    }
    const clamped = Math.max(min, Math.min(max, val));
    return roundToPrecision(clamped, decimals);
  };

  const sanitizeInt = (val: unknown, min: number, max: number, defaultVal: number): number => {
    if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val)) {
      return defaultVal;
    }
    const rounded = Math.round(val);
    return Math.max(min, Math.min(max, rounded));
  };

  return {
    strategyId: String(raw.strategyId ?? "default_strategy"),
    strategyName: String(raw.strategyName ?? "Default Strategy"),
    rebalanceFrequency: sanitizeNumber(raw.rebalanceFrequency, 0, 1000, 0.1, 4),
    volatility: sanitizeNumber(raw.volatility, 0, 100, 30, 2),
    liquidityScore: sanitizeNumber(raw.liquidityScore, 0, 100, 80, 2),
    executionSuccessRate: sanitizeNumber(raw.executionSuccessRate, 0, 1, 0.95, 4),
    lastRebalanceAt: raw.lastRebalanceAt instanceof Date ? raw.lastRebalanceAt : new Date(),
    consecutiveFailures: sanitizeInt(raw.consecutiveFailures, 0, 1000, 0),
    averageSlippage: sanitizeNumber(raw.averageSlippage, 0, 10000, 5, 2),
  };
}

// ── In-Memory Persistence Store for Cooldown Recommendations ────────────

const cooldownRecommendationStore = new Map<string, CooldownRecommendation[]>();

export function saveCooldownRecommendation(strategyId: string, rec: CooldownRecommendation): void {
  const existing = cooldownRecommendationStore.get(strategyId) ?? [];
  cooldownRecommendationStore.set(strategyId, [rec, ...existing].slice(0, 50));
}

export function getLatestCooldownRecommendation(strategyId: string): CooldownRecommendation | undefined {
  return cooldownRecommendationStore.get(strategyId)?.[0];
}

export function getCooldownRecommendationHistory(strategyId: string): CooldownRecommendation[] {
  return cooldownRecommendationStore.get(strategyId) ?? [];
}

export function resetCooldownRecommendationStore(): void {
  cooldownRecommendationStore.clear();
}

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
  ): CooldownExpansionFactors & {
    contractionFactor: number;
    successFactor: number;
    slippageFactor: number;
  } {
    // Volatility factor: higher volatility = longer cooldown
    const volatilityFactor = Math.max(
      1.0,
      1 +
        (Math.max(0, metrics.volatility - this.config.volatilityThreshold) / 100) * 0.5, // Up to 50% expansion
    );

    // Liquidity factor: lower liquidity = longer cooldown
    const liquidityFactor = Math.max(
      1.0,
      1 +
        (Math.max(0, this.config.liquidityThreshold - metrics.liquidityScore) / 100) * 0.5, // Up to 50% expansion
    );

    // Failures factor: consecutive failures = longer cooldown
    const failuresFactor = Math.max(
      1.0,
      1 +
        (Math.min(metrics.consecutiveFailures, this.config.maxConsecutiveFailures) /
          this.config.maxConsecutiveFailures) *
          0.75, // Up to 75% expansion
    );

    // Execution success rate: lower success (< 95%) = expansion
    const successFactor = Math.max(
      1.0,
      1 + Math.max(0, 0.95 - metrics.executionSuccessRate) * 0.4,
    );

    // Slippage factor: higher slippage (> 2%) = expansion
    const slippageFactor = Math.max(
      1.0,
      1 + (Math.max(0, metrics.averageSlippage - 2.0) / 100) * 0.3,
    );

    // Market stress: global override for stress conditions
    const marketStressFactor = isUnderMarketStress
      ? this.config.marketStressMultiplier
      : 1.0;

    // Contraction factor: when all conditions are excellent, cooldown can shrink.
    // Applies only when no expansion factors are triggered.
    const allFavorable =
      !isUnderMarketStress &&
      volatilityFactor === 1.0 &&
      liquidityFactor === 1.0 &&
      failuresFactor === 1.0 &&
      successFactor === 1.0 &&
      slippageFactor === 1.0;
    // Contract up to 20% below baseline when conditions are excellent
    const contractionFactor = allFavorable ? 0.8 : 1.0;

    return {
      volatilityFactor: roundToPrecision(volatilityFactor, 4),
      liquidityFactor: roundToPrecision(liquidityFactor, 4),
      failuresFactor: roundToPrecision(failuresFactor, 4),
      marketStressFactor: roundToPrecision(marketStressFactor, 4),
      contractionFactor: roundToPrecision(contractionFactor, 4),
      successFactor: roundToPrecision(successFactor, 4),
      slippageFactor: roundToPrecision(slippageFactor, 4),
    };
  }

  /**
   * Generates a cooldown recommendation for a strategy.
   *
   * @param rawMetrics Strategy performance and market metrics
   * @param isUnderMarketStress Whether system is under stress
   * @returns CooldownRecommendation with detailed reasoning
   */
  recommendCooldown(
    rawMetrics: Partial<StrategyMetrics>,
    isUnderMarketStress: boolean = false,
  ): CooldownRecommendation {
    const metrics = normalizeStrategyMetrics(rawMetrics);
    const factors = this.computeExpansionFactors(metrics, isUnderMarketStress);

    // Aggregate all multipliers (contraction applies when conditions are excellent)
    const totalMultiplier = roundToPrecision(
      factors.volatilityFactor *
        factors.liquidityFactor *
        factors.failuresFactor *
        factors.marketStressFactor *
        factors.contractionFactor,
      4,
    );

    // Apply multiplier to baseline
    const unboundedMs = this.config.baselineCooldownMs * totalMultiplier;

    // Enforce floor and ceiling
    const recommendedMs = Math.max(
      this.config.minCooldownMs,
      Math.min(this.config.maxCooldownMs, unboundedMs),
    );

    // Build reason string and reason codes
    const reasons: string[] = [];
    const reasonCodes: CooldownReasonCode[] = [];

    if (factors.volatilityFactor > 1.0) {
      reasons.push(`high volatility (${metrics.volatility.toFixed(1)})`);
      reasonCodes.push("HIGH_VOLATILITY");
    }
    if (factors.liquidityFactor > 1.0) {
      reasons.push(`low liquidity (${metrics.liquidityScore.toFixed(1)})`);
      reasonCodes.push("LOW_LIQUIDITY");
    }
    if (factors.failuresFactor > 1.0) {
      reasons.push(`${metrics.consecutiveFailures} consecutive failures`);
      reasonCodes.push("CONSECUTIVE_FAILURES");
    }
    if (factors.successFactor > 1.0) {
      reasonCodes.push("LOW_EXECUTION_SUCCESS");
    }
    if (factors.slippageFactor > 1.0) {
      reasonCodes.push("HIGH_SLIPPAGE");
    }
    if (isUnderMarketStress) {
      reasons.push("market stress detected");
      reasonCodes.push("MARKET_STRESS");
    }
    if (factors.contractionFactor < 1.0) {
      reasonCodes.push("FAVORABLE_CONDITIONS_CONTRACTION");
    }

    if (unboundedMs <= this.config.minCooldownMs && unboundedMs < this.config.minCooldownMs) {
      reasonCodes.push("SAFETY_FLOOR_ENFORCED");
    }
    if (unboundedMs >= this.config.maxCooldownMs && unboundedMs > this.config.maxCooldownMs) {
      reasonCodes.push("MAX_CEILING_ENFORCED");
    }

    if (reasonCodes.length === 0) {
      reasonCodes.push("NORMAL_CONDITIONS");
    }

    const primaryReasonCode = reasonCodes[0];

    const reason =
      reasons.length > 0
        ? `Cooldown expanded due to: ${reasons.join(", ")}`
        : factors.contractionFactor < 1.0
        ? "Normal market conditions with favorable contraction applied"
        : "Normal market conditions";

    // Confidence: lower when multiple factors are pushing expansion
    const expansionCount = [
      factors.volatilityFactor > 1.0,
      factors.liquidityFactor > 1.0,
      factors.failuresFactor > 1.0,
      isUnderMarketStress,
    ].filter(Boolean).length;

    const confidence = roundToPrecision(Math.max(0.5, 1 - expansionCount * 0.15), 2);

    const recommendation: CooldownRecommendation = {
      strategyId: metrics.strategyId,
      strategyName: metrics.strategyName,
      recommendedCooldownMs: Math.round(recommendedMs),
      baselineCooldownMs: this.config.baselineCooldownMs,
      primaryReasonCode,
      reasonCodes,
      reason,
      factors: {
        volatilityFactor: factors.volatilityFactor,
        liquidityFactor: factors.liquidityFactor,
        failuresFactor: factors.failuresFactor,
        marketStressFactor: factors.marketStressFactor,
      },
      totalMultiplier,
      confidence,
      normalizedMetrics: metrics,
      generatedAt: new Date(),
    };

    saveCooldownRecommendation(metrics.strategyId, recommendation);

    return recommendation;
  }

  /**
   * Batch recommend cooldowns for multiple strategies.
   */
  recommendCooldownsBatch(
    metrics: Partial<StrategyMetrics>[],
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
    metrics: Partial<StrategyMetrics>,
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
    metrics: Partial<StrategyMetrics>,
    isUnderMarketStress: boolean = false,
  ): boolean {
    const recommendation = this.recommendCooldown(metrics, isUnderMarketStress);
    return (
      recommendation.recommendedCooldownMs <
      this.config.baselineCooldownMs * 0.9
    );
  }
}

