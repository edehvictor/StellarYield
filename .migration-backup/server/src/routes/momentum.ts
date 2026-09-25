import { Router } from 'express';
import { opportunityMomentumEngine } from '../services/opportunityMomentumEngine';

const router = Router();

/**
 * POST /api/momentum/snapshots
 * Add opportunity snapshots to the momentum engine
 */
router.post('/snapshots', async (req, res) => {
  try {
    const { snapshots } = req.body;

    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'snapshots must be a non-empty array',
      });
    }

    // Validate snapshot structure
    for (const snapshot of snapshots) {
      if (!snapshot.timestamp || !snapshot.protocolName || 
          typeof snapshot.apy !== 'number' || typeof snapshot.tvl !== 'number') {
        return res.status(400).json({
          success: false,
          error: 'Invalid snapshot structure. Required fields: timestamp, protocolName, apy, tvl',
        });
      }
    }

    opportunityMomentumEngine.bulkAddSnapshots(snapshots);

    res.json({
      success: true,
      message: `Added ${snapshots.length} snapshots`,
      snapshotsAdded: snapshots.length,
    });
  } catch (error) {
    console.error('Failed to add momentum snapshots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add snapshots',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/momentum/analysis
 * Get comprehensive momentum analysis for all protocols
 */
router.get('/analysis', async (req, res) => {
  try {
    const { timestamp } = req.query;
    const analysisTime = timestamp ? parseInt(timestamp as string) : undefined;

    const analysis = opportunityMomentumEngine.analyzeOpportunities(analysisTime);

    res.json({
      success: true,
      data: analysis,
    });
  } catch (error) {
    console.error('Momentum analysis failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze opportunities',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/momentum/protocols/:protocolName
 * Get momentum score for a specific protocol
 */
router.get('/protocols/:protocolName', async (req, res) => {
  try {
    const { protocolName } = req.params;
    const { timestamp } = req.query;
    const analysisTime = timestamp ? parseInt(timestamp as string) : undefined;

    const score = opportunityMomentumEngine.calculateMomentumScore(protocolName, analysisTime);

    if (!score) {
      return res.status(404).json({
        success: false,
        error: 'Protocol not found or insufficient data',
        protocolName,
      });
    }

    res.json({
      success: true,
      data: score,
    });
  } catch (error) {
    console.error(`Momentum calculation failed for ${req.params.protocolName}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to calculate momentum score',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/momentum/protocols/batch
 * Get momentum scores for multiple protocols
 */
router.post('/protocols/batch', async (req, res) => {
  try {
    const { protocolNames, timestamp } = req.body;

    if (!Array.isArray(protocolNames) || protocolNames.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'protocolNames must be a non-empty array',
      });
    }

    const analysisTime = timestamp ? parseInt(timestamp) : undefined;
    const scores = opportunityMomentumEngine.getMomentumScores(protocolNames, analysisTime);

    res.json({
      success: true,
      data: {
        scores,
        requestedProtocols: protocolNames.length,
        foundProtocols: scores.length,
      },
    });
  } catch (error) {
    console.error('Batch momentum calculation failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to calculate batch momentum scores',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/momentum/protocols
 * Get list of available protocols and their snapshot counts
 */
router.get('/protocols', async (req, res) => {
  try {
    const protocols = opportunityMomentumEngine.getAvailableProtocols();
    const protocolInfo = protocols.map(protocolName => ({
      protocolName,
      snapshotCount: opportunityMomentumEngine.getSnapshotCount(protocolName),
    }));

    res.json({
      success: true,
      data: {
        protocols: protocolInfo,
        totalProtocols: protocols.length,
      },
    });
  } catch (error) {
    console.error('Failed to get available protocols:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get available protocols',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/momentum/ranking
 * Get ranked opportunities with optional filtering
 */
router.get('/ranking', async (req, res) => {
  try {
    const { 
      limit = 10, 
      momentumClass, 
      minScore = 0, 
      timestamp 
    } = req.query;

    const analysisTime = timestamp ? parseInt(timestamp as string) : undefined;
    const analysis = opportunityMomentumEngine.analyzeOpportunities(analysisTime);

    let filteredOpportunities = analysis.rankedOpportunities;

    // Apply filters
    if (momentumClass && ['rising', 'flat', 'declining'].includes(momentumClass as string)) {
      filteredOpportunities = filteredOpportunities.filter(
        opp => opp.momentumClass === momentumClass
      );
    }

    if (minScore) {
      const minScoreNum = parseFloat(minScore as string);
      filteredOpportunities = filteredOpportunities.filter(
        opp => opp.finalScore >= minScoreNum
      );
    }

    // Apply limit
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string)));
    const limitedOpportunities = filteredOpportunities.slice(0, limitNum);

    res.json({
      success: true,
      data: {
        opportunities: limitedOpportunities,
        totalFound: filteredOpportunities.length,
        totalAvailable: analysis.rankedOpportunities.length,
        filters: {
          momentumClass: momentumClass || null,
          minScore: minScore ? parseFloat(minScore as string) : 0,
          limit: limitNum,
        },
        summary: analysis.summary,
      },
    });
  } catch (error) {
    console.error('Ranking request failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get opportunity ranking',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/momentum/config
 * Get current momentum engine configuration
 */
router.get('/config', async (req, res) => {
  try {
    const config = opportunityMomentumEngine.getConfig();

    res.json({
      success: true,
      data: config,
    });
  } catch (error) {
    console.error('Failed to get momentum config:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get configuration',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/momentum/config
 * Update momentum engine configuration
 */
router.post('/config', async (req, res) => {
  try {
    const config = req.body;

    // Validate configuration
    if (config.minDataPoints && (config.minDataPoints < 1 || config.minDataPoints > 100)) {
      return res.status(400).json({
        success: false,
        error: 'minDataPoints must be between 1 and 100',
      });
    }

    if (config.windows && !Array.isArray(config.windows)) {
      return res.status(400).json({
        success: false,
        error: 'windows must be an array',
      });
    }

    opportunityMomentumEngine.updateConfig(config);

    res.json({
      success: true,
      message: 'Configuration updated successfully',
      config: opportunityMomentumEngine.getConfig(),
    });
  } catch (error) {
    console.error('Failed to update momentum config:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update configuration',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/momentum/history
 * Clear all momentum history (admin only)
 */
router.delete('/history', async (req, res) => {
  try {
    const protocolCountBefore = opportunityMomentumEngine.getAvailableProtocols().length;
    
    opportunityMomentumEngine.clearHistory();

    res.json({
      success: true,
      message: 'Momentum history cleared successfully',
      protocolsCleared: protocolCountBefore,
    });
  } catch (error) {
    console.error('Failed to clear momentum history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear history',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/momentum/health
 * Get momentum engine health and statistics
 */
router.get('/health', async (req, res) => {
  try {
    const protocols = opportunityMomentumEngine.getAvailableProtocols();
    const totalSnapshots = protocols.reduce(
      (sum, protocol) => sum + opportunityMomentumEngine.getSnapshotCount(protocol),
      0
    );

    const analysis = opportunityMomentumEngine.analyzeOpportunities();
    const config = opportunityMomentumEngine.getConfig();

    res.json({
      success: true,
      data: {
        status: 'healthy',
        statistics: {
          totalProtocols: protocols.length,
          totalSnapshots,
          averageSnapshotsPerProtocol: protocols.length > 0 ? totalSnapshots / protocols.length : 0,
          opportunitiesAnalyzed: analysis.opportunities.length,
          risingOpportunities: analysis.summary.risingCount,
          decliningOpportunities: analysis.summary.decliningCount,
          flatOpportunities: analysis.summary.flatCount,
        },
        configuration: {
          minDataPoints: config.minDataPoints,
          windowCount: config.windows.length,
          confidenceWeight: config.confidenceWeight,
          liquidityWeight: config.liquidityWeight,
          riskPenaltyFactor: config.riskPenaltyFactor,
        },
        lastAnalysis: {
          timestamp: analysis.summary.analysisTimestamp,
          topProtocol: analysis.summary.topMomentumProtocol,
          averageMomentum: analysis.summary.averageMomentum,
        },
      },
    });
  } catch (error) {
    console.error('Momentum health check failed:', error);
    res.status(500).json({
      success: false,
      error: 'Health check failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;