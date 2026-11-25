import { Router, Request, Response } from "express";
import { PROTOCOLS } from "../config/protocols";
import { calculateRiskScore, explainRiskScore } from "../utils/riskScoring";
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
import { sendExportError, sendError } from "../utils/errorResponse";
import { strategySnapshotVersioningService } from "../services/strategySnapshotVersioningService";
import { strategyLifecycleAuditService } from "../services/strategyLifecycleAuditService";
import {
  getStrategyComparisonState,
  getStrategyComparisonVersion,
  updateStrategyComparisonState,
  selectStrategyAndAllocate,
  StrategyComparisonVersionConflictError,
  StrategyComparisonValidationError,
  STRATEGY_COMPARISON_VERSION_CONFLICT,
  INVALID_STRATEGY_COMPARISON_STATE,
} from "../services/strategyComparisonConcurrencyService";

const router = Router();

const VALID_TIME_WINDOWS: TimeWindow[] = ["24h", "7d", "30d", "all"];
const CACHE_TTL = 60_000;
let cache: { data: unknown; ts: number; configFingerprint: string } | null = null;

let activeComparisonConfig: StrategyComparisonConfig = { ...DEFAULT_STRATEGY_COMPARISON_CONFIG };

export function getActiveComparisonConfig(): StrategyComparisonConfig {
  return activeComparisonConfig;
}

export function setActiveComparisonConfig(config: StrategyComparisonConfig): void {
  activeComparisonConfig = config;
}

export function resetActiveComparisonConfig(): void {
  activeComparisonConfig = { ...DEFAULT_STRATEGY_COMPARISON_CONFIG };
}

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

  const currentFpResult = computeStrategyComparisonConfigFingerprint(activeComparisonConfig);
  const currentConfigFingerprint = currentFpResult.fingerprint;

  const now = Date.now();
  if (
    process.env.NODE_ENV !== "test" &&
    cache &&
    now - cache.ts < CACHE_TTL &&
    cache.configFingerprint === currentConfigFingerprint &&
    timeWindow === "all" &&
    strategyType === "all"
  ) {
    res.setHeader("X-Strategy-Config-Fingerprint", currentConfigFingerprint);
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
    configFingerprint: currentConfigFingerprint,
    scoringMethodology:
      "RAY = APY × (riskScore / 10) / (1 + ilVolatility / 10). Ties resolved by TVL descending.",
    failover: {
      excluded: failover.excluded.map((s) => s.id),
      decisions: failover.decisions,
    },
    warnings,
  };

  if (timeWindow === "all" && strategyType === "all") {
    cache = { data: response, ts: now, configFingerprint: currentConfigFingerprint };
  }

  res.setHeader("X-Strategy-Config-Fingerprint", currentConfigFingerprint);
  res.json(response);
});

/**
 * GET /api/strategies/config-snapshot
 *
 * Returns the immutable configuration snapshot and its SHA-256 fingerprint
 * used for strategy comparisons.
 */
router.get("/config-snapshot", (_req: Request, res: Response) => {
  const fpResult = computeStrategyComparisonConfigFingerprint(activeComparisonConfig);
  res.setHeader("X-Strategy-Config-Fingerprint", fpResult.fingerprint);
  res.json({
    config: activeComparisonConfig,
    configFingerprint: fpResult.fingerprint,
    shortFingerprint: fpResult.shortFingerprint,
    generatedAt: fpResult.computedAt,
  });
});

/**
 * POST /api/strategies/compare
 *
 * Compares strategies against the active configuration snapshot.
 * If expectedConfigFingerprint is supplied and does not match the active
 * fingerprint, rejects with 409 STALE_STRATEGY_CONFIG without mutating state.
 */
router.post("/compare", async (req: Request, res: Response) => {
  const { expectedConfigFingerprint, strategyIds } = req.body || {};
  const currentFpResult = computeStrategyComparisonConfigFingerprint(activeComparisonConfig);

  if (expectedConfigFingerprint) {
    const verification = verifyStrategyComparisonConfigFingerprint(
      activeComparisonConfig,
      expectedConfigFingerprint,
    );
    if (!verification.valid) {
      res.setHeader("X-Strategy-Config-Fingerprint", currentFpResult.fingerprint);
      res.status(409).json({
        error: verification.message,
        code: verification.code,
        isRecoverable: true,
        currentFingerprint: currentFpResult.fingerprint,
        currentConfig: activeComparisonConfig,
      });
      return;
    }
  }

  let strategies = buildStrategies();
  if (Array.isArray(strategyIds) && strategyIds.length > 0) {
    const ids = new Set(strategyIds.map((id: string) => String(id).toLowerCase()));
    strategies = strategies.filter((s) => ids.has(s.id.toLowerCase()));
  }

  res.setHeader("X-Strategy-Config-Fingerprint", currentFpResult.fingerprint);
  res.json({
    strategies,
    configFingerprint: currentFpResult.fingerprint,
    comparedAt: new Date().toISOString(),
  });
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
    sendExportError(res, error);
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
    sendExportError(res, error);
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

/**
 * GET /api/strategies/:strategyId/lifecycle
 *
 * Returns the full event-sourced lifecycle history for a strategy.
 * Events are returned in insertion (chronological) order.
 *
 * Query params:
 *   correlationId — when provided, scopes results to a single chain and
 *                   includes a traceability summary.
 */
router.get("/:strategyId/lifecycle", (req: Request, res: Response) => {
  const { strategyId } = req.params;
  const correlationId = req.query.correlationId as string | undefined;

  if (correlationId) {
    const summary = strategyLifecycleAuditService.getCorrelationSummary(correlationId);
    // Guard: only return events that belong to the requested strategy.
    const filtered = summary.events.filter((e) => e.strategyId === strategyId);
    res.json({
      strategyId,
      correlationId,
      events: filtered,
      path: filtered.map((e) => e.type),
      isComplete: summary.isComplete,
      isTraceable: strategyLifecycleAuditService.isTraceable(strategyId),
    });
    return;
  }

  const events = strategyLifecycleAuditService.getHistory(strategyId);
  res.json({
    strategyId,
    events,
    path: events.map((e) => e.type),
    isTraceable: strategyLifecycleAuditService.isTraceable(strategyId),
    total: events.length,
  });
});

/**
 * GET /api/strategies/:strategyId/risk-explanation
 *
 * #1416 — Human-readable metadata for a strategy's risk score: which
 * factors (TVL, IL volatility, protocol age) are driving it up or down,
 * and a one-sentence plain-language reason for each, alongside the
 * existing numeric score/breakdown.
 */
router.get("/:strategyId/risk-explanation", (req: Request, res: Response) => {
  const { strategyId } = req.params;
  const protocol = PROTOCOLS.find((p) => p.protocolName.toLowerCase() === strategyId.toLowerCase());

  if (!protocol) {
    sendError(res, 404, "STRATEGY_NOT_FOUND", `No strategy found with id "${strategyId}"`, undefined, undefined, false);
    return;
  }

  const input = {
    tvlUsd: protocol.baseTvlUsd,
    ilVolatilityPct: protocol.volatilityPct,
    protocolAgeDays: protocol.protocolAgeDays,
  };
  const result = calculateRiskScore(input);
  const explanation = explainRiskScore(result, input);

  res.json({
    strategyId: protocol.protocolName.toLowerCase(),
    ...explanation,
    breakdown: result.breakdown,
  });
});

/**
 * Reads expectedVersion from If-Match header or body (#1919).
 */
export function readComparisonExpectedVersion(req: Request): number | undefined {
  const header = req.headers["if-match"];
  const raw =
    typeof header === "string" && header.trim() !== ""
      ? header.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1")
      : (req.body as { expectedVersion?: unknown } | undefined)?.expectedVersion;

  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value < 0 || String(raw).trim() === "") {
    throw new StrategyComparisonValidationError(
      "If-Match / expectedVersion must be a non-negative integer version",
    );
  }
  return value;
}

function readOperationIdentity(req: Request): string | undefined {
  const header =
    req.headers["x-operation-identity"] || req.headers["idempotency-key"];
  if (typeof header === "string" && header.trim() !== "") {
    return header.trim();
  }
  const bodyId = (req.body as { operationIdentity?: unknown } | undefined)?.operationIdentity;
  if (typeof bodyId === "string" && bodyId.trim() !== "") {
    return bodyId.trim();
  }
  return undefined;
}

/**
 * GET /api/strategies/comparison/state/:walletAddress
 *
 * Returns current strategy comparison workspace state and its version
 * with optimistic-concurrency headers.
 */
router.get("/comparison/state/:walletAddress", (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  if (!walletAddress || walletAddress.trim() === "") {
    res.status(400).json({ error: "walletAddress parameter is required." });
    return;
  }

  const state = getStrategyComparisonState(walletAddress);
  res.setHeader("ETag", `"${state.version}"`);
  res.setHeader("X-Comparison-Version", String(state.version));
  res.json({
    state,
    version: state.version,
  });
});

/**
 * PUT /api/strategies/comparison/state
 *
 * Updates strategy comparison state under optimistic concurrency.
 * If expectedVersion is supplied and does not match current version,
 * returns 409 STRATEGY_COMPARISON_VERSION_CONFLICT without mutating state.
 */
router.put("/comparison/state", (req: Request, res: Response) => {
  const {
    walletAddress,
    selectedStrategyId,
    pinnedStrategyIds,
    customAssumptions,
    allocatedBalances,
  } = req.body || {};

  if (!walletAddress || typeof walletAddress !== "string" || walletAddress.trim() === "") {
    res.status(400).json({ error: "walletAddress is required in request body." });
    return;
  }

  let expectedVersion: number | undefined;
  try {
    expectedVersion = readComparisonExpectedVersion(req);
  } catch (err) {
    if (err instanceof StrategyComparisonValidationError) {
      res.status(400).json({ code: err.code, error: err.message });
      return;
    }
    throw err;
  }

  const operationIdentity = readOperationIdentity(req);

  try {
    const { state, isReplay } = updateStrategyComparisonState(
      walletAddress,
      {
        selectedStrategyId,
        pinnedStrategyIds,
        customAssumptions,
        allocatedBalances,
      },
      {
        expectedVersion,
        operationIdentity,
      },
    );

    res.setHeader("ETag", `"${state.version}"`);
    res.setHeader("X-Comparison-Version", String(state.version));
    if (isReplay) {
      res.setHeader("X-Idempotent-Replayed", "true");
    }

    res.json({
      state,
      version: state.version,
      isReplay,
    });
  } catch (err) {
    if (err instanceof StrategyComparisonVersionConflictError) {
      res.setHeader("ETag", `"${err.currentVersion}"`);
      res.setHeader("X-Comparison-Version", String(err.currentVersion));
      res.status(409).json({
        code: err.code,
        error: err.message,
        expectedVersion: err.expectedVersion,
        currentVersion: err.currentVersion,
        state: err.currentState,
      });
      return;
    }

    if (err instanceof StrategyComparisonValidationError) {
      res.status(400).json({
        code: err.code,
        error: err.message,
        details: err.details,
      });
      return;
    }

    res.status(500).json({
      code: "STRATEGY_COMPARISON_UPDATE_FAILED",
      error: err instanceof Error ? err.message : "Failed to update strategy comparison state.",
    });
  }
});

/**
 * POST /api/strategies/comparison/select
 *
 * Atomically selects a strategy and allocates funds under OCC.
 */
router.post("/comparison/select", (req: Request, res: Response) => {
  const { walletAddress, strategyId, allocationUsd } = req.body || {};

  if (!walletAddress || typeof walletAddress !== "string" || walletAddress.trim() === "") {
    res.status(400).json({ error: "walletAddress is required." });
    return;
  }

  if (!strategyId || typeof strategyId !== "string" || strategyId.trim() === "") {
    res.status(400).json({ error: "strategyId is required." });
    return;
  }

  const parsedAllocation = Number(allocationUsd);
  if (!Number.isFinite(parsedAllocation) || parsedAllocation < 0) {
    res.status(400).json({
      code: INVALID_STRATEGY_COMPARISON_STATE,
      error: "allocationUsd must be a non-negative finite number.",
    });
    return;
  }

  let expectedVersion: number | undefined;
  try {
    expectedVersion = readComparisonExpectedVersion(req);
  } catch (err) {
    if (err instanceof StrategyComparisonValidationError) {
      res.status(400).json({ code: err.code, error: err.message });
      return;
    }
    throw err;
  }

  const operationIdentity = readOperationIdentity(req);

  try {
    const { state, isReplay } = selectStrategyAndAllocate(
      walletAddress,
      strategyId,
      parsedAllocation,
      {
        expectedVersion,
        operationIdentity,
      },
    );

    res.setHeader("ETag", `"${state.version}"`);
    res.setHeader("X-Comparison-Version", String(state.version));
    if (isReplay) {
      res.setHeader("X-Idempotent-Replayed", "true");
    }

    res.json({
      state,
      version: state.version,
      isReplay,
    });
  } catch (err) {
    if (err instanceof StrategyComparisonVersionConflictError) {
      res.setHeader("ETag", `"${err.currentVersion}"`);
      res.setHeader("X-Comparison-Version", String(err.currentVersion));
      res.status(409).json({
        code: err.code,
        error: err.message,
        expectedVersion: err.expectedVersion,
        currentVersion: err.currentVersion,
        state: err.currentState,
      });
      return;
    }

    if (err instanceof StrategyComparisonValidationError) {
      res.status(400).json({
        code: err.code,
        error: err.message,
        details: err.details,
      });
      return;
    }

    res.status(500).json({
      code: "STRATEGY_SELECTION_FAILED",
      error: err instanceof Error ? err.message : "Failed to select strategy.",
    });
  }
});

export default router;
