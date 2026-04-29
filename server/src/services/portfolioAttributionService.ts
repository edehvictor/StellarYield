import NodeCache = require('node-cache');

// ── Types ───────────────────────────────────────────────────────────────

export interface StrategyDecision {
  id: string;
  type: 'initial_routing' | 'rotation' | 'incentive_capture' | 'hold';
  timestamp: string;
  protocol: string;
  amount: number;
  expectedApy: number;
  actualApy?: number;
  duration: number; // days
  confidence: number; // 0-1

  /**
   * Input completeness hints.
   * - If `actualApy` is missing, we treat price inputs as incomplete by default.
   * - For incentive emissions, callers may set `hasEmissionsInputs=false` when emissions data is missing.
   */
  hasPriceInputs?: boolean;
  hasEmissionsInputs?: boolean;
}

export type RewardSource = 'base_protocol_yield' | 'incentive_emissions' | 'fees' | 'tactical_routing';

export interface RewardSourceMixEntry {
  rewardSource: RewardSource;
  contribution: number; // USD value contribution (already confidence-weighted)
  percentage: number; // of total return
  confidence: number; // 0-1 (weighted by contribution)
}

export interface AttributionBreakdown {
  decisionType: string;
  contribution: number; // USD value
  percentage: number; // of total return
  apyImpact: number;
  decisions: StrategyDecision[];
  confidence: number;
}

export interface AttributionReport {
  walletAddress: string;
  totalReturn: number;
  totalDeposited: number;
  attributionBreakdown: AttributionBreakdown[];
  rewardSourceMix: RewardSourceMixEntry[];
  timeWindow: {
    start: string;
    end: string;
  };
  generatedAt: string;
  dataCompleteness: number; // 0-1
}

export interface AttributionConfig {
  minConfidenceThreshold: number;
  maxDataGapDays: number;
  requireMinDecisions: number;
  weightByAmount: boolean;
  includeIncompleteData: boolean;
}

// ── Configuration ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: AttributionConfig = {
  minConfidenceThreshold: 0.6,
  maxDataGapDays: 7,
  requireMinDecisions: 3,
  weightByAmount: true,
  includeIncompleteData: false,
};

const INCOMPLETE_INPUT_CONFIDENCE_MULTIPLIER = 0.85;

const REWARD_SOURCE_SHARES: Record<
  string,
  Array<{ rewardSource: RewardSource; share: number }>
> = {
  initial_routing: [{ rewardSource: 'base_protocol_yield', share: 1 }],
  hold: [{ rewardSource: 'base_protocol_yield', share: 1 }],
  rotation: [
    { rewardSource: 'tactical_routing', share: 0.7 },
    { rewardSource: 'fees', share: 0.3 },
  ],
  incentive_capture: [{ rewardSource: 'incentive_emissions', share: 1 }],
};

const cache = new NodeCache({
  stdTTL: 600, // 10 minutes
  checkperiod: 60,
  useClones: false,
});

// ── Attribution Engine ───────────────────────────────────────────────────

export class PortfolioAttributionEngine {
  private config: AttributionConfig;

  constructor(config: Partial<AttributionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate attribution report for a wallet within specified time window
   */
  async generateAttributionReport(
    walletAddress: string,
    startTime: string,
    endTime: string,
  ): Promise<AttributionReport> {
    const cacheKey = `attribution:${walletAddress}:${startTime}:${endTime}`;
    const cached = cache.get<AttributionReport>(cacheKey);
    
    if (cached) {
      return cached;
    }

    // Service freeze check removed - freezeService not available

    try {
      // Fetch strategy decisions for the time window
      const decisions = await this.fetchStrategyDecisions(walletAddress, startTime, endTime);
      
      // Calculate returns and attribution
      const attributionBreakdown = this.calculateAttribution(decisions);
      
      // Assess data completeness.
      // If we have very few decisions, we treat the overall view as less precise,
      // but we still return a breakdown so dashboards can explain "incomplete" signals.
      let dataCompleteness = this.assessDataCompleteness(decisions, startTime, endTime);
      if (!this.config.includeIncompleteData && decisions.length < this.config.requireMinDecisions) {
        const scarcityFactor = decisions.length / Math.max(1, this.config.requireMinDecisions);
        dataCompleteness = Math.min(dataCompleteness, scarcityFactor);
      }

      // Calculate total metrics
      const totalReturn = attributionBreakdown.reduce(
        (sum, breakdown) => sum + breakdown.contribution,
        0,
      );
      const totalDeposited = decisions.reduce(
        (sum, decision) => sum + decision.amount,
        0,
      );

      const rewardSourceMix = this.calculateRewardSourceMix(attributionBreakdown);

      const report: AttributionReport = {
        walletAddress,
        totalReturn,
        totalDeposited,
        attributionBreakdown,
        rewardSourceMix,
        timeWindow: { start: startTime, end: endTime },
        generatedAt: new Date().toISOString(),
        dataCompleteness,
      };

      // Cache the report
      cache.set(cacheKey, report);
      
      return report;
    } catch (error) {
      console.error("Failed to generate attribution report:", error);
      throw new Error(`Attribution generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Fetch strategy decisions from various sources
   */
  private async fetchStrategyDecisions(
    walletAddress: string,
    startTime: string,
    endTime: string,
  ): Promise<StrategyDecision[]> {
    // In a real implementation, this would query:
    // 1. Transaction history for routing decisions
    // 2. Strategy execution logs for rotations
    // 3. Incentive capture events
    // 4. Hold periods
    
    // Mock implementation for demonstration
    const mockDecisions: StrategyDecision[] = [
      {
        id: "decision_1",
        type: "initial_routing",
        timestamp: "2026-03-20T10:30:00Z",
        protocol: "Blend",
        amount: 5000,
        expectedApy: 6.5,
        actualApy: 6.8,
        duration: 30,
        confidence: 0.85,
        hasPriceInputs: true,
        hasEmissionsInputs: true,
      },
      {
        id: "decision_2", 
        type: "rotation",
        timestamp: "2026-03-25T14:15:00Z",
        protocol: "Soroswap",
        amount: 2000,
        expectedApy: 12.0,
        actualApy: 12.2,
        duration: 25,
        confidence: 0.75,
        hasPriceInputs: true,
        hasEmissionsInputs: true,
      },
      {
        id: "decision_3",
        type: "incentive_capture",
        timestamp: "2026-03-28T09:00:00Z",
        protocol: "DeFindex",
        amount: 3000,
        expectedApy: 9.0,
        actualApy: 8.9,
        duration: 20,
        confidence: 0.90,
        hasPriceInputs: true,
        hasEmissionsInputs: true,
      },
      {
        id: "decision_4",
        type: "hold",
        timestamp: "2026-03-30T16:45:00Z",
        protocol: "Blend",
        amount: 5000,
        expectedApy: 6.5,
        actualApy: 6.7,
        duration: 15,
        confidence: 0.95,
        hasPriceInputs: true,
        hasEmissionsInputs: true,
      },
    ];

    // Filter by time window and confidence threshold
    return mockDecisions.filter(decision => {
      const decisionTime = new Date(decision.timestamp);
      const start = new Date(startTime);
      const end = new Date(endTime);
      const effectiveConfidence = this.getDecisionEffectiveConfidence(decision);
      
      return decisionTime >= start && 
             decisionTime <= end && 
             (effectiveConfidence >= this.config.minConfidenceThreshold || this.config.includeIncompleteData);
    });
  }

  private getDecisionEffectiveConfidence(decision: StrategyDecision): number {
    const baseConfidence = decision.confidence;

    // If we had to fall back to expected APY, price inputs are incomplete by definition.
    const hasPriceInputs = decision.hasPriceInputs ?? decision.actualApy !== undefined;

    // Incentive capture decisions depend on emissions inputs.
    const hasEmissionsInputs = decision.hasEmissionsInputs ?? true;

    let effective = baseConfidence;
    if (!hasPriceInputs) {
      effective *= INCOMPLETE_INPUT_CONFIDENCE_MULTIPLIER;
    }
    if (!hasEmissionsInputs) {
      effective *= INCOMPLETE_INPUT_CONFIDENCE_MULTIPLIER;
    }

    // Always clamp to a valid range so UI math stays safe.
    return Math.max(0, Math.min(1, effective));
  }

  /**
   * Calculate attribution breakdown by decision type
   */
  private calculateAttribution(decisions: StrategyDecision[]): AttributionBreakdown[] {
    const groupedDecisions = this.groupDecisionsByType(decisions);
    const breakdown: AttributionBreakdown[] = [];

    for (const [decisionType, typeDecisions] of Object.entries(groupedDecisions)) {
      const contribution = this.calculateContribution(typeDecisions);
      const percentage = 0; // Will be calculated after total is known
      const apyImpact = this.calculateApyImpact(typeDecisions);
      const confidence = this.calculateAverageConfidence(typeDecisions);

      breakdown.push({
        decisionType,
        contribution,
        percentage,
        apyImpact,
        decisions: typeDecisions,
        confidence,
      });
    }

    // Calculate percentages
    const totalContribution = breakdown.reduce((sum, b) => sum + b.contribution, 0);
    return breakdown.map(b => ({
      ...b,
      percentage: totalContribution > 0 ? (b.contribution / totalContribution) * 100 : 0,
    }));
  }

  /**
   * Group decisions by type
   */
  private groupDecisionsByType(decisions: StrategyDecision[]): Record<string, StrategyDecision[]> {
    return decisions.reduce((grouped, decision) => {
      if (!grouped[decision.type]) {
        grouped[decision.type] = [];
      }
      grouped[decision.type].push(decision);
      return grouped;
    }, {} as Record<string, StrategyDecision[]>);
  }

  /**
   * Calculate contribution of decisions in USD
   */
  private calculateContribution(decisions: StrategyDecision[]): number {
    return decisions.reduce((total, decision) => {
      const actualApy = decision.actualApy || decision.expectedApy;
      const annualReturn = (decision.amount * actualApy) / 100;
      const durationFactor = decision.duration / 365; // Convert days to years
      const contribution = annualReturn * durationFactor;
      
      // Apply confidence weighting (but don't overstate precision when inputs are incomplete).
      const effectiveConfidence = this.getDecisionEffectiveConfidence(decision);
      const weightedContribution = contribution * effectiveConfidence;
      
      // Apply amount weighting if configured
      return this.config.weightByAmount ? weightedContribution : weightedContribution / decision.amount;
    }, 0);
  }

  /**
   * Calculate APY impact for a group of decisions
   */
  private calculateApyImpact(decisions: StrategyDecision[]): number {
    if (decisions.length === 0) return 0;
    
    const totalWeightedApy = decisions.reduce((sum, decision) => {
      const actualApy = decision.actualApy || decision.expectedApy;
      const effectiveConfidence = this.getDecisionEffectiveConfidence(decision);
      return sum + (actualApy * effectiveConfidence);
    }, 0);
    
    const totalConfidence = decisions.reduce((sum, decision) => sum + this.getDecisionEffectiveConfidence(decision), 0);
    
    return totalConfidence > 0 ? totalWeightedApy / totalConfidence : 0;
  }

  /**
   * Calculate average confidence for decisions
   */
  private calculateAverageConfidence(decisions: StrategyDecision[]): number {
    if (decisions.length === 0) return 0;
    
    const totalConfidence = decisions.reduce((sum, decision) => sum + this.getDecisionEffectiveConfidence(decision), 0);
    return totalConfidence / decisions.length;
  }

  private calculateRewardSourceMix(
    attributionBreakdown: AttributionBreakdown[],
  ): RewardSourceMixEntry[] {
    const contributionBySource: Record<RewardSource, number> = {
      base_protocol_yield: 0,
      incentive_emissions: 0,
      fees: 0,
      tactical_routing: 0,
    };

    const weightedConfidenceBySource: Record<RewardSource, number> = {
      base_protocol_yield: 0,
      incentive_emissions: 0,
      fees: 0,
      tactical_routing: 0,
    };

    for (const breakdown of attributionBreakdown) {
      const decisionType = breakdown.decisionType;
      const shares = REWARD_SOURCE_SHARES[decisionType] ?? [
        { rewardSource: 'tactical_routing' as RewardSource, share: 1 },
      ];

      for (const { rewardSource, share } of shares) {
        const shareContribution = breakdown.contribution * share;
        contributionBySource[rewardSource] += shareContribution;
        weightedConfidenceBySource[rewardSource] += breakdown.confidence * shareContribution;
      }
    }

    const totalContribution = Object.values(contributionBySource).reduce((s, v) => s + v, 0);
    if (totalContribution <= 0) {
      return [];
    }

    const result: RewardSourceMixEntry[] = [];
    (Object.keys(contributionBySource) as RewardSource[]).forEach((source) => {
      const contribution = contributionBySource[source];
      if (contribution <= 0) return;
      result.push({
        rewardSource: source,
        contribution,
        percentage: (contribution / totalContribution) * 100,
        confidence:
          contribution > 0 ? weightedConfidenceBySource[source] / contribution : 0,
      });
    });

    return result.sort((a, b) => b.contribution - a.contribution);
  }

  /**
   * Assess data completeness for the time window
   */
  private assessDataCompleteness(decisions: StrategyDecision[], startTime: string, endTime: string): number {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const totalDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    
    if (totalDays === 0) return 0;
    
    // Check for data gaps
    const sortedDecisions = decisions.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    let coveredDays = 0;
    let lastCoverageEnd = start;
    
    for (const decision of sortedDecisions) {
      const decisionStart = new Date(decision.timestamp);
      const decisionEnd = new Date(decision.timestamp);
      decisionEnd.setDate(decisionEnd.getDate() + decision.duration);
      
      // Check for gaps
      const gapDays = Math.ceil((decisionStart.getTime() - lastCoverageEnd.getTime()) / (1000 * 60 * 60 * 24));
      
      if (gapDays <= this.config.maxDataGapDays) {
        coveredDays += decision.duration;
        lastCoverageEnd = decisionEnd > lastCoverageEnd ? decisionEnd : lastCoverageEnd;
      }
    }
    
    return Math.min(coveredDays / totalDays, 1);
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<AttributionConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): AttributionConfig {
    return { ...this.config };
  }

  /**
   * Clear cache for specific wallet
   */
  clearCache(walletAddress?: string): void {
    if (walletAddress) {
      const keys = cache.keys().filter((key: string) => key.includes(walletAddress));
      keys.forEach((key: string) => cache.del(key));
    } else {
      cache.flushAll();
    }
  }
}

// ── Export singleton instance ─────────────────────────────────────────────

export const portfolioAttributionEngine = new PortfolioAttributionEngine();

// ── Helper functions ─────────────────────────────────────────────────────

/**
 * Validate attribution request parameters
 */
export function validateAttributionRequest(
  walletAddress: string,
  startTime: string,
  endTime: string,
): { valid: boolean; error?: string } {
  if (!walletAddress || walletAddress.length < 10) {
    return { valid: false, error: "Invalid wallet address" };
  }

  const start = new Date(startTime);
  const end = new Date(endTime);
  const now = new Date();

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { valid: false, error: "Invalid date format" };
  }

  if (start >= end) {
    return { valid: false, error: "Start time must be before end time" };
  }

  if (end > now) {
    return { valid: false, error: "End time cannot be in the future" };
  }

  const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  if (daysDiff > 365) {
    return { valid: false, error: "Time window cannot exceed 1 year" };
  }

  return { valid: true };
}

/**
 * Format attribution report for API response
 */
export function formatAttributionReport(report: AttributionReport): AttributionReport {
  return {
    ...report,
    attributionBreakdown: report.attributionBreakdown.map(breakdown => ({
      ...breakdown,
      contribution: Math.round(breakdown.contribution * 100) / 100,
      percentage: Math.round(breakdown.percentage * 100) / 100,
      apyImpact: Math.round(breakdown.apyImpact * 100) / 100,
      confidence: Math.round(breakdown.confidence * 100) / 100,
    })),
    rewardSourceMix: report.rewardSourceMix.map((entry) => ({
      ...entry,
      contribution: Math.round(entry.contribution * 100) / 100,
      percentage: Math.round(entry.percentage * 100) / 100,
      confidence: Math.round(entry.confidence * 100) / 100,
    })),
    totalReturn: Math.round(report.totalReturn * 100) / 100,
    totalDeposited: Math.round(report.totalDeposited * 100) / 100,
    dataCompleteness: Math.round(report.dataCompleteness * 100) / 100,
  };
}
