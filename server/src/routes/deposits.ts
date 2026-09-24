import { Router, Request, Response } from "express";
import {
  recommendDepositRouting,
  type DepositAssetInput,
} from "../services/depositRoutingService";
import { getZapSupportedAssetsPayload } from "../config/zapAssetsConfig";
import { sendError } from "../utils/errorResponse";
import { validateDepositAmount } from "../utils/depositAmountValidation";

const router = Router();

/**
 * Maximum fraction of the route liquidity depth a single deposit may consume.
 * Exceeding this is blocked with INSUFFICIENT_LIQUIDITY_DEPTH (#1312).
 */
export const DEFAULT_MAX_DEPTH_UTILIZATION = 0.25;

export interface RouteLiquidityDepthCheckInput {
  /** Deposit size in USD (optional; when absent the check is skipped). */
  amountUsd?: number;
  /** Observed/executable route liquidity depth in USD (optional). */
  routeLiquidityDepthUsd?: number;
  /** Cap on amountUsd as a fraction of depth (default 0.25). */
  maxUtilizationFraction?: number;
}

export interface RouteLiquidityDepthCheckResult {
  checked: boolean;
  /** 0–100 utilization of depth; null when not checked. */
  utilizationPct: number | null;
  block: boolean;
  reason?: string;
}

/**
 * Pure depth gate: block when amountUsd exceeds maxUtilization * depth.
 * Skips (checked=false) when depth or amountUsd is unknown, preserving
 * backward compatibility for callers that do not report depth.
 */
export function checkRouteLiquidityDepth(
  input: RouteLiquidityDepthCheckInput,
): RouteLiquidityDepthCheckResult {
  const depth = input.routeLiquidityDepthUsd;
  const amount = input.amountUsd;
  const maxUtil =
    typeof input.maxUtilizationFraction === "number" &&
    Number.isFinite(input.maxUtilizationFraction) &&
    input.maxUtilizationFraction > 0
      ? input.maxUtilizationFraction
      : DEFAULT_MAX_DEPTH_UTILIZATION;

  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    typeof depth !== "number" ||
    !Number.isFinite(depth) ||
    depth <= 0
  ) {
    return { checked: false, utilizationPct: null, block: false };
  }

  const utilizationPct = (amount / depth) * 100;
  const limitUsd = depth * maxUtil;
  if (amount > limitUsd) {
    return {
      checked: true,
      utilizationPct: Math.round(utilizationPct * 100) / 100,
      block: true,
      reason: `Deposit of $${amount.toFixed(2)} exceeds ${maxUtil * 100}% of route liquidity depth $${depth.toFixed(2)} (utilization ${utilizationPct.toFixed(1)}%). Split the deposit or wait for deeper liquidity.`,
    };
  }
  return {
    checked: true,
    utilizationPct: Math.round(utilizationPct * 100) / 100,
    block: false,
  };
}

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
 * Body: {
 *   assets: { symbol: string; amountInStroops: string }[],
 *   amountUsd?: number,
 *   routeLiquidityDepthUsd?: number
 * }
 *
 * Returns a routing recommendation: per-asset conversion/allocation path with
 * reasoning, expected vault-token output, estimated network fees, and explicit
 * warnings for unsupported assets. When `routeLiquidityDepthUsd` and
 * `amountUsd` are provided (or depth comes from DEPOSIT_ROUTE_LIQUIDITY_DEPTH_USD),
 * oversized deposits are rejected with INSUFFICIENT_LIQUIDITY_DEPTH (#1312).
 */
router.post("/recommend", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      assets?: unknown;
      amountUsd?: unknown;
      routeLiquidityDepthUsd?: unknown;
    };

    if (!Array.isArray(body.assets) || body.assets.length === 0) {
      return sendError(
        res,
        400,
        "INVALID_REQUEST",
        "Request body must include a non-empty `assets` array."
      );
    }

    if (body.amountUsd !== undefined && typeof body.amountUsd !== "number") {
      return sendError(res, 400, "INVALID_AMOUNT_USD", "amountUsd must be a number when provided.");
    }
    if (
      body.routeLiquidityDepthUsd !== undefined &&
      typeof body.routeLiquidityDepthUsd !== "number"
    ) {
      return sendError(
        res,
        400,
        "INVALID_ROUTE_DEPTH",
        "routeLiquidityDepthUsd must be a number when provided."
      );
    }

    const envDepth = process.env.DEPOSIT_ROUTE_LIQUIDITY_DEPTH_USD;
    let depthUsd: number | undefined =
      typeof body.routeLiquidityDepthUsd === "number"
        ? body.routeLiquidityDepthUsd
        : undefined;
    if (depthUsd === undefined && envDepth !== undefined && envDepth.trim() !== "") {
      const parsed = Number(envDepth);
      if (Number.isFinite(parsed) && parsed > 0) depthUsd = parsed;
    }

    const depthCheck = checkRouteLiquidityDepth({
      amountUsd: typeof body.amountUsd === "number" ? body.amountUsd : undefined,
      routeLiquidityDepthUsd: depthUsd,
    });
    if (depthCheck.block) {
      return sendError(
        res,
        422,
        "INSUFFICIENT_LIQUIDITY_DEPTH",
        depthCheck.reason ??
          "Deposit exceeds available route liquidity depth. Split the deposit or wait for deeper liquidity.",
        {
          utilizationPct: depthCheck.utilizationPct,
          routeLiquidityDepthUsd: depthUsd,
          amountUsd: body.amountUsd,
        }
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

      // Deposit minimum/maximum validation (#1317): reject amounts outside
      // the allowed range with a typed, deterministic error before the
      // request reaches routing/quoting.
      const amountError = validateDepositAmount(amountInStroops);
      if (amountError) {
        return sendError(
          res,
          400,
          amountError.code,
          `Asset "${symbol}": ${amountError.message}`
        );
      }

      inputs.push({ symbol, amountInStroops });
    }

    const result = await recommendDepositRouting(inputs);
    if (depthCheck.checked) {
      result.warnings.push(
        `Route liquidity depth check passed: utilization ${depthCheck.utilizationPct}%.`
      );
    }
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
