/**
 * API routes for yield opportunity watchlist management
 * Endpoints for CRUD operations on watchlist items and threshold rules.
 */

import { Router, Request, Response } from "express";
import { WatchlistService } from "../services/watchlistService";

const router = Router();

/**
 * Extracts the wallet identity that scopes watchlist data.
 * Mirrors contacts.ts's getWalletAddress helper for consistency: this is a
 * self-reported header, not a cryptographically verified wallet address (no
 * signature-verified wallet-auth middleware exists in this codebase yet).
 * It is still a hard improvement over the previous hardcoded "user-1"
 * default, which shared one watchlist across every caller regardless of
 * which wallet was connected.
 */
const getWalletAddress = (req: Request): string | undefined => {
  return (
    (req.headers["x-wallet-address"] as string) ||
    (req.query.userId as string) ||
    req.body?.userId
  );
};

/**
 * GET /api/watchlist
 * Get user's watchlist with alerts summary
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = getWalletAddress(req);
    if (!userId) {
      res.status(401).json({ error: "Wallet address required", code: "WALLET_ADDRESS_REQUIRED" });
      return;
    }

    const watchlist = await WatchlistService.getUserWatchlist(userId);
    res.json(watchlist);
  } catch (error) {
    console.error("Error fetching watchlist:", error);
    res.status(500).json({ error: "Failed to fetch watchlist" });
  }
});

/**
 * GET /api/watchlist/alerts
 * Get all unacknowledged alerts for user
 */
router.get("/alerts", async (req: Request, res: Response) => {
  try {
    const userId = getWalletAddress(req);
    if (!userId) {
      res.status(401).json({ error: "Wallet address required", code: "WALLET_ADDRESS_REQUIRED" });
      return;
    }

    const alerts = await WatchlistService.getUserAlerts(userId);
    res.json({
      alerts,
      total: alerts.reduce((sum, item) => sum + item.alerts.length, 0),
    });
  } catch (error) {
    console.error("Error fetching alerts:", error);
    res.status(500).json({ error: "Failed to fetch alerts" });
  }
});

/**
 * POST /api/watchlist
 * Add opportunity to watchlist
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = getWalletAddress(req);
    if (!userId) {
      res.status(401).json({ error: "Wallet address required", code: "WALLET_ADDRESS_REQUIRED" });
      return;
    }

    const {
      opportunityId,
      opportunityType,
      opportunityName,
      currentApy,
      currentTvl,
    } = req.body;

    if (!opportunityId || !opportunityType || !opportunityName) {
      res.status(400).json({
        error: "Missing required fields: opportunityId, opportunityType, opportunityName",
      });
      return;
    }

    const item = await WatchlistService.addToWatchlist(
      userId,
      opportunityId,
      opportunityType,
      opportunityName,
      currentApy || 0,
      currentTvl || 0
    );

    res.status(201).json(item);
  } catch (error) {
    console.error("Error adding to watchlist:", error);
    res.status(500).json({ error: "Failed to add to watchlist" });
  }
});

/**
 * DELETE /api/watchlist/:itemId
 * Remove opportunity from watchlist
 */
router.delete("/:itemId", async (req: Request, res: Response) => {
  try {
    const userId = getWalletAddress(req);
    if (!userId) {
      res.status(401).json({ error: "Wallet address required", code: "WALLET_ADDRESS_REQUIRED" });
      return;
    }
    const { itemId } = req.params;

    const item = await WatchlistService.removeFromWatchlist(userId, itemId);
    res.json({ success: true, item });
  } catch (error) {
    console.error(`Error removing from watchlist:`, error);
    res.status(500).json({ error: "Failed to remove from watchlist" });
  }
});

/**
 * POST /api/watchlist/:itemId/rules
 * Add a threshold rule to watchlist item
 */
router.post("/:itemId/rules", async (req: Request, res: Response) => {
  try {
    const userId = getWalletAddress(req);
    if (!userId) {
      res.status(401).json({ error: "Wallet address required", code: "WALLET_ADDRESS_REQUIRED" });
      return;
    }
    const { itemId } = req.params;
    const { type, value, triggerOnce } = req.body;

    if (!type || typeof value !== "number") {
      res.status(400).json({
        error: "Missing or invalid required fields: type (string), value (number)",
      });
      return;
    }

    const rule = await WatchlistService.addThresholdRule(
      userId,
      itemId,
      type,
      value,
      triggerOnce || false
    );

    res.status(201).json(rule);
  } catch (error) {
    console.error("Error adding threshold rule:", error);
    res
      .status(error instanceof Error && error.message.includes("not found") ? 404 : 500)
      .json({
        error:
          error instanceof Error ? error.message : "Failed to add threshold rule",
      });
  }
});

/**
 * DELETE /api/watchlist/:itemId/rules/:ruleId
 * Remove a threshold rule from watchlist item
 */
router.delete("/:itemId/rules/:ruleId", async (req: Request, res: Response) => {
  try {
    const userId = getWalletAddress(req);
    if (!userId) {
      res.status(401).json({ error: "Wallet address required", code: "WALLET_ADDRESS_REQUIRED" });
      return;
    }
    const { itemId, ruleId } = req.params;

    await WatchlistService.removeThresholdRule(userId, itemId, ruleId);
    res.json({ success: true });
  } catch (error) {
    console.error("Error removing threshold rule:", error);
    res
      .status(error instanceof Error && error.message.includes("not found") ? 404 : 500)
      .json({
        error:
          error instanceof Error ? error.message : "Failed to remove threshold rule",
      });
  }
});

/**
 * POST /api/watchlist/:itemId/check
 * Check thresholds for a specific item and trigger alerts
 */
router.post("/:itemId/check", async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const { currentApy, currentTvl, spreadChange } = req.body;

    const results = await WatchlistService.checkThresholdsAndTriggerAlerts(
      itemId,
      currentApy || 0,
      currentTvl || 0,
      spreadChange || 0
    );

    res.json({
      itemId,
      checks: results,
      triggeredCount: results.filter((r) => r.triggered).length,
    });
  } catch (error) {
    console.error("Error checking thresholds:", error);
    res.status(500).json({ error: "Failed to check thresholds" });
  }
});

/**
 * POST /api/watchlist/:itemId/alerts/:ruleId/acknowledge
 * Acknowledge an alert for a specific rule
 */
router.post("/:itemId/alerts/:ruleId/acknowledge", async (req: Request, res: Response) => {
  try {
    const userId = getWalletAddress(req);
    if (!userId) {
      res.status(401).json({ error: "Wallet address required", code: "WALLET_ADDRESS_REQUIRED" });
      return;
    }
    const { itemId, ruleId } = req.params;

    await WatchlistService.acknowledgeAlert(userId, itemId, ruleId);
    res.json({ success: true });
  } catch (error) {
    console.error("Error acknowledging alert:", error);
    res
      .status(error instanceof Error && error.message.includes("not found") ? 404 : 500)
      .json({
        error:
          error instanceof Error ? error.message : "Failed to acknowledge alert",
      });
  }
});

/**
 * POST /api/watchlist/batch/check
 * Batch check thresholds for multiple items
 * Useful for periodic threshold checks
 */
router.post("/batch/check", async (req: Request, res: Response) => {
  try {
    const { items } = req.body; // Array of { itemId, currentApy, currentTvl, spreadChange? }

    if (!Array.isArray(items)) {
      res.status(400).json({ error: "items must be an array" });
      return;
    }

    const results = await WatchlistService.batchCheckThresholds(items);

    res.json({
      checked: items.length,
      triggeredCount: results.filter((r) => r.triggered).length,
      results,
    });
  } catch (error) {
    console.error("Error in batch threshold check:", error);
    res.status(500).json({ error: "Failed to check thresholds" });
  }
});

export default router;
