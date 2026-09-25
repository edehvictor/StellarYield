/**
 * indexer.ts (routes)
 *
 * Read-only operator route for the contract event indexer.
 *
 * GET /api/indexer/status
 *   Returns the latest indexed ledger (replay checkpoint), the latest network
 *   ledger, lag from Horizon, recent replay errors, and a degraded/unavailable
 *   status when the indexer falls behind. Read-only — never mutates indexer state.
 */
import { Router, Request, Response } from "express";
import { getIndexerStatusSnapshot } from "../indexer/indexerStatus";

const router = Router();

router.get("/status", async (_req: Request, res: Response) => {
  try {
    const snapshot = await getIndexerStatusSnapshot();
    res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=10");
    res.json({ success: true, data: snapshot });
  } catch (error) {
    console.error("Failed to build indexer status snapshot:", error);
    res.status(500).json({
      error: "Failed to build indexer status",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
