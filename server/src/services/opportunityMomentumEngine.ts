/**
 * Multi-Window Opportunity Momentum Engine
 * 
 * Scores opportunities across short, medium, and long windows instead of 
 * relying on single-point APY snapshots. Combines momentum with confidence 
 * and liquidity factors for comprehensive opportunity ranking.
 */

export interface MomentumWindow {
  name: 'short' | 'medium' | 'long';
  durationMs: number;
  weight: number;
}

export interface OpportunitySnapshot {
  timestamp: number;
  protocolName: string;
  apy: number;
  tvl: number;
  confidence: number;
  liquidityScore: number;
  riskScore: number;
}

export interface MomentumMetrics {
  window: MomentumWindow;
  apyTrend: number; // -1 to 1, negative = declining, positive = rising
  tvlTrend: number;
  confidenceTrend: number;
  volatility: number; // 0 to 1, higher = more volatile
  consistency: number; // 0 to 1, higher = more consistent
  momentum: number; // Combined momentum score 0 to 1
}

export interface OpportunityMomentumScore {
  protocolName: string;
  currentApy: number;
  currentTvl: number;
  currentConfidence: number;
  currentLiquidityScore: number;
  currentRiskScore: number;
  
  // Multi-window momentum metrics
  shortWindowMomentum: MomentumMetrics;
  mediumWindowMomentum: MomentumMetrics;
  longWindowMomentum: MomentumMetrics;
  
  // Combined scores
  overallMomentum: number; // Weighted combination of all windows
  confidenceAdjustedMomentum: number; // Momentum adjusted by confidence
  liquidityAdjustedMomentum: number; // Momentum adjusted by liquidity
  finalScore: number; // Final ranking score
  
  // Classification
  momentumClass: 'rising' | 'flat' | 'declining';
  riskAdjustment: number; // Risk penalty applied to final score
  
  // Metadata
  calculatedAt: number;
  dataPoints: number; // Number of historical points used
  reliability: number; // 0 to 1, based on data completeness
}

export interface MomentumEngineConfig {
  windows: MomentumWindow[];
  minDataPoints: number;
  confidenceWeight: number;
  liquidityWeight: number;
  riskPenaltyFactor: number;
  volatilityPenalty: number;
  consistencyBonus: number;
}

export interface MomentumAnalysisResult {
  opportunities: OpportunityMomentumScore[];
  rankedOpportunities: OpportunityMomentumScore[];
  summary: {
    totalOpportunities: number;
    risingCount: number;
    flatCount: number;
    decliningCount: number;
    averageMomentum: number;
    topMomentumProtocol: string;
    analysisTimestamp: number;
  };
}

export class OpportunityMomentumEngine {
  private config: MomentumEngineConfig;
  private snapshots: Map<string, OpportunitySnapshot[]> = new Map();

  constructor(config?: Partial<MomentumEngineConfig>) {
    this.config = {
      windows: [
        { name: 'short', durationMs: 24 * 60 * 60 * 1000, weight: 0.5 }, // 1 day
        { name: 'medium', durationMs: 7 * 24 * 60 * 60 * 1000, weight: 0.3 }, // 7 days
        { name: 'long', durationMs: 30 * 24 * 60 * 60 * 1000, weight: 0.2 }, // 30 days
      ],
      minDataPoints: 3,
      confidenceWeight: 0.3,
      liquidityWeight: 0.2,
      riskPenaltyFactor: 0.15,
      volatilityPenalty: 0.1,
      consistencyBonus: 0.05,
      ...config,
    };
  }

  /**
   * Add a new opportunity snapshot
   */
  addSnapshot(snapshot: OpportunitySnapshot): void {
    const protocolSnapshots = this.snapshots.get(snapshot.protocolName) || [];
    protocolSnapshots.push(snapshot);
    
    // Keep snapshots sorted by timestamp
    protocolSnapshots.sort((a, b) => a.timestamp - b.timestamp);
    
    // Limit to reasonable history (90 days)
    const maxAge = Date.now() - (90 * 24 * 60 * 60 * 1000);
    const filteredSnapshots = protocolSnapshots.filter(s => s.timestamp > maxAge);
    
    this.snapshots.set(snapshot.protocolName, filteredSnapshots);
  }

  /**
   * Calculate momentum metrics for a specific window
   */
  private calculateWindowMomentum(
    snapshots: OpportunitySnapshot[],
    window: MomentumWindow,
    currentTime: number
  ): MomentumMetrics {
    const windowStart = currentTime - window.durationMs;
    const windowSnapshots = snapshots.filter(s => s.timestamp >= windowStart);

    if (windowSnapshots.length < 2) {
      return {
        window,
        apyTrend: 0,
        tvlTrend: 0,
        confidenceTrend: 0,
        volatility: 0,
        consistency: 0,
        momentum: 0,
      };
    }

    // Calculate trends using linear regression
    const apyTrend = this.calculateTrend(windowSnapshots.map(s => s.apy));
    const tvlTrend = this.calculateTrend(windowSnapshots.map(s => s.tvl));
    const confidenceTrend = this.calculateTrend(windowSnapshots.map(s => s.confidence));

    // Calculate volatility (coefficient of variation)
    const apyValues = windowSnapshots.map(s => s.apy);
    const apyMean = apyValues.reduce((sum, val) => sum + val, 0) / apyValues.length;
    const apyStdDev = Math.sqrt(
      apyValues.reduce((sum, val) => sum + Math.pow(val - apyMean, 2), 0) / apyValues.length
    );
    const volatility = apyMean > 0 ? Math.min(1, apyStdDev / apyMean) : 0;

    // Calculate consistency (inverse of volatility with smoothing)
    const consistency = Math.max(0, 1 - volatility);

    // Combine trends into momentum score
    const momentum = this.combineTrends(apyTrend, tvlTrend, confidenceTrend, consistency);

    return {
      window,
      apyTrend,
      tvlTrend,
      confidenceTrend,
      volatility,
      consistency,
      momentum,
    };
  }

  /**
   * Calculate linear trend (-1 to 1) for a series of values
   */
  private calculateTrend(values: number[]): number {
    if (values.length < 2) return 0;

    const n = values.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = values;

    const sumX = x.reduce((sum, val) => sum + val, 0);
    const sumY = y.reduce((sum, val) => sum + val, 0);
    const sumXY = x.reduce((sum, val, i) => sum + val * y[i], 0);
    const sumXX = x.reduce((sum, val) => sum + val * val, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const avgY = sumY / n;

    // Normalize slope to -1 to 1 range based on relative change
    if (avgY === 0) return 0;
    const relativeSlope = (slope * (n - 1)) / avgY;
    return Math.max(-1, Math.min(1, relativeSlope));
  }

  /**
   * Combine individual trends into overall momentum score
   */
  private combineTrends(
    apyTrend: number,
    tvlTrend: number,
    confidenceTrend: number,
    consistency: number
  ): number {
    // Weight APY trend most heavily, with TVL and confidence as supporting factors
    const weightedTrend = (
      apyTrend * 0.6 +
      tvlTrend * 0.25 +
      confidenceTrend * 0.15
    );

    // Apply consistency bonus
    const consistencyBonus = consistency * this.config.consistencyBonus;
    
    // Normalize to 0-1 range
    const momentum = (weightedTrend + 1) / 2 + consistencyBonus;
    
    return Math.max(0, Math.min(1, momentum));
  }

  /**
   * Calculate comprehensive momentum score for a protocol
   */
  calculateMomentumScore(protocolName: string, currentTime?: number): OpportunityMomentumScore | null {
    const snapshots = this.snapshots.get(protocolName);
    if (!snapshots || snapshots.length < this.config.minDataPoints) {
      return null;
    }

    const now = currentTime || Date.now();
    const latestSnapshot = snapshots[snapshots.length - 1];

    // Calculate momentum for each window
    const shortWindowMomentum = this.calculateWindowMomentum(snapshots, this.config.windows[0], now);
    const mediumWindowMomentum = this.calculateWindowMomentum(snapshots, this.config.windows[1], now);
    const longWindowMomentum = this.calculateWindowMomentum(snapshots, this.config.windows[2], now);

    // Calculate weighted overall momentum
    const overallMomentum = (
      shortWindowMomentum.momentum * this.config.windows[0].weight +
      mediumWindowMomentum.momentum * this.config.windows[1].weight +
      longWindowMomentum.momentum * this.config.windows[2].weight
    );

    // Apply confidence adjustment
    const confidenceAdjustedMomentum = overallMomentum * (
      1 + (latestSnapshot.confidence - 0.5) * this.config.confidenceWeight
    );

    // Apply liquidity adjustment
    const liquidityAdjustedMomentum = confidenceAdjustedMomentum * (
      1 + (latestSnapshot.liquidityScore - 0.5) * this.config.liquidityWeight
    );

    // Apply risk penalty
    const riskAdjustment = Math.max(0, 1 - latestSnapshot.riskScore * this.config.riskPenaltyFactor);
    
    // Apply volatility penalty
    const avgVolatility = (
      shortWindowMomentum.volatility * this.config.windows[0].weight +
      mediumWindowMomentum.volatility * this.config.windows[1].weight +
      longWindowMomentum.volatility * this.config.windows[2].weight
    );
    const volatilityPenalty = avgVolatility * this.config.volatilityPenalty;

    // Calculate final score
    const finalScore = Math.max(0, Math.min(1, 
      liquidityAdjustedMomentum * riskAdjustment - volatilityPenalty
    ));

    // Classify momentum
    let momentumClass: 'rising' | 'flat' | 'declining';
    if (overallMomentum > 0.6) {
      momentumClass = 'rising';
    } else if (overallMomentum < 0.4) {
      momentumClass = 'declining';
    } else {
      momentumClass = 'flat';
    }

    // Calculate reliability based on data completeness
    const reliability = Math.min(1, snapshots.length / (this.config.minDataPoints * 3));

    return {
      protocolName,
      currentApy: latestSnapshot.apy,
      currentTvl: latestSnapshot.tvl,
      currentConfidence: latestSnapshot.confidence,
      currentLiquidityScore: latestSnapshot.liquidityScore,
      currentRiskScore: latestSnapshot.riskScore,
      shortWindowMomentum,
      mediumWindowMomentum,
      longWindowMomentum,
      overallMomentum,
      confidenceAdjustedMomentum,
      liquidityAdjustedMomentum,
      finalScore,
      momentumClass,
      riskAdjustment,
      calculatedAt: now,
      dataPoints: snapshots.length,
      reliability,
    };
  }

  /**
   * Analyze all protocols and return ranked opportunities
   */
  analyzeOpportunities(currentTime?: number): MomentumAnalysisResult {
    const now = currentTime || Date.now();
    const opportunities: OpportunityMomentumScore[] = [];

    // Calculate momentum for all protocols
    for (const protocolName of this.snapshots.keys()) {
      const score = this.calculateMomentumScore(protocolName, now);
      if (score) {
        opportunities.push(score);
      }
    }

    // Rank by final score (descending)
    const rankedOpportunities = [...opportunities].sort((a, b) => b.finalScore - a.finalScore);

    // Calculate summary statistics
    const risingCount = opportunities.filter(o => o.momentumClass === 'rising').length;
    const flatCount = opportunities.filter(o => o.momentumClass === 'flat').length;
    const decliningCount = opportunities.filter(o => o.momentumClass === 'declining').length;
    
    const averageMomentum = opportunities.length > 0
      ? opportunities.reduce((sum, o) => sum + o.overallMomentum, 0) / opportunities.length
      : 0;

    const topMomentumProtocol = rankedOpportunities.length > 0
      ? rankedOpportunities[0].protocolName
      : '';

    return {
      opportunities,
      rankedOpportunities,
      summary: {
        totalOpportunities: opportunities.length,
        risingCount,
        flatCount,
        decliningCount,
        averageMomentum,
        topMomentumProtocol,
        analysisTimestamp: now,
      },
    };
  }

  /**
   * Get momentum score for specific protocols
   */
  getMomentumScores(protocolNames: string[], currentTime?: number): OpportunityMomentumScore[] {
    const now = currentTime || Date.now();
    const scores: OpportunityMomentumScore[] = [];

    for (const protocolName of protocolNames) {
      const score = this.calculateMomentumScore(protocolName, now);
      if (score) {
        scores.push(score);
      }
    }

    return scores.sort((a, b) => b.finalScore - a.finalScore);
  }

  /**
   * Update engine configuration
   */
  updateConfig(newConfig: Partial<MomentumEngineConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): MomentumEngineConfig {
    return { ...this.config };
  }

  /**
   * Clear all historical data
   */
  clearHistory(): void {
    this.snapshots.clear();
  }

  /**
   * Get available protocols
   */
  getAvailableProtocols(): string[] {
    return Array.from(this.snapshots.keys());
  }

  /**
   * Get snapshot count for a protocol
   */
  getSnapshotCount(protocolName: string): number {
    return this.snapshots.get(protocolName)?.length || 0;
  }

  /**
   * Bulk add snapshots (useful for initialization)
   */
  bulkAddSnapshots(snapshots: OpportunitySnapshot[]): void {
    for (const snapshot of snapshots) {
      this.addSnapshot(snapshot);
    }
  }
}

// Export singleton instance
export const opportunityMomentumEngine = new OpportunityMomentumEngine();