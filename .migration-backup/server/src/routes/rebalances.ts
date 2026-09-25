/**
 * API routes for vault rebalance event feed.
 * Provides endpoints for fetching rebalance history and real-time updates.
 */

import { Router, Request, Response } from "express";
import { RebalanceEventService } from "../services/rebalanceEventService";
import type { RebalanceFeedOptions } from "../../shared/types/rebalanceEvent";

const router = Router();

/**
 * GET /api/rebalances
 * Fetch rebalance events with optional filtering and pagination.
 * 
 * Query parameters:
 * - vaultId: Filter by vault ID
 * - limit: Number of results (max 100)
 * - offset: Pagination offset
 * - triggerReason: Filter by trigger reason
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const options: RebalanceFeedOptions = {
      vaultId: req.query.vaultId as string | undefined,
      limit: req.query.limit ? Math.min(parseInt(req.query.limit as string), 100) : 20,
      offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
      triggerReason: req.query.triggerReason as any,
    };

    const result = await RebalanceEventService.getRebalanceEvents(options);
    res.json(result);
  } catch (error) {
    console.error("Error fetching rebalance events:", error);
    res.status(500).json({ error: "Failed to fetch rebalance events" });
  }
});

/**
 * GET /api/rebalances/:vaultId/recent
 * Get recent rebalance events for a specific vault (for real-time feed).
 */
router.get("/:vaultId/recent", async (req: Request, res: Response) => {
  try {
    const { vaultId } = req.params;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string), 100) : 10;

    const events = await RebalanceEventService.getRecentRebalances(vaultId, limit);
    res.json({
      vaultId,
      events,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Error fetching recent rebalances for vault ${req.params.vaultId}:`, error);
    res.status(500).json({ error: "Failed to fetch recent rebalances" });
  }
});

/**
 * GET /api/rebalances/:vaultId/stats
 * Get rebalance statistics for a specific vault.
 */
router.get("/:vaultId/stats", async (req: Request, res: Response) => {
  try {
    const { vaultId } = req.params;
    const stats = await RebalanceEventService.getRebalanceStats(vaultId);
    res.json({
      vaultId,
      ...stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Error fetching rebalance stats for vault ${req.params.vaultId}:`, error);
    res.status(500).json({ error: "Failed to fetch rebalance statistics" });
  }
});

/**
 * POST /api/rebalances
 * Create a new rebalance event record.
 * Admin/internal endpoint - requires authentication in production.
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const eventData = req.body;

    // Validate required fields
    if (!eventData.vaultId || !eventData.vaultName || !eventData.triggerReason) {
      res.status(400).json({
        error: "Missing required fields: vaultId, vaultName, triggerReason",
      });
      return;
    }

    const event = await RebalanceEventService.createRebalanceEvent(eventData);
    res.status(201).json(event);
  } catch (error) {
    console.error("Error creating rebalance event:", error);
    res.status(500).json({ error: "Failed to create rebalance event" });
  }
});

/**
 * PATCH /api/rebalances/:eventId
 * Update a rebalance event (e.g., to mark as completed).
 * Admin/internal endpoint - requires authentication in production.
 */
router.patch("/:eventId", async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const updates = req.body;

    const event = await RebalanceEventService.updateRebalanceEvent(eventId, updates);
    res.json(event);
  } catch (error) {
    console.error(`Error updating rebalance event ${req.params.eventId}:`, error);
    res.status(500).json({ error: "Failed to update rebalance event" });
  }
});

export default router;
