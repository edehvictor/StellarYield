import { Router } from 'express';
import { 
  portfolioAttributionEngine,
  protocolCompatibilityEngine,
  strategyHealthEngine,
  yieldReliabilityEngine,
} from '../services';
import {
  validateAttributionRequest,
  formatAttributionReport,
  formatCompatibilityReport,
  formatHealthScore,
  getCriticalHealthAlerts,
  formatReliabilityScore,
  getWeightedProviderSelection,
  isProtocolSafeForExecution,
} from './analyticsUtils';

const router = Router();

// ── Portfolio Attribution Routes ────────────────────────────────────────

/**
 * GET /api/analytics/attribution/:walletAddress
 * Generate portfolio attribution report for a wallet
 */
router.get('/attribution/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const { startTime, endTime } = req.query;

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: startTime and endTime',
        example: '/api/analytics/attribution/:walletAddress?startTime=2026-03-01T00:00:00Z&endTime=2026-04-01T00:00:00Z'
      });
    }

    const validation = validateAttributionRequest(walletAddress, startTime as string, endTime as string);
    
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error || 'Invalid request parameters',
      });
    }

    const report = await portfolioAttributionEngine.generateAttributionReport(
      walletAddress,
      startTime as string,
      endTime as string
    );

    const formattedReport = formatAttributionReport(report);
    
    res.json({
      success: true,
      data: formattedReport,
    });
  } catch (error) {
    console.error('Attribution report generation failed:', error);
    res.status(500).json({
      error: 'Failed to generate attribution report',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/analytics/attribution/config
 * Update attribution engine configuration
 */
router.post('/attribution/config', async (req, res) => {
  try {
    const config = req.body;
    portfolioAttributionEngine.updateConfig(config);
    
    res.json({
      success: true,
      message: 'Attribution configuration updated',
      config: portfolioAttributionEngine.getConfig(),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to update attribution configuration',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /api/analytics/attribution/cache/:walletAddress
 * Clear attribution cache for a wallet
 */
router.delete('/attribution/cache/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    portfolioAttributionEngine.clearCache(walletAddress);
    
    res.json({
      success: true,
      message: `Attribution cache cleared for ${walletAddress}`,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to clear attribution cache',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ── Protocol Compatibility Routes ────────────────────────────────────────

/**
 * GET /api/analytics/compatibility
 * Run comprehensive compatibility check
 */
router.get('/compatibility', async (req, res) => {
  try {
    const report = await protocolCompatibilityEngine.runCompatibilityCheck();
    const formattedReport = formatCompatibilityReport(report);
    
    res.json({
      success: true,
      data: formattedReport,
    });
  } catch (error) {
    console.error('Compatibility check failed:', error);
    res.status(500).json({
      error: 'Failed to run compatibility check',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/analytics/compatibility/:protocolName
 * Check compatibility for specific protocol
 */
router.get('/compatibility/:protocolName', async (req, res) => {
  try {
    const { protocolName } = req.params;
    const status = await protocolCompatibilityEngine.checkProtocol(protocolName);
    
    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    console.error(`Protocol compatibility check failed:`, error);
    res.status(500).json({
      error: 'Failed to check protocol compatibility',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/analytics/compatibility/safe/:protocolName
 * Check if protocol is safe for strategy execution
 */
router.get('/compatibility/safe/:protocolName', async (req, res) => {
  try {
    const { protocolName } = req.params;
    const report = await protocolCompatibilityEngine.runCompatibilityCheck();
    const isSafe = isProtocolSafeForExecution(protocolName, report);
    
    res.json({
      success: true,
      data: {
        protocolName,
        isSafe,
        status: report.protocols?.find((p: { protocolName: string }) => p.protocolName === protocolName)?.status || 'unknown'
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check protocol safety',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/analytics/compatibility/config
 * Update compatibility engine configuration
 */
router.post('/compatibility/config', async (req, res) => {
  try {
    const config = req.body;
    protocolCompatibilityEngine.updateConfig(config);
    
    res.json({
      success: true,
      message: 'Compatibility configuration updated',
      config: protocolCompatibilityEngine.getConfig(),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to update compatibility configuration',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ── Strategy Health Routes ─────────────────────────────────────────────

/**
 * GET /api/analytics/health/:strategyId
 * Get health score for a specific strategy
 */
router.get('/health/:strategyId', async (req, res) => {
  try {
    const { strategyId } = req.params;
    const { strategyName } = req.query;
    
    const healthScore = await strategyHealthEngine.calculateHealthScore(
      strategyId,
      (strategyName as string) || `Strategy ${strategyId}`
    );
    
    const formattedScore = formatHealthScore(healthScore);
    
    res.json({
      success: true,
      data: formattedScore,
    });
  } catch (error) {
    console.error(`Health score calculation failed for ${req.params.strategyId}:`, error);
    res.status(500).json({
      error: 'Failed to calculate health score',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/analytics/health/batch
 * Get health scores for multiple strategies
 */
router.post('/health/batch', async (req, res) => {
  try {
    const { strategyIds } = req.body;
    
    if (!Array.isArray(strategyIds) || strategyIds.length === 0) {
      return res.status(400).json({
        error: 'strategyIds must be a non-empty array'
      });
    }

    const healthScores = await strategyHealthEngine.getHealthScores(strategyIds);
    const formattedScores = healthScores.map(formatHealthScore);
    
    res.json({
      success: true,
      data: formattedScores,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get health scores',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/analytics/health/alerts
 * Get critical health alerts
 */
router.get('/health/alerts', async (req, res) => {
  try {
    // Get health scores for all strategies (mock list)
    const strategyIds = ['strategy_1', 'strategy_2', 'strategy_3', 'strategy_4'];
    const healthScores = await strategyHealthEngine.getHealthScores(strategyIds);
    const alerts = getCriticalHealthAlerts(healthScores);
    
    res.json({
      success: true,
      data: {
        alerts,
        criticalCount: alerts.length,
        totalStrategies: healthScores.length,
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get health alerts',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/analytics/health/config
 * Update health engine configuration
 */
router.post('/health/config', async (req, res) => {
  try {
    const config = req.body;
    strategyHealthEngine.updateConfig(config);
    
    res.json({
      success: true,
      message: 'Health configuration updated',
      config: strategyHealthEngine.getConfig(),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to update health configuration',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ── Yield Reliability Routes ────────────────────────────────────────────

/**
 * GET /api/analytics/reliability/:providerId
 * Get reliability score for a specific provider
 */
router.get('/reliability/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    const { providerName, dataSource } = req.query;
    
    const reliability = await yieldReliabilityEngine.calculateReliabilityScore(
      providerId,
      (providerName as string) || `Provider ${providerId}`,
      (dataSource as string) || 'api'
    );
    
    const formattedReliability = formatReliabilityScore(reliability);
    
    res.json({
      success: true,
      data: formattedReliability,
    });
  } catch (error) {
    console.error(`Reliability score calculation failed:`, error);
    res.status(500).json({
      error: 'Failed to calculate reliability score',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/analytics/reliability/batch
 * Get reliability scores for multiple providers
 */
router.post('/reliability/batch', async (req, res) => {
  try {
    const { providers } = req.body;
    
    if (!Array.isArray(providers) || providers.length === 0) {
      return res.status(400).json({
        error: 'providers must be a non-empty array'
      });
    }

    const reliabilityScores = await yieldReliabilityEngine.getReliabilityScores(providers);
    const formattedScores = reliabilityScores.map(formatReliabilityScore);
    
    res.json({
      success: true,
      data: formattedScores,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get reliability scores',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/analytics/reliability/compare
 * Compare and rank providers
 */
router.get('/reliability/compare', async (req, res) => {
  try {
    const providers = await yieldReliabilityEngine.getAllProviderIds();
    const comparison = await yieldReliabilityEngine.compareProviders(providers);
    
    res.json({
      success: true,
      data: comparison,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to compare providers',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/analytics/reliability/recommendations
 * Get providers suitable for recommendations
 */
router.get('/reliability/recommendations', async (req, res) => {
  try {
    const { minReliability = 70 } = req.query;
    const providers = await yieldReliabilityEngine.getProvidersForRecommendations(Number(minReliability));
    const weightedSelection = getWeightedProviderSelection(providers);
    
    res.json({
      success: true,
      data: {
        providers: weightedSelection.map(formatReliabilityScore),
        minReliability: Number(minReliability),
        totalProviders: providers.length,
        selectedProviders: weightedSelection.length,
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get provider recommendations',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/analytics/reliability/config
 * Update reliability engine configuration
 */
router.post('/reliability/config', async (req, res) => {
  try {
    const config = req.body as Record<string, unknown>;
    yieldReliabilityEngine.updateConfig(config);
    
    res.json({
      success: true,
      message: 'Reliability configuration updated',
      config: yieldReliabilityEngine.getConfig(),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to update reliability configuration',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ── Combined Analytics Routes ───────────────────────────────────────────

/**
 * GET /api/analytics/dashboard
 * Get comprehensive analytics dashboard data
 */
router.get('/dashboard', async (req, res) => {
  try {
    const { walletAddress, strategyIds, providerIds } = req.query;
    
    // Initialize results
    const dashboardData: Record<string, unknown> = {
      attribution: null,
      compatibility: null,
      healthScores: [],
      reliabilityScores: [],
      alerts: [],
      summary: {
        overallHealth: 'unknown',
        criticalIssues: 0,
        recommendations: [],
        lastUpdated: new Date().toISOString(),
      },
    };

    // Get attribution if wallet address provided
    if (walletAddress) {
      try {
        const endTime = new Date().toISOString();
        const startTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
        
        const attribution = await portfolioAttributionEngine.generateAttributionReport(
          walletAddress as string,
          startTime,
          endTime
        );
        dashboardData.attribution = formatAttributionReport(attribution);
      } catch (error) {
        console.error('Attribution data fetch failed:', error);
      }
    }

    // Get compatibility report
    try {
      const compatibility = await protocolCompatibilityEngine.runCompatibilityCheck();
      dashboardData.compatibility = formatCompatibilityReport(compatibility);
      (dashboardData.summary as { criticalIssues: number }).criticalIssues = compatibility.issues?.filter((issue: { severity: string }) => issue.severity === 'critical').length || 0;
    } catch (error) {
      console.error('Compatibility data fetch failed:', error);
    }

    // Get health scores if strategy IDs provided
    if (strategyIds && Array.isArray(strategyIds)) {
      try {
        const healthScores = await strategyHealthEngine.getHealthScores(strategyIds as string[]);
        dashboardData.healthScores = healthScores.map(formatHealthScore);
        dashboardData.alerts = getCriticalHealthAlerts(healthScores);
      } catch (error) {
        console.error('Health scores fetch failed:', error);
      }
    }

    // Get reliability scores if provider IDs provided
    if (providerIds && Array.isArray(providerIds)) {
      try {
        const providers = (providerIds as string[]).map(id => ({
          id,
          name: `Provider ${id}`,
          source: 'api'
        }));
        const reliabilityScores = await yieldReliabilityEngine.getReliabilityScores(providers);
        dashboardData.reliabilityScores = reliabilityScores.map(formatReliabilityScore);
      } catch (error) {
        console.error('Reliability scores fetch failed:', error);
      }
    }

    // Calculate overall health summary
    const healthScores = dashboardData.healthScores as Array<{ overallScore: number }>;
    if (healthScores.length > 0) {
      const avgScore = healthScores.reduce((sum: number, score: { overallScore: number }) => sum + score.overallScore, 0) / healthScores.length;
      (dashboardData.summary as Record<string, unknown>).overallHealth = avgScore >= 80 ? 'healthy' : avgScore >= 60 ? 'degraded' : 'critical';
    }

    res.json({
      success: true,
      data: dashboardData,
    });
  } catch (error) {
    console.error('Dashboard data fetch failed:', error);
    res.status(500).json({
      error: 'Failed to fetch dashboard data',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
