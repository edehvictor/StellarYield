import { Router, Request, Response } from "express";
import {
  getBasketRebalancePreview,
  validateBasketTargetWeights,
} from "../services/stablecoinBasketPreview";

const router = Router();

/**
 * GET /api/strategies/stablecoin-basket/:contractId/rebalance-preview
 * Returns before/after weight rows for a pending rebalance. Always 200 —
 * an unavailable/empty basket returns a safe fallback state rather than
 * an error (source: "unavailable" or rebalanceNeeded: false).
 */
router.get("/:contractId/rebalance-preview", async (req: Request, res: Response) => {
  const { contractId } = req.params;
  const preview = await getBasketRebalancePreview(contractId);
  res.json(preview);
});

/**
 * POST /api/strategies/stablecoin-basket/:contractId/rebalance-preview/validate
 * Validates that proposed target weights sum to 100% (10,000 bps) before a
 * rebalance action is submitted.
 */
router.post(
  "/:contractId/rebalance-preview/validate",
  (req: Request, res: Response) => {
    const { targetWeights } = req.body as {
      targetWeights?: { token: string; weightBps: number }[];
    };

    if (!Array.isArray(targetWeights)) {
      res.status(400).json({ error: "targetWeights must be an array.", details: [] });
      return;
    }

    const details = validateBasketTargetWeights(targetWeights);
    if (details.length > 0) {
      res.status(400).json({ error: "Invalid target weights.", details });
      return;
    }

    res.json({ valid: true });
  },
);

export default router;
