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
} from "../services/protocolFailoverService";
import { rotationRegistry } from "../services/strategyRotationService";
import { exportService } from "../services/exportService";

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
function buildHealthSnapshot(now: number): Map<string, ProtocolHealthInput> {
  const snapshot = new Map<string, ProtocolHealthInput>();
  for (const p of PROTOCOLS) {
    snapshot.set(p.protocolName.toLowerCase(), {
      id: p.protocolName.toLowerCase(),
      name: p.protocolName,
      status: "healthy",
      lastUpdatedAt: new Date(now).toISOString(),
      providerUptime: 0.999,
      recentErrorCount: 0,
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
router.get("/leaderboard", (req: Request, res: Response) => {
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
  const failover = failoverRegistry.apply(strategies, buildHealthSnapshot(now));
  const ranked = rankStrategies(failover.included);

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
    const bundle = await exportService.generateSnapshotBundle();
    const filename = `stellar-yield-snapshot-${new Date().toISOString().split('T')[0]}.json`;
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.json(bundle);
  } catch (error) {
    console.error("Export failed:", error);
    res.status(500).json({ error: "Failed to generate export bundle" });
  }
});

export default router;
