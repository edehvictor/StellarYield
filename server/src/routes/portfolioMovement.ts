import { Router, Request, Response } from "express";
import { PortfolioMovementService } from "../services/portfolioMovementService";
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

export default portfolioMovementRouter;
