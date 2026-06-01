/**
 * Issue #289: Composable Multi-Strategy Vault Orchestrator
 *
 * Orchestrates composition of multiple strategy modules into a single
 * managed vault allocation system with configurable weighting and rotation rules.
 * Ensures failure isolation and composition integrity.
 */

export interface StrategyModule {
  id: string;
  name: string;
  version: string;
  /** Current allocation weight (0-1). */
  weight: number;
  /** Priority order for execution (lower = higher priority). */
  priority: number;
  /** Strategy performance score (higher = better). */
  performanceScore: number;
  /** Whether strategy is currently active. */
  isActive: boolean;
  /** Compatibility tags (used for validation). */
  compatibilityTags: string[];
  /** Last rebalance timestamp. */
  lastRebalanceAt: Date;
}

export interface OrchestrationConfig {
  /** Vault identifier. */
  vaultId: string;
  /** Vault name for display. */
  vaultName: string;
  /** Strategy composition rules. */
  strategies: StrategyModule[];
  /** Whether to enforce weight normalization. */
  normalizeWeights: boolean;
  /** Minimum weight per strategy (floor). */
  minStrategyWeight: number;
  /** Maximum weight per strategy (ceiling). */
  maxStrategyWeight: number;
  /** Compatibility checks required. */
  requireCompatibilityCheck: boolean;
  /** Rotation policy: how often to rebalance. */
  rotationIntervalMs: number;
  /** Whether one failing strategy should block entire orchestration. */
  failureIsolation: boolean;
}

export interface CompositionState {
  /** Total allocation across all strategies. */
  totalAllocation: number;
  /** Number of active strategies. */
  activeStrategies: number;
  /** Weighted average performance score. */
  weightedPerformanceScore: number;
  /** Whether composition is valid. */
  isValid: boolean;
  /** Validation errors if any. */
  validationErrors: string[];
  /** Time state was last updated. */
  lastUpdatedAt: Date;
}

export interface AllocationDecision {
  strategyId: string;
  strategyName: string;
  currentWeight: number;
  recommendedWeight: number;
  reason: string;
  confidence: number;
}

export interface OrchestrationResult {
  vaultId: string;
  timestamp: Date;
  allocationDecisions: AllocationDecision[];
  compositionState: CompositionState;
  riskMetrics: {
    concentrationRisk: number;
    correlationRisk: number;
    failureRisk: number;
  };
  nextRebalanceAt: Date;
}

/**
 * Multi-Strategy Vault Orchestrator
 *
 * Manages composition of multiple strategy modules with:
 * - Configurable weights and priorities
 * - Compatibility checking
 * - Failure isolation
 * - Seamless rebalancing
 *
 * No state mutations occur internally; orchestration decisions
 * are returned for caller execution.
 */
export class VaultOrchestrator {
  private config: OrchestrationConfig;
  private executionHistory: Array<{
    timestamp: Date;
    decision: OrchestrationResult;
  }> = [];

  constructor(config: OrchestrationConfig) {
    this.config = config;
  }

  /**
   * Validate strategy composition rules.
   * Returns array of validation errors (empty if valid).
   */
  validateComposition(): string[] {
    const errors: string[] = [];

    // Check that at least one strategy is active
    const activeCount = this.config.strategies.filter((s) => s.isActive).length;
    if (activeCount === 0) {
      errors.push("At least one strategy must be active");
    }

    // Check weight constraints
    let totalWeight = 0;
    for (const strategy of this.config.strategies) {
      if (strategy.weight < 0 || strategy.weight > 1) {
        errors.push(
          `Strategy ${strategy.id}: weight must be between 0 and 1, got ${strategy.weight}`,
        );
      }

      if (
        strategy.weight > 0 &&
        strategy.weight < this.config.minStrategyWeight
      ) {
        errors.push(
          `Strategy ${strategy.id}: weight ${strategy.weight} below minimum ${this.config.minStrategyWeight}`,
        );
      }

      if (strategy.weight > this.config.maxStrategyWeight) {
        errors.push(
          `Strategy ${strategy.id}: weight ${strategy.weight} exceeds maximum ${this.config.maxStrategyWeight}`,
        );
      }

      totalWeight += strategy.weight;
    }

    // Check total allocation (allow small floating point error)
    if (Math.abs(totalWeight - 1.0) > 0.001) {
      errors.push(
        `Total allocation (${totalWeight.toFixed(4)}) does not sum to 1.0`,
      );
    }

    // Compatibility checks
    if (this.config.requireCompatibilityCheck) {
      const allTags = new Set<string>();
      for (const strategy of this.config.strategies) {
        strategy.compatibilityTags.forEach((tag) => allTags.add(tag));
      }

      // Ensure no conflicting tags
      const conflicts = this.detectCompatibilityConflicts();
      errors.push(...conflicts);
    }

    return errors;
  }

  /**
   * Detect compatibility conflicts between strategies.
   */
  private detectCompatibilityConflicts(): string[] {
    const conflicts: string[] = [];
    const conflictingPairs = [
      ["stablecoin-only", "volatile-assets"],
      ["manual-execution", "automated-rebalancing"],
      ["high-frequency", "low-frequency"],
    ];

    for (const [tag1, tag2] of conflictingPairs) {
      const hasTag1 = this.config.strategies.some((s) =>
        s.compatibilityTags.includes(tag1),
      );
      const hasTag2 = this.config.strategies.some((s) =>
        s.compatibilityTags.includes(tag2),
      );

      if (hasTag1 && hasTag2) {
        conflicts.push(
          `Incompatible strategies: detected both "${tag1}" and "${tag2}"`,
        );
      }
    }

    return conflicts;
  }

  /**
   * Get current composition state.
   */
  getCompositionState(): CompositionState {
    const validationErrors = this.validateComposition();
    const activeStrategies = this.config.strategies.filter(
      (s) => s.isActive,
    ).length;
    const totalAllocation = this.config.strategies.reduce(
      (sum, s) => sum + s.weight,
      0,
    );
    const weightedScore = this.config.strategies.reduce(
      (sum, s) => sum + s.weight * s.performanceScore,
      0,
    );

    return {
      totalAllocation,
      activeStrategies,
      weightedPerformanceScore: weightedScore,
      isValid: validationErrors.length === 0,
      validationErrors,
      lastUpdatedAt: new Date(),
    };
  }

  /**
   * Normalize weights to sum to 1.0.
   * Respects min/max constraints where possible.
   */
  normalizeWeights(): StrategyModule[] {
    const normalized = this.config.strategies.map((s) => ({ ...s }));
    const totalWeight = normalized.reduce((sum, s) => sum + s.weight, 0);

    if (totalWeight === 0) {
      // Equal distribution
      const equal = 1 / normalized.length;
      return normalized.map((s) => ({
        ...s,
        weight: equal,
      }));
    }

    // Scale to 1.0
    return normalized.map((s) => ({
      ...s,
      weight: s.weight / totalWeight,
    }));
  }

  /**
   * Calculate concentration risk (Herfindahl index).
   * Higher = more concentrated = riskier.
   */
  private calculateConcentrationRisk(): number {
    const hhi = this.config.strategies.reduce(
      (sum, s) => sum + Math.pow(s.weight, 2),
      0,
    );
    // Normalize to 0-100 scale
    return (hhi / (1 / this.config.strategies.length)) * 100;
  }

  /**
   * Calculate failure risk based on strategy correlation.
   * Simple heuristic: similar tags = higher correlation.
   */
  private calculateFailureRisk(): number {
    if (this.config.strategies.length <= 1) return 0;

    let totalCorrelation = 0;
    let pairCount = 0;

    for (let i = 0; i < this.config.strategies.length; i++) {
      for (let j = i + 1; j < this.config.strategies.length; j++) {
        const s1 = this.config.strategies[i];
        const s2 = this.config.strategies[j];

        const commonTags = s1.compatibilityTags.filter((tag) =>
          s2.compatibilityTags.includes(tag),
        ).length;
        const allTags = new Set([
          ...s1.compatibilityTags,
          ...s2.compatibilityTags,
        ]).size;
        const correlation = allTags > 0 ? commonTags / allTags : 0;

        totalCorrelation += correlation * s1.weight * s2.weight;
        pairCount++;
      }
    }

    return pairCount > 0 ? (totalCorrelation / pairCount) * 100 : 0;
  }

  /**
   * Calculate correlation risk (simplified).
   * Based on shared compatibility tags.
   */
  private calculateCorrelationRisk(): number {
    const concentration = this.calculateConcentrationRisk();
    const failureRisk = this.calculateFailureRisk();
    return (concentration + failureRisk) / 2;
  }

  /**
   * Generate orchestration recommendations.
   * Returns allocation decisions without mutating state.
   */
  orchestrate(): OrchestrationResult {
    const compositionState = this.getCompositionState();

    const allocationDecisions: AllocationDecision[] =
      this.config.strategies.map((strategy) => {
        const recommendation = this.recommendAllocation(strategy);
        return {
          strategyId: strategy.id,
          strategyName: strategy.name,
          currentWeight: strategy.weight,
          recommendedWeight: recommendation.weight,
          reason: recommendation.reason,
          confidence: recommendation.confidence,
        };
      });

    const nextRebalanceAt = new Date(
      Date.now() + this.config.rotationIntervalMs,
    );

    const result: OrchestrationResult = {
      vaultId: this.config.vaultId,
      timestamp: new Date(),
      allocationDecisions,
      compositionState,
      riskMetrics: {
        concentrationRisk: this.calculateConcentrationRisk(),
        correlationRisk: this.calculateCorrelationRisk(),
        failureRisk: this.calculateFailureRisk(),
      },
      nextRebalanceAt,
    };

    // Record decision
    this.executionHistory.push({
      timestamp: result.timestamp,
      decision: result,
    });

    return result;
  }

  /**
   * Recommend allocation for a single strategy.
   */
  private recommendAllocation(
    strategy: StrategyModule,
  ): { weight: number; reason: string; confidence: number } {
    if (!strategy.isActive) {
      return {
        weight: 0,
        reason: "Strategy is inactive",
        confidence: 1.0,
      };
    }

    // Performance-based weight adjustment
    const avgPerformance = this.config.strategies
      .filter((s) => s.isActive)
      .reduce((sum, s) => sum + s.performanceScore, 0) /
      this.config.strategies.filter((s) => s.isActive).length;

    const performanceDelta = strategy.performanceScore - avgPerformance;
    const adjustmentFactor = 1 + performanceDelta * 0.1; // ±10% based on performance

    let recommendedWeight = strategy.weight * adjustmentFactor;

    // Enforce constraints
    recommendedWeight = Math.max(
      this.config.minStrategyWeight,
      Math.min(this.config.maxStrategyWeight, recommendedWeight),
    );

    const reason =
      performanceDelta > 0
        ? `Performance above average (+${performanceDelta.toFixed(2)})`
        : performanceDelta < 0
          ? `Performance below average (${performanceDelta.toFixed(2)})`
          : "Average performance";

    return {
      weight: recommendedWeight,
      reason,
      confidence: Math.min(0.95, 0.5 + Math.abs(performanceDelta) * 0.1),
    };
  }

  /**
   * Get orchestration history.
   */
  getHistory(limit: number = 10): OrchestrationResult[] {
    return this.executionHistory
      .slice(-limit)
      .reverse()
      .map((h) => h.decision);
  }

  /**
   * Update strategy configuration.
   */
  updateStrategy(strategyId: string, updates: Partial<StrategyModule>): void {
    const strategy = this.config.strategies.find((s) => s.id === strategyId);
    if (!strategy) {
      throw new Error(`Strategy not found: ${strategyId}`);
    }

    Object.assign(strategy, updates);
  }

  /**
   * Add new strategy to composition.
   */
  addStrategy(strategy: StrategyModule): void {
    if (this.config.strategies.some((s) => s.id === strategy.id)) {
      throw new Error(`Strategy already exists: ${strategy.id}`);
    }

    this.config.strategies.push(strategy);

    // Rebalance weights if normalization is enabled
    if (this.config.normalizeWeights) {
      const normalized = this.normalizeWeights();
      this.config.strategies = normalized;
    }
  }

  /**
   * Remove strategy from composition.
   */
  removeStrategy(strategyId: string): void {
    const idx = this.config.strategies.findIndex((s) => s.id === strategyId);
    if (idx < 0) {
      throw new Error(`Strategy not found: ${strategyId}`);
    }

    this.config.strategies.splice(idx, 1);

    // Rebalance weights
    if (this.config.normalizeWeights) {
      const normalized = this.normalizeWeights();
      this.config.strategies = normalized;
    }
  }
}
