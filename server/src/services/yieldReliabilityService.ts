import NodeCache from "node-cache";
import { freezeService } from "./freezeService";

// ── Types ───────────────────────────────────────────────────────────────

export interface DataSourceMetrics {
  freshness: number; // 0-1, how recent is the data
  consistency: number; // 0-1, consistency across sources
  historicalUptime: number; // 0-1, uptime percentage
  anomalyRate: number; // 0-1, rate of anomalous readings
  latency: number; // milliseconds
  errorRate: number; // 0-1, rate of failed requests
  coverage: number; // 0-1, percentage of expected data points
  accuracy: number; // 0-1, accuracy compared to trusted sources
}

export interface ReliabilitySignals {
  lastSuccessfulFetch: string;
  consecutiveFailures: number;
  totalRequests: number;
  successfulRequests: number;
  averageResponseTime: number;
  lastAnomaly: string;
  dataPointsLast24h: number;
  expectedDataPoints24h: number;
  varianceFromMean: number;
  crossSourceDeviation: number;
}

export interface DataSourceReliability {
  providerId: string;
  providerName: string;
  dataSource: string;
  reliabilityScore: number; // 0-100
  metrics: DataSourceMetrics;
  signals: ReliabilitySignals;
  status: 'high' | 'medium' | 'low' | 'unreliable';
  lastUpdated: string;
  trend: 'improving' | 'stable' | 'declining';
  recommendations: string[];
  failoverPriority: number;
  weightInRecommendations: number;
}

export interface ReliabilityConfig {
  scoreUpdateIntervalMinutes: number;
  trendWindowHours: number;
  minimumDataPoints: number;
  highReliabilityThreshold: number;
  mediumReliabilityThreshold: number;
  lowReliabilityThreshold: number;
  anomalyDetectionSensitivity: number;
  cacheResultsMinutes: number;
}

export interface ProviderComparison {
  providerId: string;
  reliabilityScore: number;
  accuracyRank: number;
  speedRank: number;
  uptimeRank: number;
  overallRank: number;
}

// ── Configuration ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: ReliabilityConfig = {
  scoreUpdateIntervalMinutes: 10,
  trendWindowHours: 48,
  minimumDataPoints: 24,
  highReliabilityThreshold: 85,
  mediumReliabilityThreshold: 70,
  lowReliabilityThreshold: 50,
  anomalyDetectionSensitivity: 0.1,
  cacheResultsMinutes: 15,
};

const cache = new NodeCache({
  stdTTL: DEFAULT_CONFIG.cacheResultsMinutes * 60,
  checkperiod: 60,
  useClones: false,
});

// ── Reliability Engine ─────────────────────────────────────────────────

export class YieldReliabilityEngine {
  private config: ReliabilityConfig;
  private historicalData: Map<string, DataSourceReliability[]>;

  constructor(config: Partial<ReliabilityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.historicalData = new Map();
  }

  /**
   * Calculate reliability score for a data provider
   */
  async calculateReliabilityScore(providerId: string, providerName: string, dataSource: string): Promise<DataSourceReliability> {
    const cacheKey = `reliability:${providerId}`;
    const cached = cache.get<DataSourceReliability>(cacheKey);
    
    if (cached && !this.isScoreStale(cached.lastUpdated)) {
      return cached;
    }

    if (freezeService.isFrozen()) {
      throw new Error("Reliability service is frozen");
    }

    try {
      // Collect reliability signals
      const signals = await this.collectReliabilitySignals(providerId, dataSource);
      
      // Calculate individual metrics
      const metrics = await this.calculateReliabilityMetrics(providerId, dataSource, signals);
      
      // Calculate overall reliability score
      const reliabilityScore = this.calculateOverallReliabilityScore(metrics);
      
      // Determine status
      const status = this.determineReliabilityStatus(reliabilityScore);
      
      // Analyze trend
      const trend = this.analyzeReliabilityTrend(providerId, reliabilityScore);
      
      // Generate recommendations
      const recommendations = this.generateReliabilityRecommendations(status, metrics, signals);
      
      // Calculate failover priority and recommendation weight
      const failoverPriority = this.calculateFailoverPriority(reliabilityScore, metrics);
      const weightInRecommendations = this.calculateRecommendationWeight(reliabilityScore, status);

      const reliability: DataSourceReliability = {
        providerId,
        providerName,
        dataSource,
        reliabilityScore,
        metrics,
        signals,
        status,
        lastUpdated: new Date().toISOString(),
        trend,
        recommendations,
        failoverPriority,
        weightInRecommendations,
      };

      // Update historical data
      this.updateHistoricalReliability(providerId, reliability);
      
      // Cache the result
      cache.set(cacheKey, reliability);

      return reliability;
    } catch (error) {
      console.error(`Failed to calculate reliability for ${providerId}:`, error);
      
      // Return unreliable score on error
      return {
        providerId,
        providerName,
        dataSource,
        reliabilityScore: 0,
        metrics: this.getDefaultMetrics(),
        signals: this.getDefaultSignals(),
        status: 'unreliable',
        lastUpdated: new Date().toISOString(),
        trend: 'declining',
        recommendations: ['Manual investigation required - reliability check failed'],
        failoverPriority: 999,
        weightInRecommendations: 0,
      };
    }
  }

  /**
   * Collect reliability signals from monitoring systems
   */
  private async collectReliabilitySignals(providerId: string, dataSource: string): Promise<ReliabilitySignals> {
    // Mock implementation - would query monitoring systems
    return {
      lastSuccessfulFetch: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
      consecutiveFailures: 0,
      totalRequests: 1000,
      successfulRequests: 985,
      averageResponseTime: 250, // milliseconds
      lastAnomaly: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      dataPointsLast24h: 142,
      expectedDataPoints24h: 144,
      varianceFromMean: 0.02,
      crossSourceDeviation: 0.05,
    };
  }

  /**
   * Calculate reliability metrics from signals
   */
  private async calculateReliabilityMetrics(
    providerId: string,
    dataSource: string,
    signals: ReliabilitySignals,
  ): Promise<DataSourceMetrics> {
    const metrics = this.getDefaultMetrics();

    // Freshness calculation
    const timeSinceLastFetch = Date.now() - new Date(signals.lastSuccessfulFetch).getTime();
    const maxAgeMinutes = 30; // Consider data stale after 30 minutes
    metrics.freshness = Math.max(0, 1 - (timeSinceLastFetch / (maxAgeMinutes * 60 * 1000)));

    // Consistency calculation
    metrics.consistency = Math.max(0, 1 - signals.crossSourceDeviation);

    // Historical uptime
    metrics.historicalUptime = signals.totalRequests > 0 
      ? signals.successfulRequests / signals.totalRequests 
      : 0;

    // Anomaly rate (based on variance and recent anomalies)
    const timeSinceLastAnomaly = Date.now() - new Date(signals.lastAnomaly).getTime();
    const recentAnomalyPenalty = timeSinceLastAnomaly < 60 * 60 * 1000 ? 0.2 : 0; // 20% penalty for recent anomaly
    metrics.anomalyRate = Math.min(1, signals.varianceFromMean + recentAnomalyPenalty);

    // Latency (normalized)
    const maxAcceptableLatency = this.config.maxAcceptableLatency;
    metrics.latency = signals.averageResponseTime;
    
    // Error rate
    metrics.errorRate = signals.totalRequests > 0 
      ? (signals.totalRequests - signals.successfulRequests) / signals.totalRequests 
      : 0;

    // Coverage
    metrics.coverage = signals.expectedDataPoints24h > 0 
      ? signals.dataPointsLast24h / signals.expectedDataPoints24h 
      : 0;

    // Accuracy (mock - would compare with trusted sources)
    metrics.accuracy = 0.95; // 95% accuracy

    return metrics;
  }

  /**
   * Calculate overall reliability score
   */
  private calculateOverallReliabilityScore(metrics: DataSourceMetrics): number {
    // Weighted scoring for different metrics
    const weights = {
      freshness: 0.15,
      consistency: 0.20,
      historicalUptime: 0.25,
      anomalyRate: 0.15,
      errorRate: 0.15,
      coverage: 0.10,
    };

    let score = 0;
    let totalWeight = 0;

    // Apply weights (invert metrics where lower is better)
    Object.entries(weights).forEach(([metric, weight]) => {
      let value = metrics[metric as keyof DataSourceMetrics] as number;
      
      // Invert metrics where lower is better
      if (metric === 'anomalyRate' || metric === 'errorRate') {
        value = 1 - Math.min(1, value);
      }
      
      // Normalize latency (convert to 0-1 scale)
      if (metric === 'latency') {
        value = Math.max(0, 1 - (value / maxAcceptableLatency));
      }

      score += value * weight;
      totalWeight += weight;
    });

    return Math.round((score / totalWeight) * 100);
  }

  /**
   * Determine reliability status
   */
  private determineReliabilityStatus(score: number): 'high' | 'medium' | 'low' | 'unreliable' {
    if (score >= this.config.highReliabilityThreshold) return 'high';
    if (score >= this.config.mediumReliabilityThreshold) return 'medium';
    if (score >= this.config.lowReliabilityThreshold) return 'low';
    return 'unreliable';
  }

  /**
   * Analyze reliability trend
   */
  private analyzeReliabilityTrend(providerId: string, currentScore: number): 'improving' | 'stable' | 'declining' {
    const history = this.historicalData.get(providerId) || [];
    
    if (history.length < 3) return 'stable';

    const recentScores = history.slice(-5).map(h => h.reliabilityScore);
    const averageRecent = recentScores.reduce((sum, score) => sum + score, 0) / recentScores.length;
    
    const difference = currentScore - averageRecent;
    
    if (difference > 5) return 'improving';
    if (difference < -5) return 'declining';
    return 'stable';
  }

  /**
   * Generate reliability recommendations
   */
  private generateReliabilityRecommendations(
    status: 'high' | 'medium' | 'low' | 'unreliable',
    metrics: DataSourceMetrics,
    signals: ReliabilitySignals,
  ): string[] {
    const recommendations: string[] = [];

    if (status === 'unreliable') {
      recommendations.push('Provider is unreliable - consider disabling');
      recommendations.push('Investigate connectivity and data quality issues');
      return recommendations;
    }

    // Specific metric-based recommendations
    if (metrics.freshness < 0.8) {
      recommendations.push('Data is stale - check update frequency');
    }

    if (metrics.consistency < 0.7) {
      recommendations.push('Data inconsistency detected - verify source integrity');
    }

    if (metrics.historicalUptime < 0.95) {
      recommendations.push('Low uptime - monitor provider availability');
    }

    if (metrics.anomalyRate > 0.2) {
      recommendations.push('High anomaly rate - investigate data quality');
    }

    if (metrics.errorRate > 0.1) {
      recommendations.push('High error rate - check API integration');
    }

    if (metrics.coverage < 0.8) {
      recommendations.push('Incomplete data coverage - verify data pipeline');
    }

    if (metrics.latency > 1000) {
      recommendations.push('High latency - consider optimization or alternative provider');
    }

    if (recommendations.length === 0 && status === 'medium') {
      recommendations.push('Monitor for performance improvements');
    }

    return recommendations;
  }

  /**
   * Calculate failover priority (lower number = higher priority)
   */
  private calculateFailoverPriority(reliabilityScore: number, metrics: DataSourceMetrics): number {
    // Base priority from reliability score (inverted)
    let priority = 100 - reliabilityScore;

    // Adjust for critical factors
    if (metrics.historicalUptime < 0.9) priority += 50;
    if (metrics.errorRate > 0.1) priority += 30;
    if (metrics.freshness < 0.5) priority += 20;

    return Math.max(1, Math.min(999, priority));
  }

  /**
   * Calculate weight in recommendations (0-1)
   */
  private calculateRecommendationWeight(reliabilityScore: number, status: 'high' | 'medium' | 'low' | 'unreliable'): number {
    switch (status) {
      case 'high': return 1.0;
      case 'medium': return 0.7;
      case 'low': return 0.3;
      case 'unreliable': return 0.0;
      default: return 0.5;
    }
  }

  /**
   * Get default metrics
   */
  private getDefaultMetrics(): DataSourceMetrics {
    return {
      freshness: 0.8,
      consistency: 0.8,
      historicalUptime: 0.8,
      anomalyRate: 0.1,
      latency: 500,
      errorRate: 0.05,
      coverage: 0.8,
      accuracy: 0.8,
    };
  }

  /**
   * Get default signals
   */
  private getDefaultSignals(): ReliabilitySignals {
    return {
      lastSuccessfulFetch: new Date().toISOString(),
      consecutiveFailures: 0,
      totalRequests: 0,
      successfulRequests: 0,
      averageResponseTime: 0,
      lastAnomaly: new Date().toISOString(),
      dataPointsLast24h: 0,
      expectedDataPoints24h: 0,
      varianceFromMean: 0,
      crossSourceDeviation: 0,
    };
  }

  /**
   * Check if score is stale
   */
  private isScoreStale(lastUpdated: string): boolean {
    const updateInterval = this.config.scoreUpdateIntervalMinutes * 60 * 1000;
    return Date.now() - new Date(lastUpdated).getTime() > updateInterval;
  }

  /**
   * Update historical reliability data
   */
  private updateHistoricalReliability(providerId: string, reliability: DataSourceReliability): void {
    const history = this.historicalData.get(providerId) || [];
    const updated = [...history, reliability];
    
    // Keep only recent scores within trend window
    const cutoffTime = Date.now() - (this.config.trendWindowHours * 60 * 60 * 1000);
    const filtered = updated.filter(r => new Date(r.lastUpdated).getTime() > cutoffTime);
    
    this.historicalData.set(providerId, filtered);
  }

  /**
   * Get reliability scores for multiple providers
   */
  async getReliabilityScores(providers: Array<{id: string, name: string, source: string}>): Promise<DataSourceReliability[]> {
    const promises = providers.map(provider => 
      this.calculateReliabilityScore(provider.id, provider.name, provider.source)
    );
    
    return Promise.all(promises);
  }

  /**
   * Compare providers and rank them
   */
  async compareProviders(providers: Array<{id: string, name: string, source: string}>): Promise<ProviderComparison[]> {
    const reliabilityScores = await this.getReliabilityScores(providers);
    
    // Calculate ranks for different criteria
    const accuracyRank = this.rankByMetric(reliabilityScores, r => r.metrics.accuracy);
    const speedRank = this.rankByMetric(reliabilityScores, r => 1 / (r.metrics.latency + 1)); // Invert latency
    const uptimeRank = this.rankByMetric(reliabilityScores, r => r.metrics.historicalUptime);
    
    return reliabilityScores.map((reliability, index) => ({
      providerId: reliability.providerId,
      reliabilityScore: reliability.reliabilityScore,
      accuracyRank: accuracyRank[index],
      speedRank: speedRank[index],
      uptimeRank: uptimeRank[index],
      overallRank: this.calculateOverallRank(accuracyRank[index], speedRank[index], uptimeRank[index]),
    }));
  }

  /**
   * Rank providers by a metric
   */
  private rankByMetric<T>(items: T[], getValue: (item: T) => number): number[] {
    const sorted = items
      .map((item, index) => ({ index, value: getValue(item) }))
      .sort((a, b) => b.value - a.value);
    
    const ranks = new Array(items.length);
    sorted.forEach((item, rank) => {
      ranks[item.index] = rank + 1;
    });
    
    return ranks;
  }

  /**
   * Calculate overall rank from individual ranks
   */
  private calculateOverallRank(accuracyRank: number, speedRank: number, uptimeRank: number): number {
    // Weighted average of ranks
    const weights = { accuracy: 0.4, speed: 0.2, uptime: 0.4 };
    const weightedRank = (accuracyRank * weights.accuracy + 
                          speedRank * weights.speed + 
                          uptimeRank * weights.uptime);
    return Math.round(weightedRank);
  }

  /**
   * Get providers suitable for recommendations
   */
  async getProvidersForRecommendations(minReliability: number = 70): Promise<DataSourceReliability[]> {
    const allProviders = await this.getAllProviderIds();
    const reliabilityScores = await this.getReliabilityScores(allProviders);
    
    return reliabilityScores
      .filter(provider => provider.reliabilityScore >= minReliability)
      .sort((a, b) => b.reliabilityScore - a.reliabilityScore);
  }

  /**
   * Get all provider IDs (mock implementation)
   */
  private async getAllProviderIds(): Promise<Array<{id: string, name: string, source: string}>> {
    return [
      { id: 'blend_api', name: 'Blend Protocol', source: 'api' },
      { id: 'soroswap_api', name: 'Soroswap', source: 'api' },
      { id: 'defindex_api', name: 'DeFindex', source: 'api' },
      { id: 'stellar_expert', name: 'Stellar Expert', source: 'oracle' },
      { id: 'coingecko', name: 'CoinGecko', source: 'oracle' },
    ];
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<ReliabilityConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): ReliabilityConfig {
    return { ...this.config };
  }

  /**
   * Clear cache
   */
  clearCache(providerId?: string): void {
    if (providerId) {
      cache.del(`reliability:${providerId}`);
    } else {
      cache.flushAll();
    }
  }
}

// ── Export singleton instance ─────────────────────────────────────────────

export const yieldReliabilityEngine = new YieldReliabilityEngine();

// ── Helper functions ─────────────────────────────────────────────────────

/**
 * Format reliability score for API response
 */
export function formatReliabilityScore(reliability: DataSourceReliability): DataSourceReliability {
  return {
    ...reliability,
    reliabilityScore: Math.round(reliability.reliabilityScore),
    metrics: {
      ...reliability.metrics,
      freshness: Math.round(reliability.metrics.freshness * 100) / 100,
      consistency: Math.round(reliability.metrics.consistency * 100) / 100,
      historicalUptime: Math.round(reliability.metrics.historicalUptime * 100) / 100,
      anomalyRate: Math.round(reliability.metrics.anomalyRate * 100) / 100,
      errorRate: Math.round(reliability.metrics.errorRate * 10000) / 10000, // As percentage
      coverage: Math.round(reliability.metrics.coverage * 100) / 100,
      accuracy: Math.round(reliability.metrics.accuracy * 100) / 100,
      latency: Math.round(reliability.metrics.latency),
    },
  };
}

/**
 * Check if provider is reliable enough for recommendations
 */
export function isProviderReliable(reliability: DataSourceReliability, minScore: number = 70): boolean {
  return reliability.reliabilityScore >= minScore && 
         reliability.status !== 'unreliable' &&
         reliability.metrics.errorRate < 0.1;
}

/**
 * Get weighted provider selection for recommendations
 */
export function getWeightedProviderSelection(providers: DataSourceReliability[]): DataSourceReliability[] {
  return providers
    .filter(p => isProviderReliable(p))
    .sort((a, b) => {
      // Primary sort by reliability score
      const scoreDiff = b.reliabilityScore - a.reliabilityScore;
      if (Math.abs(scoreDiff) > 5) return scoreDiff;
      
      // Secondary sort by recommendation weight
      return b.weightInRecommendations - a.weightInRecommendations;
    });
}

/**
 * Detect anomalies in provider data
 */
export function detectAnomalies(currentValue: number, historicalValues: number[], sensitivity: number = 0.1): boolean {
  if (historicalValues.length < 10) return false;
  
  const mean = historicalValues.reduce((sum, val) => sum + val, 0) / historicalValues.length;
  const variance = historicalValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / historicalValues.length;
  const standardDeviation = Math.sqrt(variance);
  
  const zScore = Math.abs(currentValue - mean) / standardDeviation;
  return zScore > (1 / sensitivity); // Higher sensitivity = lower threshold
}
