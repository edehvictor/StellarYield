import { Router } from "express";
import {
  CURRENT_YIELDS_TTL_SECONDS,
  getYieldDataWithCacheStatus,
} from "../services/yieldService";
import { calculateNetYield } from "../services/netYieldEngine";

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
    const payload = hasCustomAssumptions
      ? yields.map((entry) => {
          const netYield = calculateNetYield(entry.totalApy, assumptions);
          return {
            ...entry,
            netApy: netYield.netApy,
            feeDragApy: netYield.feeDragApy,
            netYieldAssumptions: netYield.assumptions,
            netYieldSensitivity: netYield.sensitivity,
          };
        })
      : yields;
    res.setHeader(
      "Cache-Control",
      `public, max-age=${CURRENT_YIELDS_TTL_SECONDS}, stale-while-revalidate=30`,
    );
    res.setHeader("X-Cache-Status", cacheStatus);
    res.json(payload);
  } catch (error) {
    console.error("Failed to serve /api/yields.", error);
    res.status(500).json({
      error: "Unable to fetch yield data right now.",
      requestId: (_req as unknown as { requestId?: string }).requestId,
    });
  }
});

export default yieldsRouter;
