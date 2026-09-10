import { Router } from "express";
import { recordFailure, resolveNetworkLabel } from "../monitoring/prometheus";
import {
  portfolioAttributionEngine,
  protocolCompatibilityEngine,
  strategyHealthEngine,
  yieldReliabilityEngine,
} from "../services";
import { strategyStateTransitionAuditService } from "../services/strategyStateTransitionAuditService";
import { getSourceHealthRegistry } from "../services/yieldSourceRegistryService";
import { getRegistryLoadState } from "../services/contractRegistry";
import {
  generateRecommendationStabilityReport,
  type RecommendationOutput,
} from "../services/recommendationStabilityService";
import {
  getRecommendationTimelinePaginated,
} from "../services/recommendationTimelineService";
import {
  validateAttributionRequest,
  formatAttributionReport,
  formatCompatibilityReport,
  formatHealthScore,
  getCriticalHealthAlerts,
  formatReliabilityScore,
  getWeightedProviderSelection,
  isProtocolSafeForExecution,
} from "./analyticsUtils";
import { successEnvelope, errorEnvelope } from "../types/envelope";
import {
  PaginatedResponse,
  parsePaginationLimit as parsePaginationLimitGeneric,
} from "../types/pagination";

const router = Router();

// ── Portfolio Attribution Routes ────────────────────────────────────────

/**
 * GET /api/analytics/attribution/:walletAddress
 * Generate portfolio attribution report for a wallet
 */
router.get("/attribution/:walletAddress", async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const { startTime, endTime } = req.query;

    if (!startTime || !endTime) {
      return res.status(400).json(
        errorEnvelope(
          "VALIDATION_ERROR",
          "Missing required parameters: startTime and endTime",
          "analytics/attribution",
          {
            example:
              "/api/analytics/attribution/:walletAddress?startTime=2026-03-01T00:00:00Z&endTime=2026-04-01T00:00:00Z",
          },
        ),
      );
    }

    const validation = validateAttributionRequest(
      walletAddress,
      startTime as string,
      endTime as string,
    );

    if (!validation.valid) {
      return res
        .status(400)
        .json(
          errorEnvelope(
            "VALIDATION_ERROR",
            validation.error || "Invalid request parameters",
            "analytics/attribution",
          ),
        );
    }

    const report = await portfolioAttributionEngine.generateAttributionReport(
      walletAddress,
      startTime as string,
      endTime as string,
    );

    const formattedReport = formatAttributionReport(report);

    res.json(successEnvelope(formattedReport, "analytics/attribution"));
  } catch (error) {
    console.error("Attribution report generation failed:", error);
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to generate attribution report",
          "analytics/attribution",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * POST /api/analytics/attribution/config
 * Update attribution engine configuration
 */
router.post("/attribution/config", async (req, res) => {
  try {
    const config = req.body;
    portfolioAttributionEngine.updateConfig(config);

    res.json(
      successEnvelope(
        {
          message: "Attribution configuration updated",
          config: portfolioAttributionEngine.getConfig(),
        },
        "analytics/attribution/config",
      ),
    );
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to update attribution configuration",
          "analytics/attribution/config",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * DELETE /api/analytics/attribution/cache/:walletAddress
 * Clear attribution cache for a wallet
 */
router.delete("/attribution/cache/:walletAddress", async (req, res) => {
  try {
    const { walletAddress } = req.params;
    portfolioAttributionEngine.clearCache(walletAddress);

    res.json(
      successEnvelope(
        { message: `Attribution cache cleared for ${walletAddress}` },
        "analytics/attribution/cache",
      ),
    );
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to clear attribution cache",
          "analytics/attribution/cache",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

// ── Protocol Compatibility Routes ────────────────────────────────────────

/**
 * GET /api/analytics/compatibility
 * Run comprehensive compatibility check
 */
router.get("/compatibility", async (req, res) => {
  try {
    const report = await protocolCompatibilityEngine.runCompatibilityCheck();
    const formattedReport = formatCompatibilityReport(report);

    // Surface registry load warnings to the client so the UI can display
    // targeted messages when contract metadata is incomplete or missing.
    const loadState = getRegistryLoadState();
    if (loadState.status !== 'ok') {
      (formattedReport as any).registryWarnings = [{
        code: loadState.status === 'fallback' ? 'fallback_used' : 'empty_registry',
        message: loadState.reason ?? 'Registry metadata is unavailable',
      }];
    }

    res.json(successEnvelope(formattedReport, 'analytics/compatibility'));
    res.json(successEnvelope(formattedReport, "analytics/compatibility"));
  } catch (error) {
    console.error("Compatibility check failed:", error);
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to run compatibility check",
          "analytics/compatibility",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * GET /api/analytics/compatibility/:protocolName
 * Check compatibility for specific protocol
 */
router.get("/compatibility/:protocolName", async (req, res) => {
  try {
    const { protocolName } = req.params;
    const status =
      await protocolCompatibilityEngine.checkProtocol(protocolName);

    res.json(successEnvelope(status, "analytics/compatibility/protocol"));
  } catch (error) {
    console.error(`Protocol compatibility check failed:`, error);
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to check protocol compatibility",
          "analytics/compatibility/protocol",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * GET /api/analytics/compatibility/safe/:protocolName
 * Check if protocol is safe for strategy execution
 */
router.get("/compatibility/safe/:protocolName", async (req, res) => {
  try {
    const { protocolName } = req.params;
    const report = await protocolCompatibilityEngine.runCompatibilityCheck();
    const isSafe = isProtocolSafeForExecution(protocolName, report);

    res.json(
      successEnvelope(
        {
          protocolName,
          isSafe,
          status:
            report.protocols?.find(
              (p: { protocolName: string }) => p.protocolName === protocolName,
            )?.status || "unknown",
        },
        "analytics/compatibility/safe",
      ),
    );
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to check protocol safety",
          "analytics/compatibility/safe",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * POST /api/analytics/compatibility/config
 * Update compatibility engine configuration
 */
router.post("/compatibility/config", async (req, res) => {
  try {
    const config = req.body;
    protocolCompatibilityEngine.updateConfig(config);

    res.json(
      successEnvelope(
        {
          message: "Compatibility configuration updated",
          config: protocolCompatibilityEngine.getConfig(),
        },
        "analytics/compatibility/config",
      ),
    );
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to update compatibility configuration",
          "analytics/compatibility/config",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

// ── Strategy Health Routes ─────────────────────────────────────────────

/**
 * GET /api/analytics/health/alerts
 * Get critical health alerts
 * NOTE: must be declared before /health/:strategyId to avoid being swallowed
 */
router.get("/health/alerts", async (req, res) => {
  try {
    // Get health scores for all strategies (mock list)
    const strategyIds = [
      "strategy_1",
      "strategy_2",
      "strategy_3",
      "strategy_4",
    ];
    const healthScores =
      await strategyHealthEngine.getHealthScores(strategyIds);
    const alerts = getCriticalHealthAlerts(healthScores);

    res.json(
      successEnvelope(
        {
          alerts,
          criticalCount: alerts.length,
          totalStrategies: healthScores.length,
        },
        "analytics/health/alerts",
      ),
    );
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to get health alerts",
          "analytics/health/alerts",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * POST /api/analytics/health/config
 * Update health engine configuration
 */
router.post("/health/config", async (req, res) => {
  try {
    const config = req.body;
    strategyHealthEngine.updateConfig(config);

    res.json(
      successEnvelope(
        {
          message: "Health configuration updated",
          config: strategyHealthEngine.getConfig(),
        },
        "analytics/health/config",
      ),
    );
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to update health configuration",
          "analytics/health/config",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * POST /api/analytics/health/batch
 * Get health scores for multiple strategies
 */
router.post("/health/batch", async (req, res) => {
  try {
    const { strategyIds } = req.body;

    if (!Array.isArray(strategyIds) || strategyIds.length === 0) {
      return res
        .status(400)
        .json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "strategyIds must be a non-empty array",
            "analytics/health/batch",
          ),
        );
    }

    const healthScores =
      await strategyHealthEngine.getHealthScores(strategyIds);
    res.json(
      successEnvelope(
        healthScores.map(formatHealthScore),
        "analytics/health/batch",
      ),
    );
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to get health scores",
          "analytics/health/batch",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * GET /api/analytics/health/:strategyId
 * Get health score for a specific strategy
 * NOTE: must be declared after static /health/* routes
 */
router.get("/health/:strategyId", async (req, res) => {
  try {
    const { strategyId } = req.params;
    const { strategyName } = req.query;

    const healthScore = await strategyHealthEngine.calculateHealthScore(
      strategyId,
      (strategyName as string) || `Strategy ${strategyId}`,
    );

    res.json(
      successEnvelope(formatHealthScore(healthScore), "analytics/health"),
    );
  } catch (error) {
    console.error(
      `Health score calculation failed for ${req.params.strategyId}:`,
      error,
    );
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to calculate health score",
          "analytics/health",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

// ── Yield Data Source Registry ──────────────────────────────────────────

/**
 * GET /api/analytics/sources/health
 * Read-only health registry for every registered yield data source.
 * Returns each source's status (healthy/degraded/stale/unavailable), latest
 * fetch time, uptime, latency, and failure reason.
 */
router.get("/sources/health", async (_req, res) => {
  try {
    const registry = await getSourceHealthRegistry();
    res.setHeader(
      "Cache-Control",
      "public, max-age=30, stale-while-revalidate=15",
    );
    res.json(successEnvelope(registry, "analytics/sources/health"));
  } catch (error) {
    console.error("Source health registry generation failed:", error);
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to build source health registry",
          "analytics/sources/health",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

// ── Yield Reliability Routes ────────────────────────────────────────────

/**
 * GET /api/analytics/reliability/compare
 * Compare and rank providers
 * NOTE: must be declared before /reliability/:providerId
 */
router.get("/reliability/compare", async (req, res) => {
  try {
    const providers = [
      { id: "blend_api", name: "Blend Protocol", source: "api" },
      { id: "soroswap_api", name: "Soroswap", source: "api" },
      { id: "defindex_api", name: "DeFindex", source: "api" },
    ];
    const comparison = await yieldReliabilityEngine.compareProviders(providers);
    res.json(successEnvelope(comparison, "analytics/reliability/compare"));
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to compare providers",
          "analytics/reliability/compare",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * GET /api/analytics/reliability/recommendations
 * Get providers suitable for recommendations
 * NOTE: must be declared before /reliability/:providerId
 */
router.get("/reliability/recommendations", async (req, res) => {
  try {
    const { minReliability = 70 } = req.query;
    const providers =
      await yieldReliabilityEngine.getProvidersForRecommendations(
        Number(minReliability),
      );
    const weightedSelection = getWeightedProviderSelection(providers);
    res.json(
      successEnvelope(
        {
          providers: weightedSelection.map(formatReliabilityScore),
          minReliability: Number(minReliability),
          totalProviders: providers.length,
          selectedProviders: weightedSelection.length,
        },
        "analytics/reliability/recommendations",
      ),
    );
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to get provider recommendations",
          "analytics/reliability/recommendations",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * GET /api/analytics/reliability/:providerId
 * Get reliability score for a specific provider
 * NOTE: must be declared after static /reliability/* routes
 */
router.get("/reliability/:providerId", async (req, res) => {
  try {
    const { providerId } = req.params;
    const { providerName, dataSource } = req.query;

    const reliability = await yieldReliabilityEngine.calculateReliabilityScore(
      providerId,
      (providerName as string) || `Provider ${providerId}`,
      (dataSource as string) || "api",
    );

    const formattedReliability = formatReliabilityScore(reliability);

    res.json(successEnvelope(formattedReliability, "analytics/reliability"));
  } catch (error) {
    console.error(`Reliability score calculation failed:`, error);
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to calculate reliability score",
          "analytics/reliability",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * POST /api/analytics/reliability/batch
 * Get reliability scores for multiple providers
 */
router.post("/reliability/batch", async (req, res) => {
  try {
    const { providers } = req.body;

    if (!Array.isArray(providers) || providers.length === 0) {
      return res
        .status(400)
        .json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "providers must be a non-empty array",
            "analytics/reliability/batch",
          ),
        );
    }

    const reliabilityScores =
      await yieldReliabilityEngine.getReliabilityScores(providers);
    const formattedScores = reliabilityScores.map(formatReliabilityScore);

    res.json(successEnvelope(formattedScores, "analytics/reliability/batch"));
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to get reliability scores",
          "analytics/reliability/batch",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * POST /api/analytics/reliability/config
 * Update reliability engine configuration
 */
router.post("/reliability/config", async (req, res) => {
  try {
    const config = req.body as Record<string, unknown>;
    yieldReliabilityEngine.updateConfig(config);

    res.json(
      successEnvelope(
        {
          message: "Reliability configuration updated",
          config: yieldReliabilityEngine.getConfig(),
        },
        "analytics/reliability/config",
      ),
    );
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to update reliability configuration",
          "analytics/reliability/config",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

// ── Combined Analytics Routes ───────────────────────────────────────────

/**
 * GET /api/analytics/dashboard
 * Get comprehensive analytics dashboard data
 */
router.get("/dashboard", async (req, res) => {
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
        overallHealth: "unknown",
        criticalIssues: 0,
        recommendations: [],
        lastUpdated: new Date().toISOString(),
      },
    };

    // Get attribution if wallet address provided
    if (walletAddress) {
      try {
        const endTime = new Date().toISOString();
        const startTime = new Date(
          Date.now() - 30 * 24 * 60 * 60 * 1000,
        ).toISOString(); // 30 days ago

        const attribution =
          await portfolioAttributionEngine.generateAttributionReport(
            walletAddress as string,
            startTime,
            endTime,
          );
        dashboardData.attribution = formatAttributionReport(attribution);
      } catch (error) {
        console.error("Attribution data fetch failed:", error);
        recordFailure({
          route: "portfolio/attribution",
          network: resolveNetworkLabel(),
          failure_category: "attribution_fetch_failed",
        });
      }
    }

    // Get compatibility report
    try {
      const compatibility =
        await protocolCompatibilityEngine.runCompatibilityCheck();
      dashboardData.compatibility = formatCompatibilityReport(compatibility);
      (dashboardData.summary as { criticalIssues: number }).criticalIssues =
        compatibility.criticalIssues?.length || 0;
    } catch (error) {
      console.error("Compatibility data fetch failed:", error);
    }

    // Get health scores if strategy IDs provided
    if (strategyIds && Array.isArray(strategyIds)) {
      try {
        const healthScores = await strategyHealthEngine.getHealthScores(
          strategyIds as string[],
        );
        dashboardData.healthScores = healthScores.map(formatHealthScore);
        dashboardData.alerts = getCriticalHealthAlerts(healthScores);
      } catch (error) {
        console.error("Health scores fetch failed:", error);
      }
    }

    // Get reliability scores if provider IDs provided
    if (providerIds && Array.isArray(providerIds)) {
      try {
        const providers = (providerIds as string[]).map((id) => ({
          id,
          name: `Provider ${id}`,
          source: "api",
        }));
        const reliabilityScores =
          await yieldReliabilityEngine.getReliabilityScores(providers);
        dashboardData.reliabilityScores = reliabilityScores.map(
          formatReliabilityScore,
        );
      } catch (error) {
        console.error("Reliability scores fetch failed:", error);
      }
    }

    // Calculate overall health summary
    const healthScores = dashboardData.healthScores as Array<{
      overallScore: number;
    }>;
    if (healthScores.length > 0) {
      const avgScore =
        healthScores.reduce(
          (sum: number, score: { overallScore: number }) =>
            sum + score.overallScore,
          0,
        ) / healthScores.length;
      (dashboardData.summary as Record<string, unknown>).overallHealth =
        avgScore >= 80 ? "healthy" : avgScore >= 60 ? "degraded" : "critical";
    }

    res.json(successEnvelope(dashboardData, "analytics/dashboard"));
  } catch (error) {
    console.error("Dashboard data fetch failed:", error);
    recordFailure({
      route: "portfolio/analytics",
      network: resolveNetworkLabel(),
      failure_category: "dashboard_fetch_failed",
    });
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to fetch dashboard data",
          "analytics/dashboard",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * GET /api/analytics/strategy-state-transitions/:strategyId
 * Returns an audit graph of lifecycle transitions for a strategy.
 */
router.get("/strategy-state-transitions/:strategyId", async (req, res) => {
  try {
    const { strategyId } = req.params;
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));

    const graph = strategyStateTransitionAuditService.getGraph(
      String(strategyId),
      limit,
    );

    res.json(successEnvelope(graph, "analytics/strategy-state-transitions"));
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to fetch strategy state transitions",
          "analytics/strategy-state-transitions",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * POST /api/analytics/recommendation-stability/compare
 * Compares recommendation outputs from "before" vs "after" backend releases.
 *
 * Request body:
 * {
 *   before: RecommendationOutput[],
 *   after: RecommendationOutput[],
 *   baseline?: { testSetId?: string, beforeRelease?: string, afterRelease?: string },
 *   config?: Partial<RecommendationStabilityConfig>
 * }
 */
router.post("/recommendation-stability/compare", async (req, res) => {
  try {
    const { before, after, baseline, config } = req.body as {
      before?: RecommendationOutput[];
      after?: RecommendationOutput[];
      baseline?: {
        testSetId?: string;
        beforeRelease?: string;
        afterRelease?: string;
      };
      config?: Record<string, unknown>;
    };

    if (!Array.isArray(before) || !Array.isArray(after)) {
      return res
        .status(400)
        .json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Missing or invalid request body: expected { before: RecommendationOutput[], after: RecommendationOutput[] }",
            "analytics/recommendation-stability/compare",
          ),
        );
    }

    const report = generateRecommendationStabilityReport(
      before,
      after,
      baseline ?? {},
      config as any,
    );

    res.json(
      successEnvelope(report, "analytics/recommendation-stability/compare"),
    );
  } catch (error) {
    res
      .status(500)
      .json(
        errorEnvelope(
          "INTERNAL_ERROR",
          "Failed to compare recommendation stability",
          "analytics/recommendation-stability/compare",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

/**
 * GET /api/analytics/providers/uptime
 * Returns historical uptime reports for all known yield data providers.
 */
router.get("/providers/uptime", async (_req, res) => {
  try {
    const reports = await yieldReliabilityEngine.getAllProviderUptimeReports();
    res.json(successEnvelope(reports, "analytics/providers/uptime"));
  } catch (error) {
    console.error("Failed to fetch provider uptime reports:", error);
    res
      .status(500)
      .json(
        errorEnvelope(
          "UPTIME_FETCH_FAILED",
          "Unable to fetch provider uptime reports.",
          "analytics/providers/uptime",
        ),
      );
  }
});

/**
 * GET /api/analytics/recommendations/timeline/:walletAddress
 * Paginated recommendation timeline for a user
 * Query params: cursor (optional), limit (optional, default 20, max 100)
 */
router.get("/recommendations/timeline/:walletAddress", (req, res) => {
  try {
    const { walletAddress } = req.params;
    const { cursor, limit: rawLimit } = req.query;

    if (!walletAddress || typeof walletAddress !== "string") {
      return res
        .status(400)
        .json(
          errorEnvelope(
            "INVALID_WALLET",
            "walletAddress parameter is required and must be a string",
            "analytics/recommendations/timeline",
          ),
        );
    }

    const limit = parsePaginationLimitGeneric(rawLimit);
    const cursorStr = typeof cursor === "string" ? cursor : undefined;

    const paginated = getRecommendationTimelinePaginated(walletAddress, {
      cursor: cursorStr,
      limit,
    });

    res.json(successEnvelope(paginated, "analytics/recommendations/timeline"));
  } catch (error) {
    console.error("Recommendation timeline fetch failed:", error);
    res
      .status(500)
      .json(
        errorEnvelope(
          "TIMELINE_FETCH_FAILED",
          "Failed to fetch recommendation timeline",
          "analytics/recommendations/timeline",
          { message: error instanceof Error ? error.message : "Unknown error" },
        ),
      );
  }
});

export default router;
