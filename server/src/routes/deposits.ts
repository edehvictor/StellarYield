import { Router, Request, Response } from "express";
import {
  recommendDepositRouting,
  type DepositAssetInput,
} from "../services/depositRoutingService";
import { getZapSupportedAssetsPayload } from "../config/zapAssetsConfig";
import { sendError } from "../utils/errorResponse";

const router = Router();

/**
 * GET /api/deposits/supported-assets
 * Lists the assets accepted for multi-asset deposit routing.
 */
router.get("/supported-assets", (_req: Request, res: Response) => {
  try {
    res.json(getZapSupportedAssetsPayload());
  } catch (error) {
    sendError(
      res,
      503,
      "CONFIG_UNAVAILABLE",
      "Supported assets configuration is unavailable.",
      error instanceof Error ? error.message : undefined
    );
  }
});

/**
 * POST /api/deposits/recommend
 * Body: { assets: { symbol: string; amountInStroops: string }[] }
 *
 * Returns a routing recommendation: per-asset conversion/allocation path with
 * reasoning, expected vault-token output, estimated network fees, and explicit
 * warnings for unsupported assets.
 */
router.post("/recommend", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { assets?: unknown };

    if (!Array.isArray(body.assets) || body.assets.length === 0) {
      return sendError(
        res,
        400,
        "INVALID_REQUEST",
        "Request body must include a non-empty `assets` array."
      );
    }

    const inputs: DepositAssetInput[] = [];
    for (const raw of body.assets) {
      if (typeof raw !== "object" || raw === null) {
        return sendError(
          res,
          400,
          "INVALID_ASSET",
          "Each asset must be an object with `symbol` and `amountInStroops`."
        );
      }
      const { symbol, amountInStroops } = raw as Record<string, unknown>;
      if (typeof symbol !== "string" || symbol.trim() === "") {
        return sendError(
          res,
          400,
          "INVALID_ASSET",
          "Each asset requires a non-empty `symbol`."
        );
      }
      if (
        typeof amountInStroops !== "string" ||
        !/^\d+$/.test(amountInStroops) ||
        amountInStroops === "0"
      ) {
        return sendError(
          res,
          400,
          "INVALID_AMOUNT",
          `Asset "${symbol}" requires a positive integer \`amountInStroops\` string.`
        );
      }
      inputs.push({ symbol, amountInStroops });
    }

    const result = await recommendDepositRouting(inputs);
    res.json(result);
  } catch (error) {
    sendError(
      res,
      500,
      "RECOMMENDATION_FAILED",
      "Failed to compute deposit routing recommendation.",
      error instanceof Error ? error.message : undefined
    );
  }
});

export default router;
