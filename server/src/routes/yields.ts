import { Router } from "express";
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

const yieldsRouter = Router();

yieldsRouter.get("/", async (_req, res) => {
  try {
    const { data: yields, cacheStatus } = await getYieldDataWithCacheStatus();
    const parseBps = (value: unknown): number | undefined => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const assumptions = {
      protocolFeeBps: parseBps(_req.query.protocolFeeBps),
      vaultFeeBps: parseBps(_req.query.vaultFeeBps),
      rebalanceCostBps: parseBps(_req.query.rebalanceCostBps),
      slippageBps: parseBps(_req.query.slippageBps),
    };
    const hasCustomAssumptions = Object.values(assumptions).some((value) => value != null);
    const payload = await Promise.all(yields.map(async (entry) => {
      const providerId = `${entry.protocolName.toLowerCase()}_api`;
      const score = await yieldReliabilityEngine.calculateReliabilityScore(
        providerId,
        entry.protocolName,
        "api",
      );

      let isStale = false;
      const lastFetchMs = new Date(score.signals.lastSuccessfulFetch).getTime();
      const ageSeconds = Number.isFinite(lastFetchMs)
        ? Math.max(0, Math.round((Date.now() - lastFetchMs) / 1000))
        : Number.POSITIVE_INFINITY;

      // 30 minutes stale window
      if (ageSeconds > 30 * 60 || score.metrics.freshness < 0.5) {
        isStale = true;
      }

      const warnings: string[] = [];
      if (isStale) {
        warnings.push(`Yield data from ${entry.protocolName} is stale (${Math.round(ageSeconds / 60)}m old).`);
      }
      if (score.status === "unreliable") {
        warnings.push(`Yield source ${entry.protocolName} is unhealthy.`);
      } else if (score.status === "low" || score.status === "medium") {
        warnings.push(`Yield source ${entry.protocolName} is degraded.`);
      }

      const netYield = calculateNetYield(
        entry.totalApy,
        hasCustomAssumptions ? assumptions : undefined,
      );
      return {
        ...entry,
        netApy: netYield.netApy,
        feeDragApy: netYield.feeDragApy,
        netYieldAssumptions: netYield.assumptions,
        netYieldSensitivity: netYield.sensitivity,
        feeAttribution: netYield.feeAttribution,
        isStale,
        reliabilityStatus: score.status,
        warnings,
      };
    }));
    res.setHeader(
      "Cache-Control",
      `public, max-age=${CURRENT_YIELDS_TTL_SECONDS}, stale-while-revalidate=30`,
    );
    res.setHeader("X-Cache-Status", cacheStatus);
    res.json(payload);
  } catch (error) {
    console.error("Failed to serve /api/yields.", error);
    sendError(res, 500, "YIELD_FETCH_FAILED", "Unable to fetch yield data right now.");
    res.status(500).json({
      error: "Unable to fetch yield data right now.",
      requestId: (_req as unknown as { requestId?: string }).requestId,
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

