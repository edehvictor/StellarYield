import { Router, type Request } from "express";
import { sendError } from "../utils/errorResponse";
import {
  CURRENT_YIELDS_TTL_SECONDS,
  getYieldDataWithCacheStatus,
  getYieldParityReport,
  type PortfolioPositionInput,
} from "../services/yieldService";
import { formatParityReport } from "../utils/yieldNormalization";
import { calculateNetYield } from "../services/netYieldEngine";
import { yieldReliabilityEngine } from "../services/yieldReliabilityService";
import { getFeeHistory } from "../services/protocolFeeHistoryService";
import {
  OpportunityRankingService,
  type RankingWeights,
} from "../services/opportunityRankingService";
import { getAssetConfigVersion } from "../services/zapQuote";
import {
  buildYieldDiagnostic,
  type YieldFailureStage,
} from "../../../shared/types/yieldDiagnostics";
import { logYieldFailure } from "../utils/yieldDiagnosticsLog";

const yieldsRouter = Router();

/** Inclusive bounds for a fee/cost assumption in basis points (0% to 100%). */
export const MIN_ASSUMPTION_BPS = 0;
export const MAX_ASSUMPTION_BPS = 10_000;

/**
 * Parses an optional basis-point assumption from the query string (#1922).
 * - absent, empty or non-numeric → `undefined` (the engine default applies)
 * - a finite number within [0, 10,000] → that number
 * - a finite number outside the range, or ±Infinity → `null` (rejected, 400)
 * In-range values above the engine's own 3,000 bps ceiling are still clamped
 * by `calculateNetYield`, as before.
 */
export function parseAssumptionBps(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return undefined;
  if (!Number.isFinite(parsed)) return null;
  if (parsed < MIN_ASSUMPTION_BPS || parsed > MAX_ASSUMPTION_BPS) return null;
  return parsed;
}

/** Marks the processing stage a failure happened in. */
class YieldStageError extends Error {
  constructor(
    readonly stage: YieldFailureStage,
    readonly cause: unknown,
  ) {
    super(`yield stage ${stage} failed`);
    this.name = "YieldStageError";
  }
}

/**
 * Run `fn` as `stage`. Tagging the error where it is thrown (rather than in a
 * shared "current stage" variable) keeps attribution correct even though
 * entries are processed concurrently.
 */
async function inStage<T>(stage: YieldFailureStage, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw error instanceof YieldStageError ? error : new YieldStageError(stage, error);
  }
}

function getRequestId(req: Request): string | undefined {
  return (req as unknown as { requestId?: string }).requestId;
}

/** Fee assumption query parameters accepted by `GET /api/yields`. */
const ASSUMPTION_PARAMS = [
  "protocolFeeBps",
  "vaultFeeBps",
  "rebalanceCostBps",
  "slippageBps",
] as const;
type AssumptionParam = (typeof ASSUMPTION_PARAMS)[number];

/**
 * GET /api/yields
 *
 * Failures respond with the legacy `{ error, message, requestId }` fields plus
 * a privacy-safe `diagnostic` naming the failed stage and a remediation path.
 * See docs/yield-diagnostics.md. The handler is read-only: a failure at any
 * stage leaves the yield cache, fee history and every balance unchanged, so
 * the client can retry the same request safely.
 */
yieldsRouter.get("/", async (req, res) => {
  const requestId = getRequestId(req);

  // Validate before touching any data source, so a rejected request has no
  // side effects (e.g. it cannot trigger a refresh or a fee-history write).
  const assumptions = {
    protocolFeeBps: parseAssumptionBps(req.query.protocolFeeBps),
    vaultFeeBps: parseAssumptionBps(req.query.vaultFeeBps),
    rebalanceCostBps: parseAssumptionBps(req.query.rebalanceCostBps),
    slippageBps: parseAssumptionBps(req.query.slippageBps),
  };
  const outOfRange = (Object.entries(assumptions) as Array<[string, number | null | undefined]>)
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  if (outOfRange.length > 0) {
    const diagnostic = buildYieldDiagnostic("input_validation", requestId);
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({
      error: "INVALID_ASSUMPTION",
      message: `${outOfRange.join(", ")} must be between ${MIN_ASSUMPTION_BPS} and ${MAX_ASSUMPTION_BPS} bps.`,
      ...(diagnostic.requestId ? { requestId: diagnostic.requestId } : {}),
      recoverable: false,
      details: { fields: outOfRange },
      diagnostic,
    });
    return;
  }
  const checkedAssumptions = {
    protocolFeeBps: assumptions.protocolFeeBps ?? undefined,
    vaultFeeBps: assumptions.vaultFeeBps ?? undefined,
    rebalanceCostBps: assumptions.rebalanceCostBps ?? undefined,
    slippageBps: assumptions.slippageBps ?? undefined,
  };

  try {
    const { data: yields, cacheStatus } = await inStage("source_retrieval", () =>
      getYieldDataWithCacheStatus(),
    );
    if (!Array.isArray(yields)) {
      throw new YieldStageError("source_retrieval", new TypeError("yield data is not a list"));
    }
    const hasCustomAssumptions = Object.values(assumptions).some((value) => value != null);

    const payload = await Promise.all(yields.map(async (entry) => {
      const providerId = `${entry.protocolName.toLowerCase()}_api`;
      const score = await inStage("reliability_scoring", () =>
        yieldReliabilityEngine.calculateReliabilityScore(
          providerId,
          entry.protocolName,
          "api",
        ),
      );

      let isStale = false;
      const lastFetchMs = new Date(score?.signals?.lastSuccessfulFetch as string).getTime();
      const freshnessKnown = Number.isFinite(lastFetchMs);
      const ageSeconds = freshnessKnown
        ? Math.max(0, Math.round((Date.now() - lastFetchMs) / 1000))
        : Number.POSITIVE_INFINITY;

      // 30 minutes stale window. Unknown freshness is treated as stale.
      const freshness = score?.metrics?.freshness;
      if (ageSeconds > 30 * 60 || !(typeof freshness === "number" && freshness >= 0.5)) {
        isStale = true;
      }

      const warnings: string[] = [];
      if (!freshnessKnown) {
        warnings.push(
          `Freshness of yield data from ${entry.protocolName} could not be determined.`,
        );
      } else if (isStale) {
        warnings.push(`Yield data from ${entry.protocolName} is stale (${Math.round(ageSeconds / 60)}m old).`);
      }
      if (score?.status === "unreliable") {
        warnings.push(`Yield source ${entry.protocolName} is unhealthy.`);
      } else if (score?.status === "low" || score?.status === "medium") {
        warnings.push(`Yield source ${entry.protocolName} is degraded.`);
      }

      return inStage("yield_enrichment", () => {
        const netYield = calculateNetYield(
          entry.totalApy,
          hasCustomAssumptions ? checkedAssumptions : undefined,
        );
        // Recent protocol fee changes (#1147), newest-first. Sourced from
        // protocolFeeHistoryService, which records a snapshot whenever the
        // combined management + performance fee for this protocol changes.
        // Always an array (never null/undefined) so the client can render a
        // stable empty state without extra null-checks.
        const feeHistory = getFeeHistory(entry.protocolName);

        return {
          ...entry,
          netApy: netYield.netApy,
          feeDragApy: netYield.feeDragApy,
          netYieldAssumptions: netYield.assumptions,
          netYieldSensitivity: netYield.sensitivity,
          feeAttribution: netYield.feeAttribution,
          isStale,
          reliabilityStatus: score?.status ?? "unknown",
          warnings,
          feeHistory,
        };
      });
    }));

    // Compute the config fingerprint before writing any header so an encoding
    // failure can still be reported as a clean error response.
    const { body, configVersion } = await inStage("response_serialization", () => ({
      body: JSON.stringify(payload),
      // Immutable configuration fingerprint (#stale-config): clients use this
      // to detect when the asset configuration snapshot has changed between
      // the quote that was shown and the one that would be executed. When the
      // fingerprint received with a quote no longer matches the one on the
      // current response the client must refresh before submitting.
      configVersion: getAssetConfigVersion(),
    }));
    res.setHeader(
      "Cache-Control",
      `public, max-age=${CURRENT_YIELDS_TTL_SECONDS}, stale-while-revalidate=30`,
    );
    res.setHeader("X-Cache-Status", cacheStatus);
    res.setHeader("X-Config-Version", configVersion);
    res.type("application/json").send(body);
  } catch (error) {
    const stage = error instanceof YieldStageError ? error.stage : undefined;
    const diagnostic = buildYieldDiagnostic(stage, requestId);
    logYieldFailure(diagnostic, error instanceof YieldStageError ? error.cause : error);
    // One response only: a second write after sendError threw
    // ERR_HTTP_HEADERS_SENT and hid the original failure (#1922).
    if (res.headersSent) return;
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({
      error: "YIELD_FETCH_FAILED",
      message: "Unable to fetch yield data right now.",
      ...(diagnostic.requestId ? { requestId: diagnostic.requestId } : {}),
      recoverable: diagnostic.retryable,
      diagnostic,
    });
  }
});

yieldsRouter.get("/ranking", async (req, res) => {
  try {
    const customWeights: Partial<RankingWeights> = {};
    const parseParam = (val: unknown): number | undefined => {
      if (val === undefined || val === null) return undefined;
      const parsed = Number(val);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    };

    const apy = parseParam(req.query.apy);
    if (apy !== undefined) customWeights.apy = apy;
    const liquidity = parseParam(req.query.liquidity);
    if (liquidity !== undefined) customWeights.liquidity = liquidity;
    const volatility = parseParam(req.query.volatility);
    if (volatility !== undefined) customWeights.volatility = volatility;
    const maturity = parseParam(req.query.maturity);
    if (maturity !== undefined) customWeights.maturity = maturity;
    const tvl = parseParam(req.query.tvl);
    if (tvl !== undefined) customWeights.tvl = tvl;

    const ranked = await OpportunityRankingService.rankOpportunities(customWeights);
    res.json(ranked);
  } catch (error) {
    console.error("Failed to rank opportunities.", error);
    sendError(res, 500, "RANKING_FAILED", "Unable to rank opportunities right now.");
  }
});

/**
 * GET /api/yields/parity
 *
 * Runs the yield normalization parity check between the market feed and a
 * portfolio summary built from that same feed, and returns the diagnostics.
 *
 * Optional `?positions=Blend:5000,Soroswap:2500` weights the summary by an
 * actual portfolio; without it every protocol is weighted equally.
 *
 * Always 200 — this is a diagnostic report, not a request that can fail
 * validation. Alert on `inParity: false`.
 */
yieldsRouter.get("/parity", async (req, res) => {
  try {
    const positions = parsePositionsQuery(req.query.positions);
    const report = await getYieldParityReport(positions);

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ...report,
      diagnostics: formatParityReport(report),
    });
  } catch (error) {
    console.error("Failed to serve /api/yields/parity.", error);
    sendError(
      res,
      500,
      "YIELD_PARITY_FAILED",
      "Unable to run the yield normalization parity check right now.",
    );
  }
});

/**
 * Parses `Blend:5000,Soroswap:2500` into portfolio positions. Malformed or
 * non-positive entries are dropped rather than rejected, so a bad query string
 * degrades to the equal-weight default instead of hiding a real parity break.
 */
function parsePositionsQuery(raw: unknown): PortfolioPositionInput[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;

  const positions: PortfolioPositionInput[] = [];
  for (const chunk of raw.split(",")) {
    const [protocol, value] = chunk.split(":");
    const valueUsd = Number(value);
    if (!protocol?.trim() || !Number.isFinite(valueUsd) || valueUsd <= 0) continue;
    positions.push({ protocol: protocol.trim(), valueUsd });
  }

  return positions.length > 0 ? positions : undefined;
}

export default yieldsRouter;
