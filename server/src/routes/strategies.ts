import { Router, Request, Response } from "express";
import { PROTOCOLS } from "../config/protocols";
import { calculateRiskScore } from "../utils/riskScoring";
import {
  rankStrategies,
  filterByTimeWindow,
  type StrategyInput,
  type TimeWindow,
} from "../services/riskAdjustedYieldService";
import {
  failoverRegistry,
  type ProtocolHealthInput,
  type ProtocolHealthStatus,
} from "../services/protocolFailoverService";
import { yieldReliabilityEngine } from "../services/yieldReliabilityService";
import { rotationRegistry } from "../services/strategyRotationService";
import { exportService } from "../services/exportService";
import { strategySnapshotVersioningService } from "../services/strategySnapshotVersioningService";

const router = Router();

const VALID_TIME_WINDOWS: TimeWindow[] = ["24h", "7d", "30d", "all"];
const CACHE_TTL = 60_000;
let cache: { data: unknown; ts: number } | null = null;

/**
 * Build a health snapshot for the configured protocols. In production this
 * would be fed by `strategyHealthService` and the indexer; here we derive a
 * stub from the protocol registry so the failover layer is wired through
 * end-to-end.
 */
async function buildHealthSnapshot(now: number): Promise<Map<string, ProtocolHealthInput>> {
  const snapshot = new Map<string, ProtocolHealthInput>();
  for (const p of PROTOCOLS) {
    const providerId = `${p.protocolName.toLowerCase()}_api`;
    const score = await yieldReliabilityEngine.calculateReliabilityScore(
      providerId,
      p.protocolName,
      "api",
    );

    let status: ProtocolHealthStatus = "healthy";
    if (score.status === "unreliable") {
      status = "down";
    } else if (score.status === "low") {
      status = "critical";
    } else if (score.status === "medium") {
      status = "degraded";
    }

    snapshot.set(p.protocolName.toLowerCase(), {
      id: p.protocolName.toLowerCase(),
      name: p.protocolName,
      status,
      lastUpdatedAt: score.signals.lastSuccessfulFetch || new Date(now).toISOString(),
      providerUptime: score.metrics.historicalUptime,
      recentErrorCount: score.signals.consecutiveFailures,
    });
  }
  return snapshot;
}

function buildStrategies(): StrategyInput[] {
  const now = new Date().toISOString();
  return PROTOCOLS.map((p) => {
    const riskResult = calculateRiskScore({
      tvlUsd: p.baseTvlUsd,
      ilVolatilityPct: p.volatilityPct,
      protocolAgeDays: p.protocolAgeDays,
    });
    return {
      id: p.protocolName.toLowerCase(),
      name: p.protocolName,
      strategyType: p.protocolType,
      apy: p.baseApyBps / 100,
      tvlUsd: p.baseTvlUsd,
      ilVolatilityPct: p.volatilityPct,
      riskScore: riskResult.score,
      fetchedAt: now,
    };
  });
}

/**
 * GET /api/strategies/leaderboard
 * Returns strategies ranked by risk-adjusted yield.
 *
 * Query params:
 *   timeWindow  — 24h | 7d | 30d | all (default: all)
 *   strategyType — blend | soroswap | defindex | all (default: all)
 */
router.get("/leaderboard", async (req: Request, res: Response) => {
  const timeWindow = (req.query.timeWindow as string) || "all";
  if (!VALID_TIME_WINDOWS.includes(timeWindow as TimeWindow)) {
    res.status(400).json({ error: "timeWindow must be one of: 24h, 7d, 30d, all" });
    return;
  }

  const strategyType = (req.query.strategyType as string) || "all";

  const now = Date.now();
  if (
    cache &&
    now - cache.ts < CACHE_TTL &&
    timeWindow === "all" &&
    strategyType === "all"
  ) {
    res.json(cache.data);
    return;
  }

  let strategies = buildStrategies();
  strategies = filterByTimeWindow(strategies, timeWindow as TimeWindow);

  if (strategyType !== "all") {
    strategies = strategies.filter((s) => s.strategyType === strategyType);
  }

  // Apply protocol failover BEFORE ranking so excluded protocols never
  // surface as recommendations. The `failover` block in the response
  // documents every exclusion and recovery for transparency.
  const healthSnapshot = await buildHealthSnapshot(now);
  const failover = failoverRegistry.apply(strategies, healthSnapshot);
  const ranked = rankStrategies(failover.included);

  const warnings: string[] = [];
  for (const ev of failover.evaluations) {
    if (ev.severity === "warn") {
      warnings.push(`Yield source ${ev.protocolName} is degraded: ${ev.reasons.join(", ")}`);
    } else if (ev.shouldExclude) {
      warnings.push(`Yield source ${ev.protocolName} is unhealthy/stale and was excluded: ${ev.reasons.join(", ")}`);
    }
  }

  const response = {
    items: ranked,
    filters: { timeWindow, strategyType },
    total: ranked.length,
    scoringMethodology:
      "RAY = APY × (riskScore / 10) / (1 + ilVolatility / 10). Ties resolved by TVL descending.",
    failover: {
      excluded: failover.excluded.map((s) => s.id),
      decisions: failover.decisions,
    },
    warnings,
  };

  if (timeWindow === "all" && strategyType === "all") {
    cache = { data: response, ts: now };
  }

  res.json(response);
});

/**
 * GET /api/strategies/failover
 * Returns the most recent failover decisions and currently-excluded
 * protocols. Useful for ops dashboards and audit trails.
 */
router.get("/failover", (req: Request, res: Response) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
  res.json({
    excluded: failoverRegistry.excludedProtocols(),
    decisions: failoverRegistry.recentDecisions(limit),
  });
});

/**
 * GET /api/strategies/rotation
 * Returns the current rotation state and the most recent rotation
 * decisions (including no-ops with their reason).
 */
router.get("/rotation", (req: Request, res: Response) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
  res.json({
    current: rotationRegistry.current(),
    decisions: rotationRegistry.recentDecisions(limit),
  });
});

/**
 * GET /api/strategies/export
 * Exports a full snapshot bundle of current opportunity data.
 */
router.get("/export", async (req: Request, res: Response) => {
  try {
    const bundle = await exportService.generateSnapshotBundle(req.query);
    const filename = `stellar-yield-snapshot-${new Date().toISOString().split('T')[0]}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.json(bundle);
  } catch (error) {
    console.error("Export failed:", error);
    res.status(500).json({ error: "Failed to generate export bundle" });
  }
});

/**
 * GET /api/strategies/export/preview
 * Returns only the metadata for the current export bundle.
 */
router.get("/export/preview", async (req: Request, res: Response) => {
  try {
    const bundle = await exportService.generateSnapshotBundle(req.query);
    const { opportunities, ...metadata } = bundle;
    res.json(metadata);
  } catch (error) {
    console.error("Export preview failed:", error);
    res.status(500).json({ error: "Failed to generate export preview" });
  }
});

/**
 * GET /api/strategies/:strategyId/snapshots/:targetVersion/rollback-preview
 *
 * Returns a read-only diff between the current active snapshot and the
 * requested target version. No rollback is executed.
 *
 * Response includes:
 *   - changedFields: array of { field, current, target } for every field that differs
 *   - targetSnapshot: full snapshot DTO that would become active
 *   - safe: false when the target version is ARCHIVED (requires explicit override)
 */
router.get(
  "/:strategyId/snapshots/:targetVersion/rollback-preview",
  async (req: Request, res: Response) => {
    const { strategyId, targetVersion } = req.params;
    const version = Number(targetVersion);

    if (!Number.isInteger(version) || version < 1) {
      res.status(400).json({ error: "targetVersion must be a positive integer." });
      return;
    }

    const rollbackReason = req.query.reason as string | undefined;

    try {
      const preview = await strategySnapshotVersioningService.previewRollback(
        strategyId,
        version,
        rollbackReason,
      );
      res.json(preview);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to generate rollback preview.";
      if (message.includes("not found") || message.includes("No active snapshot")) {
        res.status(404).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  },
);

export default router;
