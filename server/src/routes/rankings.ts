import { Router } from "express";
import {
  DEFAULT_RANKING_WEIGHTS,
  calculateRankings,
} from "../services/yieldRankingService";

const rankingRouter = Router();

rankingRouter.get("/", async (_req, res) => {
  try {
    const weights = {
      apy: _req.query.apy
        ? Number.parseFloat(_req.query.apy as string)
        : undefined,
      tvl: _req.query.tvl
        ? Number.parseFloat(_req.query.tvl as string)
        : undefined,
      liquidity: _req.query.liquidity
        ? Number.parseFloat(_req.query.liquidity as string)
        : undefined,
      protocolMaturity: _req.query.protocolMaturity
        ? Number.parseFloat(_req.query.protocolMaturity as string)
        : undefined,
      volatility: _req.query.volatility
        ? Number.parseFloat(_req.query.volatility as string)
        : undefined,
    };

    const hasCustomWeights = Object.values(weights).some((v) => !Number.isNaN(v) && v !== undefined);
    const result = await calculateRankings(hasCustomWeights ? weights : undefined);

    res.setHeader(
      "Cache-Control",
      "public, max-age=300, stale-while-revalidate=30",
    );
    res.json(result);
  } catch (error) {
    console.error("Failed to serve /api/rankings.", error);
    res.status(500).json({
      error: "Unable to calculate rankings right now.",
      requestId: (_req as unknown as { requestId?: string }).requestId,
    });
  }
});

rankingRouter.get("/weights", (_req, res) => {
  res.json(DEFAULT_RANKING_WEIGHTS);
});

rankingRouter.get("/top/:rank", async (req, res) => {
  try {
    const rank = Number.parseInt(req.params.rank, 10);
    if (Number.isNaN(rank) || rank < 1 || rank > 20) {
      res.status(400).json({
        error: "Rank must be a number between 1 and 20.",
      });
      return;
    }

    const opportunity = await import("../services/yieldRankingService").then((m) =>
      m.getOpportunityByRank(rank),
    );

    if (!opportunity) {
      res.status(404).json({
        error: `No opportunity found at rank ${rank}.`,
      });
      return;
    }

    res.json(opportunity);
  } catch (error) {
      console.error("Failed to serve /api/rankings/top/:rank.", error);
      res.status(500).json({
        error: "Unable to fetch opportunity right now.",
        requestId: (req as unknown as { requestId?: string }).requestId,
      });
    }
  });

export default rankingRouter;