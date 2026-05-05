import NodeCache from "node-cache";
import { freezeService } from "./freezeService";
import {
  strategyStateTransitionAuditService,
  type StrategyLifecycleState,
} from "./strategyStateTransitionAuditService";

// ── Types ───────────────────────────────────────────────────────────────

export interface HealthSignal {
  source: 'contract' | 'backend' | 'monitoring' | 'market';
  metric: string;
  value: number;
  weight: number;
  threshold: {
    critical: number;
    warning: number;
    good: number;
  };
  timestamp: string;
  reliability: number; // 0-1
}

export interface StrategyHealthMetrics {
  contractSafety: number; // 0-1
  dataFreshness: number; // 0-1
  providerUptime: number; // 0-1
  liquidityConditions: number; // 0-1
  executionOutcomes: number; // 0-1
  volatilityIndex: number; // 0-1
  errorRate: number; // 0-1
  latency: number; // milliseconds
}

export interface StrategyHealthScore {
  strategyId: string;
  strategyName: string;
  overallScore: number; // 0-100
  metrics: StrategyHealthMetrics;
  status: 'healthy' | 'degraded' | 'critical' | 'disabled';
  signals: HealthSignal[];
  lastUpdated: string;
  trend: 'improving' | 'stable' | 'declining';
  recommendations: string[];
  suppressUntil?: string;
}

export interface HealthThresholds {
  healthy: number;
  degraded: number;
  critical: number;
  disableThreshold: number;
}

export interface HealthConfig {
  scoreUpdateIntervalMinutes: number;
  trendWindowHours: number;
  signalReliabilityThreshold: number;
  autoDisableThreshold: number;
  suppressDurationHours: number;
  cacheResultsMinutes: number;
}

// ── Configuration ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: HealthConfig = {
  scoreUpdateIntervalMinutes: 5,
  trendWindowHours: 24,
  signalReliabilityThreshold: 0.7,
  autoDisableThreshold: 25,
  suppressDurationHours: 6,
  cacheResultsMinutes: 10,
};

const DEFAULT_THRESHOLDS: HealthThresholds = {
  healthy: 80,
  degraded: 60,
  critical: 40,
  disableThreshold: 25,
};

const cache = new NodeCache({
  stdTTL: DEFAULT_CONFIG.cacheResultsMinutes * 60,
  checkperiod: 60,
  useClones: false,
});

// ── Health Score Engine ─────────────────────────────────────────────────

export class StrategyHealthEngine {
  private config: HealthConfig;
  private thresholds: HealthThresholds;
  private historicalScores: Map<string, StrategyHealthScore[]>;

  constructor(config: Partial<HealthConfig> = {}, thresholds: Partial<HealthThresholds> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.historicalScores = new Map();
  }

  /**
   * Calculate health score for a strategy
   */
  async calculateHealthScore(strategyId: string, strategyName: string): Promise<StrategyHealthScore> {
    const cacheKey = `health:${strategyId}`;
    const cached = cache.get<StrategyHealthScore>(cacheKey);
    
    if (cached && !this.isScoreStale(cached.lastUpdated)) {
      return cached;
    }

    if (freezeService.isFrozen()) {
      throw new Error("Health service is frozen");
    }

    try {
      // Collect health signals from all sources
      const signals = await this.collectHealthSignals(strategyId);
      
      // Calculate individual metrics
      const metrics = await this.calculateMetrics(signals);
      
      // Calculate overall score
      const overallScore = this.calculateOverallScore(metrics, signals);
      
      // Determine status
      const status = this.determineHealthStatus(overallScore, metrics);

      // Map health status + freeze flag into lifecycle state for audit graph.
      const lifecycleState: StrategyLifecycleState = freezeService.isFrozen(strategyId)
        ? "frozen"
        : status === "healthy"
          ? "healthy"
          : "degraded";

      // #371 append-only lifecycle transition audit (must never block health rendering).
      try {
        strategyStateTransitionAuditService.updateFromHealth(
          strategyId,
          lifecycleState,
          `health_status=${status}`,
        );
      } catch (err) {
        console.warn(
          `Failed to record lifecycle transition for ${strategyId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      
      // Analyze trend
      const trend = this.analyzeTrend(strategyId, overallScore);
      
      // Generate recommendations
      const recommendations = this.generateRecommendations(status, metrics, signals);
      
      // Check suppression status
      const suppressUntil = this.checkSuppressionStatus(strategyId);

      const healthScore: StrategyHealthScore = {
        strategyId,
        strategyName,
        overallScore,
        metrics,
        status,
        signals,
        lastUpdated: new Date().toISOString(),
        trend,
        recommendations,
        suppressUntil,
      };

      // Update historical data
      this.updateHistoricalScores(strategyId, healthScore);
      
      // Cache the result
      cache.set(cacheKey, healthScore);
      
      // Auto-disable if necessary
      if (overallScore < this.config.autoDisableThreshold && !suppressUntil) {
        await this.handleAutoDisable(strategyId, healthScore);
      }

      return healthScore;
    } catch (error) {
      console.error(`Failed to calculate health score for ${strategyId}:`, error);
      
      // Return degraded score on error
      return {
        strategyId,
        strategyName,
        overallScore: 0,
        metrics: this.getDefaultMetrics(),
        status: 'critical',
        signals: [],
        lastUpdated: new Date().toISOString(),
        trend: 'declining',
        recommendations: ['Manual investigation required - health check failed'],
      };
    }
  }

  /**
   * Collect health signals from all sources
   */
  private async collectHealthSignals(strategyId: string): Promise<HealthSignal[]> {
    const signals: HealthSignal[] = [];

    try {
      // Contract safety signals
      const contractSignals = await this.getContractSafetySignals(strategyId);
      signals.push(...contractSignals);

      // Backend signals
      const backendSignals = await this.getBackendSignals(strategyId);
      signals.push(...backendSignals);

      // Monitoring signals
      const monitoringSignals = await this.getMonitoringSignals(strategyId);
      signals.push(...monitoringSignals);

      // Market signals
      const marketSignals = await this.getMarketSignals(strategyId);
      signals.push(...marketSignals);

    } catch (error) {
      console.error(`Failed to collect signals for ${strategyId}:`, error);
    }

    // Filter by reliability threshold
    return signals.filter(signal => signal.reliability >= this.config.signalReliabilityThreshold);
  }

  /**
   * Get contract safety signals
   */
  private async getContractSafetySignals(_strategyId: string): Promise<HealthSignal[]> {
    // Mock implementation - would query contract monitoring
    return [
      {
        source: 'contract',
        metric: 'audit_score',
        value: 0.95,
        weight: 0.3,
        threshold: { critical: 0.5, warning: 0.7, good: 0.9 },
        timestamp: new Date().toISOString(),
        reliability: 0.9,
      },
      {
        source: 'contract',
        metric: 'bug_count',
        value: 0.1, // Normalized (0 = no bugs, 1 = many bugs)
        weight: 0.2,
        threshold: { critical: 0.8, warning: 0.4, good: 0.1 },
        timestamp: new Date().toISOString(),
        reliability: 0.85,
      },
    ];
  }

  /**
   * Get backend signals
   */
  private async getBackendSignals(_strategyId: string): Promise<HealthSignal[]> {
    // Mock implementation - would query backend metrics
    return [
      {
        source: 'backend',
        metric: 'api_response_time',
        value: 150, // milliseconds
        weight: 0.15,
        threshold: { critical: 1000, warning: 500, good: 200 },
        timestamp: new Date().toISOString(),
        reliability: 0.95,
      },
      {
        source: 'backend',
        metric: 'error_rate',
        value: 0.02, // 2%
        weight: 0.25,
        threshold: { critical: 0.1, warning: 0.05, good: 0.01 },
        timestamp: new Date().toISOString(),
        reliability: 0.9,
      },
    ];
  }

  /**
   * Get monitoring signals
   */
  private async getMonitoringSignals(_strategyId: string): Promise<HealthSignal[]> {
    // Mock implementation - would query monitoring systems
    return [
      {
        source: 'monitoring',
        metric: 'uptime_percentage',
        value: 0.998, // 99.8%
        weight: 0.2,
        threshold: { critical: 0.95, warning: 0.98, good: 0.995 },
        timestamp: new Date().toISOString(),
        reliability: 0.95,
      },
      {
        source: 'monitoring',
        metric: 'data_freshness',
        value: 0.95, // 95% fresh
        weight: 0.15,
        threshold: { critical: 0.7, warning: 0.85, good: 0.95 },
        timestamp: new Date().toISOString(),
        reliability: 0.9,
      },
    ];
  }

  /**
   * Get market signals
   */
  private async getMarketSignals(_strategyId: string): Promise<HealthSignal[]> {
    // Mock implementation - would query market data
    return [
      {
        source: 'market',
        metric: 'liquidity_depth',
        value: 0.85, // Normalized liquidity score
        weight: 0.2,
        threshold: { critical: 0.3, warning: 0.6, good: 0.8 },
        timestamp: new Date().toISOString(),
        reliability: 0.8,
      },
      {
        source: 'market',
        metric: 'volatility_index',
        value: 0.3, // Normalized volatility (0 = low, 1 = high)
        weight: 0.1,
        threshold: { critical: 0.8, warning: 0.5, good: 0.3 },
        timestamp: new Date().toISOString(),
        reliability: 0.85,
      },
    ];
  }

  /**
   * Analyze trend based on historical scores
   */
  private analyzeTrend(strategyId: string, currentScore: number): 'improving' | 'stable' | 'declining' {
    const history = this.historicalScores.get(strategyId) || [];
    
    if (history.length < 2) return 'stable';

    const recentScores = history.slice(-5).map(h => h.overallScore);
    const averageRecent = recentScores.reduce((sum, score) => sum + score, 0) / recentScores.length;
    
    const difference = currentScore - averageRecent;
    
    if (difference > 5) return 'improving';
    if (difference < -5) return 'declining';
    return 'stable';
  }

  /**
   * Generate recommendations based on health status and metrics
   */
  private generateRecommendations(
    status: 'healthy' | 'degraded' | 'critical' | 'disabled',
    metrics: StrategyHealthMetrics,
    _signals: HealthSignal[],
  ): string[] {
    const recommendations: string[] = [];

    if (status === 'disabled') {
      recommendations.push('Strategy auto-disabled due to poor health');
      recommendations.push('Manual review required before re-enabling');
    }

    if (status === 'critical') {
      recommendations.push('Immediate attention required');
    }

    // Specific metric-based recommendations
    if (metrics.contractSafety < 0.7) {
      recommendations.push('Review contract security and audit status');
    }

    if (metrics.dataFreshness < 0.8) {
      recommendations.push('Check data pipeline and update mechanisms');
    }

    if (metrics.providerUptime < 0.95) {
      recommendations.push('Investigate provider connectivity issues');
    }

    if (metrics.liquidityConditions < 0.6) {
      recommendations.push('Monitor liquidity depth and consider position sizing');
    }

    if (metrics.executionOutcomes < 0.8) {
      recommendations.push('Review recent execution failures and adjust parameters');
    }

    if (metrics.errorRate > 0.05) {
      recommendations.push('Address elevated error rates in backend systems');
    }

    if (metrics.latency > 500) {
      recommendations.push('Optimize API response times');
    }

    if (recommendations.length === 0 && status === 'degraded') {
      recommendations.push('Monitor closely for further degradation');
    }

    return recommendations;
  }

  /**
   * Check if score is stale
   */
  private isScoreStale(lastUpdated: string): boolean {
    const updateInterval = this.config.scoreUpdateIntervalMinutes * 60 * 1000;
    return Date.now() - new Date(lastUpdated).getTime() > updateInterval;
  }

  /**
   * Update historical scores
   */
  private updateHistoricalScores(strategyId: string, score: StrategyHealthScore): void {
    const history = this.historicalScores.get(strategyId) || [];
    const updated = [...history, score];
    
    // Keep only recent scores within trend window
    const cutoffTime = Date.now() - (this.config.trendWindowHours * 60 * 60 * 1000);
    const filtered = updated.filter(s => new Date(s.lastUpdated).getTime() > cutoffTime);
    
    this.historicalScores.set(strategyId, filtered);
  }

  /**
   * Check suppression status
   */
  private checkSuppressionStatus(_strategyId: string): string | undefined {
    // Mock implementation - would check suppression database
    return undefined;
  }

  /**
   * Handle auto-disable of unhealthy strategies
   */
  private async handleAutoDisable(strategyId: string, healthScore: StrategyHealthScore): Promise<void> {
    console.warn(`Auto-disabling strategy ${strategyId} due to health score: ${healthScore.overallScore}`);
    
    // In reality, this would call strategy management service
    // to disable the strategy and notify operators
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<HealthConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Update thresholds
   */
  updateThresholds(newThresholds: Partial<HealthThresholds>): void {
    this.thresholds = { ...this.thresholds, ...newThresholds };
  }

  /**
   * Get current configuration
   */
  getConfig(): HealthConfig {
    return { ...this.config };
  }

  /**
   * Get current thresholds
   */
  getThresholds(): HealthThresholds {
    return { ...this.thresholds };
  }

  /**
   * Clear cache
   */
  clearCache(strategyId?: string): void {
    if (strategyId) {
      cache.del(`health:${strategyId}`);
    } else {
      cache.flushAll();
    }
  }

  /**
   * Get health scores for multiple strategies
   */
  async getHealthScores(strategyIds: string[]): Promise<StrategyHealthScore[]> {
    const promises = strategyIds.map(id => {
      const strategyName = `Strategy ${id}`;
      return this.calculateHealthScore(id, strategyName);
    });
    
    return Promise.all(promises);
  }
}

// ── Export singleton instance ─────────────────────────────────────────────

export const strategyHealthEngine = new StrategyHealthEngine();

// ── Helper functions ─────────────────────────────────────────────────────

/**
 * Format health score for API response
 */
export function formatHealthScore(score: StrategyHealthScore): StrategyHealthScore {
  return {
    ...score,
    overallScore: Math.round(score.overallScore),
    metrics: {
      ...score.metrics,
      contractSafety: Math.round(score.metrics.contractSafety * 100) / 100,
      dataFreshness: Math.round(score.metrics.dataFreshness * 100) / 100,
      providerUptime: Math.round(score.metrics.providerUptime * 100) / 100,
      liquidityConditions: Math.round(score.metrics.liquidityConditions * 100) / 100,
      executionOutcomes: Math.round(score.metrics.executionOutcomes * 100) / 100,
      volatilityIndex: Math.round(score.metrics.volatilityIndex * 100) / 100,
      errorRate: Math.round(score.metrics.errorRate * 10000) / 10000, // As percentage
      latency: Math.round(score.metrics.latency),
    },
  };
}

/**
 * Check if strategy is safe for execution
 */
export function isStrategySafeForExecution(healthScore: StrategyHealthScore): boolean {
  return healthScore.status === 'healthy' || 
         (healthScore.status === 'degraded' && healthScore.overallScore >= 50);
}

/**
 * Get critical health alerts
 */
export function getCriticalHealthAlerts(scores: StrategyHealthScore[]): string[] {
  const alerts: string[] = [];
  
  scores.forEach(score => {
    if (score.status === 'critical' || score.status === 'disabled') {
      alerts.push(`${score.strategyName}: ${score.status.toUpperCase()} (Score: ${score.overallScore})`);
    }
  });
  
  return alerts;
}
