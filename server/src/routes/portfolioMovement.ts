import { Router, Request, Response } from "express";
import {
  PortfolioMovementService,
  SnapshotNotFoundError,
} from "../services/portfolioMovementService";
import { sendError } from "../utils/errorResponse";
import { validateWalletAddress } from "../middleware/validation";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const movementService = new PortfolioMovementService(prisma);

const portfolioMovementRouter = Router();

/**
 * GET /api/portfolio/:walletAddress/daily-movement
 * Get today's portfolio movement (comparing against yesterday).
 */
portfolioMovementRouter.get(
  "/:walletAddress/daily-movement",
  validateWalletAddress,
  async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.params;

      const movement = await movementService.getDailyMovement(walletAddress);

      res.json(movement);
    } catch (error) {
      sendError(
        res,
        500,
        "DAILY_MOVEMENT_FAILED",
        "Failed to fetch daily movement.",
      );
    }
  },
);

/**
 * GET /api/portfolio/:walletAddress/movement-history
 * Get portfolio movement history for N days.
 */
portfolioMovementRouter.get(
  "/:walletAddress/movement-history",
  validateWalletAddress,
  async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.params;
      const days = Math.min(parseInt(req.query.days as string) || 30, 365);

      const history = await movementService.getMovementHistory(
        walletAddress,
        days,
      );

      res.json({
        walletAddress,
        days,
        movements: history,
      });
    } catch (error) {
      sendError(
        res,
        500,
        "MOVEMENT_HISTORY_FAILED",
        "Failed to fetch movement history.",
      );
    }
  },
);

/**
 * GET /api/portfolio/:walletAddress/compare-snapshots?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Compares two arbitrary daily snapshots (not necessarily consecutive) and
 * returns a structured diff: per-asset value/quantity changes plus which
 * assets were added or removed between the two dates.
 */
portfolioMovementRouter.get(
  "/:walletAddress/compare-snapshots",
  validateWalletAddress,
  async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.params;
      const { from, to } = req.query;

      if (typeof from !== "string" || typeof to !== "string") {
        return sendError(
          res,
          400,
          "INVALID_QUERY",
          "Both `from` and `to` query parameters (ISO dates) are required.",
        );
      }

      const fromDate = new Date(from);
      const toDate = new Date(to);

      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        return sendError(
          res,
          400,
          "INVALID_QUERY",
          "`from` and `to` must be parseable ISO dates.",
        );
      }

      const comparison = await movementService.compareSnapshotsByDate(
        walletAddress,
        fromDate,
        toDate,
      );

      res.json(comparison);
    } catch (error) {
      if (error instanceof SnapshotNotFoundError) {
        return sendError(res, 404, "SNAPSHOT_NOT_FOUND", error.message);
      }
      sendError(
        res,
        500,
        "SNAPSHOT_COMPARISON_FAILED",
        "Failed to compare portfolio snapshots.",
      );
    }
  },
);

export default portfolioMovementRouter;
