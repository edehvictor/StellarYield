import { Router } from "express";
import {
  createWatchlistRule,
  getUserWatchlist,
  updateWatchlistRule,
  deleteWatchlistRule,
  evaluateWatchlistRules,
} from "../services/watchlistService";

const watchlistRouter = Router();

watchlistRouter.post("/", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"] as string || req.body.walletAddress;
    if (!userId) {
      res.status(400).json({ error: "User ID is required" });
      return;
    }

    const rule = await createWatchlistRule({
      userId,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      targetName: req.body.targetName,
      conditions: req.body.conditions,
      notificationChannels: req.body.notificationChannels,
    });

    res.status(201).json(rule);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Failed to create watchlist rule.", errorMessage.replace(/[\n\r]/g, " "));
    res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to create watchlist rule",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

watchlistRouter.get("/", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"] as string || req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: "User ID is required" });
      return;
    }

    const rules = await getUserWatchlist(userId);
    res.json(rules);
  } catch (error) {
    console.error("Failed to fetch watchlist.", error);
    res.status(500).json({
      error: "Failed to fetch watchlist",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

watchlistRouter.put("/:ruleId", async (req, res) => {
  try {
    const rule = await updateWatchlistRule(req.params.ruleId, {
      status: req.body.status,
      conditions: req.body.conditions,
      notificationChannels: req.body.notificationChannels,
    });

    if (!rule) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }

    res.json(rule);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Failed to update watchlist rule.", errorMessage.replace(/[\n\r]/g, " "));
    res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to update rule",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

watchlistRouter.delete("/:ruleId", async (req, res) => {
  try {
    const deleted = await deleteWatchlistRule(req.params.ruleId);
    if (!deleted) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error("Failed to delete watchlist rule.", error);
    res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to delete rule",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

watchlistRouter.post("/evaluate", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"] as string || req.body.userId;
    const results = await evaluateWatchlistRules(userId);
    res.json(results);
  } catch (error) {
    console.error("Failed to evaluate rules.", error);
    res.status(500).json({
      error: "Failed to evaluate rules",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

export default watchlistRouter;