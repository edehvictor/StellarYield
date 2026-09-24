import { Router, Request, Response } from "express";
import {
  PortfolioMovementService,
  SnapshotNotFoundError,
} from "../services/portfolioMovementService";
import {
  FreshnessQueryError,
  StaleValuationError,
  assertFreshValuation,
  parseValuationFreshnessQuery,
} from "../services/valuationFreshnessGuard";
import { sendError } from "../utils/errorResponse";
import { validateWalletAddress } from "../middleware/validation";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const movementService = new PortfolioMovementService(prisma);

const portfolioMovementRouter = Router();

/**
 * GET /api/portfolio/:walletAddress/daily-movement
 * Get today's portfolio movement (comparing against yesterday).
 *
 * Freshness guardrails (#1362) — opt-in via query params:
 * - `?requireFresh=true` → 409 STALE_VALUATION_SNAPSHOT when the backing
 *   snapshot is missing or older than the threshold; 404 SNAPSHOT_NOT_FOUND
 *   when no current snapshot exists.
 * - `?maxAgeMs=<positive int>` → override the freshness threshold.
 * Responses always include an additive `freshness` annotation; requests
 * without `requireFresh` keep their existing 200 behavior.
 */
portfolioMovementRouter.get(
  "/:walletAddress/daily-movement",
  validateWalletAddress,
  async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.params;
      const guard = parseValuationFreshnessQuery(
        req.query as Record<string, unknown>,
      );

      const movement = await movementService.getDailyMovement(walletAddress, {
        maxAgeMs: guard.maxAgeMs,
      });

      if (guard.requireFresh) {
        if (!movement.freshness?.snapshotValuedAt) {
          throw new SnapshotNotFoundError(walletAddress, movement.snapshotDate);
        }
        assertFreshValuation(movement.freshness);
      }

      res.json(movement);
    } catch (error) {
      if (error instanceof FreshnessQueryError) {
        return sendError(res, 400, error.code, error.message, error.details);
      }
      if (error instanceof SnapshotNotFoundError) {
        return sendError(res, 404, "SNAPSHOT_NOT_FOUND", error.message);
      }
      if (error instanceof StaleValuationError) {
        return sendError(
          res,
          409,
          error.code,
          error.message,
          error.freshness,
          undefined,
          true,
        );
      }
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
