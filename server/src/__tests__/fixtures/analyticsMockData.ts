/**
 * Deterministic mock data for analytics contract tests
 * 
 * This file provides consistent, predictable test data that matches
 * the expected response structures from analytics endpoints.
 */

export interface MockAttributionReport {
  walletAddress: string;
  totalReturn: number;
  totalDeposited: number;
  attributionBreakdown: Array<{
    decisionType: string;
    contribution: number;
    percentage: number;
    apyImpact: number;
    decisions: Array<{
      id: string;
      type: string;
      timestamp: string;
      protocol: string;
      amount: number;
      expectedApy: number;
      actualApy?: number;
      duration: number;
      confidence: number;
    }>;
    confidence: number;
  }>;
  rewardSourceMix?: Array<{
    rewardSource: string;
    contribution: number;
    percentage: number;
    confidence: number;
  }>;
  timeWindow: {
    start: string;
    end: string;
  };
  generatedAt: string;
  dataCompleteness: number;
}

export interface MockCompatibilityReport {
  protocols: Array<{
    protocolName: string;
    status: 'compatible' | 'degraded' | 'incompatible';
    criticalIssues: number;
    lastChecked: string;
    version?: string;
    supportedFeatures?: string[];
  }>;
  issues: Array<{
    severity: 'critical' | 'warning' | 'info';
    protocol: string;
    message: string;
    code?: string;
    timestamp: string;
  }>;
  overallStatus: 'compatible' | 'degraded' | 'incompatible';
  generatedAt: string;
  checkDuration: number;
}

export interface MockHealthScore {
  strategyId: string;
  strategyName: string;
  overallScore: number;
  metrics: {
    contractSafety: number;
    dataFreshness: number;
    providerUptime: number;
    liquidityConditions: number;
    executionOutcomes: number;
    volatilityIndex: number;
    errorRate: number;
    latency: number;
  };
  status: 'healthy' | 'degraded' | 'critical' | 'disabled';
  signals: Array<{
    source: string;
    metric: string;
    value: number;
    weight: number;
    threshold: {
      critical: number;
      warning: number;
      good: number;
    };
    timestamp: string;
    reliability: number;
  }>;
  lastUpdated: string;
  trend: 'improving' | 'stable' | 'declining';
  recommendations: string[];
  suppressUntil?: string;
}

export interface MockReliabilityScore {
  providerId: string;
  providerName: string;
  overallScore: number;
  dataSource: string;
  metrics: {
    uptime: number;
    accuracy: number;
    latency: number;
    errorRate: number;
    consistency: number;
  };
  historicalPerformance: Array<{
    timestamp: string;
    score: number;
    incidents: number;
  }>;
  lastUpdated: string;
  status: 'reliable' | 'moderate' | 'unreliable';
}

export interface MockStateTransitionGraph {
  strategyId: string;
  transitions: Array<{
    from: string;
    to: string;
    timestamp: string;
    reason: string;
    triggeredBy: 'system' | 'user' | 'external';
    metadata?: Record<string, unknown>;
  }>;
  currentState: string;
  totalTransitions: number;
  generatedAt: string;
  timeRange: {
    start: string;
    end: string;
  };
}

export interface MockRecommendationStabilityReport {
  stability: {
    overallScore: number;
    changedRecommendations: number;
    totalRecommendations: number;
    stabilityPercentage: number;
  };
  differences: Array<{
    recommendationId: string;
    before: unknown;
    after: unknown;
    changeType: 'added' | 'removed' | 'modified';
    impact: 'low' | 'medium' | 'high';
    field?: string;
  }>;
  summary: {
    stable: boolean;
    riskLevel: 'low' | 'medium' | 'high';
    recommendedAction: string;
  };
  baseline?: {
    testSetId?: string;
    beforeRelease?: string;
    afterRelease?: string;
  };
  generatedAt: string;
}

/**
 * Deterministic mock data generators
 */
export class AnalyticsMockDataGenerator {
  private static readonly FIXED_TIMESTAMP = '2026-05-26T12:00:00.000Z';
  private static readonly FIXED_START_TIME = '2026-03-01T00:00:00.000Z';
  private static readonly FIXED_END_TIME = '2026-04-01T00:00:00.000Z';

  static createAttributionReport(walletAddress: string): MockAttributionReport {
    return {
      walletAddress,
      totalReturn: 1250.50,
      totalDeposited: 10000,
      attributionBreakdown: [
        {
          decisionType: 'initial_routing',
          contribution: 850.30,
          percentage: 68.02,
          apyImpact: 8.5,
          decisions: [
            {
              id: 'decision_001',
              type: 'route_selection',
              timestamp: this.FIXED_TIMESTAMP,
              protocol: 'Blend',
              amount: 5000,
              expectedApy: 8.5,
              actualApy: 8.7,
              duration: 30,
              confidence: 0.95,
            },
          ],
          confidence: 0.95,
        },
        {
          decisionType: 'rotation',
          contribution: 400.20,
          percentage: 31.98,
          apyImpact: 4.0,
          decisions: [],
          confidence: 0.88,
        },
      ],
      rewardSourceMix: [
        {
          rewardSource: 'base_protocol_yield',
          contribution: 800.25,
          percentage: 64.02,
          confidence: 0.98,
        },
        {
          rewardSource: 'incentive_emissions',
          contribution: 450.25,
          percentage: 35.98,
          confidence: 0.85,
        },
      ],
      timeWindow: {
        start: this.FIXED_START_TIME,
        end: this.FIXED_END_TIME,
      },
      generatedAt: this.FIXED_TIMESTAMP,
      dataCompleteness: 0.98,
    };
  }

  static createCompatibilityReport(): MockCompatibilityReport {
    return {
      protocols: [
        {
          protocolName: 'Blend',
          status: 'compatible',
          criticalIssues: 0,
          lastChecked: this.FIXED_TIMESTAMP,
          version: '1.2.3',
          supportedFeatures: ['lending', 'borrowing', 'liquidation'],
        },
        {
          protocolName: 'Soroswap',
          status: 'degraded',
          criticalIssues: 1,
          lastChecked: this.FIXED_TIMESTAMP,
          version: '2.1.0',
          supportedFeatures: ['swapping', 'liquidity_provision'],
        },
        {
          protocolName: 'Aquarius',
          status: 'incompatible',
          criticalIssues: 3,
          lastChecked: this.FIXED_TIMESTAMP,
          version: '0.9.5',
          supportedFeatures: [],
        },
      ],
      issues: [
        {
          severity: 'critical',
          protocol: 'Aquarius',
          message: 'Contract interface changed, breaking compatibility',
          code: 'INTERFACE_MISMATCH',
          timestamp: this.FIXED_TIMESTAMP,
        },
        {
          severity: 'warning',
          protocol: 'Soroswap',
          message: 'High slippage detected on low liquidity pairs',
          code: 'HIGH_SLIPPAGE',
          timestamp: this.FIXED_TIMESTAMP,
        },
        {
          severity: 'info',
          protocol: 'Blend',
          message: 'All systems operational',
          code: 'HEALTHY',
          timestamp: this.FIXED_TIMESTAMP,
        },
      ],
      overallStatus: 'degraded',
      generatedAt: this.FIXED_TIMESTAMP,
      checkDuration: 1250,
    };
  }

  static createHealthScore(strategyId: string, strategyName?: string): MockHealthScore {
    const baseScore = strategyId === 'critical_strategy' ? 35 : 
                     strategyId === 'degraded_strategy' ? 65 : 85;

    return {
      strategyId,
      strategyName: strategyName || `Strategy ${strategyId}`,
      overallScore: baseScore,
      metrics: {
        contractSafety: baseScore + 5,
        dataFreshness: baseScore - 5,
        providerUptime: baseScore + 10,
        liquidityConditions: baseScore - 10,
        executionOutcomes: baseScore,
        volatilityIndex: 100 - baseScore, // Inverse relationship
        errorRate: baseScore < 60 ? 15 : baseScore < 80 ? 5 : 1,
        latency: baseScore < 60 ? 500 : baseScore < 80 ? 200 : 100,
      },
      status: baseScore >= 80 ? 'healthy' : baseScore >= 60 ? 'degraded' : 'critical',
      signals: [
        {
          source: 'contract_monitor',
          metric: 'safety_score',
          value: baseScore + 5,
          weight: 0.3,
          threshold: {
            critical: 40,
            warning: 60,
            good: 80,
          },
          timestamp: this.FIXED_TIMESTAMP,
          reliability: 0.95,
        },
      ],
      lastUpdated: this.FIXED_TIMESTAMP,
      trend: baseScore >= 80 ? 'stable' : baseScore >= 60 ? 'declining' : 'improving',
      recommendations: baseScore < 60 ? [
        'Consider pausing strategy until issues are resolved',
        'Review contract safety parameters',
      ] : baseScore < 80 ? [
        'Monitor closely for further degradation',
      ] : [],
    };
  }

  static createReliabilityScore(providerId: string, providerName?: string): MockReliabilityScore {
    const baseScore = providerId === 'unreliable_provider' ? 45 : 
                     providerId === 'moderate_provider' ? 70 : 88;

    return {
      providerId,
      providerName: providerName || `Provider ${providerId}`,
      overallScore: baseScore,
      dataSource: 'api',
      metrics: {
        uptime: baseScore + 10,
        accuracy: baseScore + 5,
        latency: baseScore < 60 ? 300 : baseScore < 80 ? 150 : 80,
        errorRate: baseScore < 60 ? 10 : baseScore < 80 ? 3 : 0.5,
        consistency: baseScore,
      },
      historicalPerformance: [
        {
          timestamp: '2026-05-25T12:00:00.000Z',
          score: baseScore - 2,
          incidents: baseScore < 60 ? 3 : baseScore < 80 ? 1 : 0,
        },
        {
          timestamp: this.FIXED_TIMESTAMP,
          score: baseScore,
          incidents: baseScore < 60 ? 2 : 0,
        },
      ],
      lastUpdated: this.FIXED_TIMESTAMP,
      status: baseScore >= 80 ? 'reliable' : baseScore >= 60 ? 'moderate' : 'unreliable',
    };
  }

  static createStateTransitionGraph(strategyId: string): MockStateTransitionGraph {
    return {
      strategyId,
      transitions: [
        {
          from: 'inactive',
          to: 'active',
          timestamp: '2026-05-25T10:00:00.000Z',
          reason: 'Strategy deployment completed',
          triggeredBy: 'system',
          metadata: { deploymentId: 'deploy_001' },
        },
        {
          from: 'active',
          to: 'paused',
          timestamp: '2026-05-26T11:00:00.000Z',
          reason: 'Manual pause for maintenance',
          triggeredBy: 'user',
          metadata: { userId: 'admin_001', reason: 'scheduled_maintenance' },
        },
        {
          from: 'paused',
          to: 'active',
          timestamp: this.FIXED_TIMESTAMP,
          reason: 'Maintenance completed',
          triggeredBy: 'user',
          metadata: { userId: 'admin_001' },
        },
      ],
      currentState: 'active',
      totalTransitions: 3,
      generatedAt: this.FIXED_TIMESTAMP,
      timeRange: {
        start: '2026-05-25T00:00:00.000Z',
        end: this.FIXED_TIMESTAMP,
      },
    };
  }

  static createRecommendationStabilityReport(): MockRecommendationStabilityReport {
    return {
      stability: {
        overallScore: 85.5,
        changedRecommendations: 2,
        totalRecommendations: 10,
        stabilityPercentage: 80.0,
      },
      differences: [
        {
          recommendationId: 'rec_001',
          before: { action: 'buy', confidence: 0.8 },
          after: { action: 'hold', confidence: 0.6 },
          changeType: 'modified',
          impact: 'medium',
          field: 'action',
        },
        {
          recommendationId: 'rec_002',
          before: null,
          after: { action: 'sell', confidence: 0.9 },
          changeType: 'added',
          impact: 'high',
        },
      ],
      summary: {
        stable: true,
        riskLevel: 'low',
        recommendedAction: 'Deploy with monitoring',
      },
      baseline: {
        testSetId: 'test_001',
        beforeRelease: 'v1.2.0',
        afterRelease: 'v1.2.1',
      },
      generatedAt: this.FIXED_TIMESTAMP,
    };
  }

  /**
   * Create empty state responses for testing edge cases
   */
  static createEmptyAttributionReport(walletAddress: string): MockAttributionReport {
    return {
      walletAddress,
      totalReturn: 0,
      totalDeposited: 0,
      attributionBreakdown: [],
      timeWindow: {
        start: this.FIXED_START_TIME,
        end: this.FIXED_END_TIME,
      },
      generatedAt: this.FIXED_TIMESTAMP,
      dataCompleteness: 0,
    };
  }

  static createEmptyCompatibilityReport(): MockCompatibilityReport {
    return {
      protocols: [],
      issues: [],
      overallStatus: 'compatible',
      generatedAt: this.FIXED_TIMESTAMP,
      checkDuration: 0,
    };
  }

  /**
   * Create error scenarios for testing failure cases
   */
  static createServiceUnavailableError(): Error {
    return new Error('Service temporarily unavailable');
  }

  static createTimeoutError(): Error {
    const error = new Error('Request timeout');
    error.name = 'TimeoutError';
    return error;
  }

  static createValidationError(field: string): Error {
    return new Error(`Validation failed for field: ${field}`);
  }
}

/**
 * Intentionally unstable fields for testing
 * 
 * These fields are expected to change between test runs and should not
 * be included in strict contract validation.
 */
export const UNSTABLE_FIELDS = [
  'generatedAt',
  'lastUpdated', 
  'timestamp',
  'formattedDate',
  'checkDuration',
] as const;

/**
 * Field validation helpers
 */
export const FIELD_VALIDATORS = {
  timestamp: (value: unknown): boolean => {
    return typeof value === 'string' && !isNaN(Date.parse(value));
  },
  
  percentage: (value: unknown): boolean => {
    return typeof value === 'number' && value >= 0 && value <= 100;
  },
  
  score: (value: unknown): boolean => {
    return typeof value === 'number' && value >= 0 && value <= 100;
  },
  
  status: (value: unknown, allowedValues: string[]): boolean => {
    return typeof value === 'string' && allowedValues.includes(value);
  },
  
  nonEmptyString: (value: unknown): boolean => {
    return typeof value === 'string' && value.length > 0;
  },
  
  positiveNumber: (value: unknown): boolean => {
    return typeof value === 'number' && value >= 0;
  },
} as const;