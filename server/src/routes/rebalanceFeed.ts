import { Router } from "express";
import {
  getRebalanceFeed,
  getLatestRebalance,
  getRebalanceById,
  recordRebalanceEvent,
} from "../services/rebalanceFeedService";

const rebalanceFeedRouter = Router();

rebalanceFeedRouter.get("/", async (req, res) => {
  try {
    const vaultId = req.query.vaultId as string | undefined;
    const limit = Math.min(Number.parseInt(req.query.limit as string, 10) || 20, 100);
    const beforeTimestamp = req.query.beforeTimestamp as string | undefined;

    const feed = await getRebalanceFeed(vaultId, limit, beforeTimestamp);

    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
    res.json(feed);
  } catch (error) {
    console.error("Failed to serve rebalance feed.", error);
    res.status(500).json({
      error: "Unable to fetch rebalance feed",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

rebalanceFeedRouter.get("/latest", async (req, res) => {
  try {
    const vaultId = req.query.vaultId as string;
    if (!vaultId) {
      res.status(400).json({ error: "vaultId is required" });
      return;
    }

    const event = await getLatestRebalance(vaultId);

    if (!event) {
      res.status(404).json({ error: "No rebalance events found" });
      return;
    }

    res.json(event);
  } catch (error) {
    console.error("Failed to serve latest rebalance.", error);
    res.status(500).json({
      error: "Unable to fetch latest rebalance",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

rebalanceFeedRouter.get("/:eventId", async (req, res) => {
  try {
    const event = await getRebalanceById(req.params.eventId);

    if (!event) {
      rebalanceFeedRouter.stack;
      res.status(404).json({ error: "Rebalance event not found" });
      return;
    }

    res.json(event);
  } catch (error) {
    console.error("Failed to serve rebalance event.", error);
    res.status(500).json({
      error: "Unable to fetch rebalance event",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

rebalanceFeedRouter.post("/", async (req, res) => {
  try {
    const {
      vaultId,
      vaultName,
      triggerReason,
      expectedOutcome,
      riskNote,
      beforeAllocations,
      afterAllocations,
      status,
    } = req.body;

    if (!vaultId || !vaultName || !triggerReason || !expectedOutcome) {
      res.status(400).json({
        error: "Missing required fields: vaultId, vaultName, triggerReason, expectedOutcome",
      });
      return;
    }

    if (!Array.isArray(beforeAllocations) || !Array.isArray(afterAllocations)) {
      res.status(400).json({
        error: "beforeAllocations and afterAllocations must be arrays",
      });
      return;
    }

    const event = await recordRebalanceEvent(
      vaultId,
      vaultName,
      triggerReason,
      expectedOutcome,
      riskNote || "",
      beforeAllocations,
      afterAllocations,
      status || "completed",
    );

    res.status(201).json(event);
  } catch (error) {
    console.error("Failed to record rebalance event.", error);
    res.status(500).json({
      error: "Unable to record rebalance event",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

export default rebalanceFeedRouter;