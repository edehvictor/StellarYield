import { Router, Request, Response } from "express";
import { ExitImpactService } from "../services/exitImpactService";
import { sendError } from "../utils/errorResponse";

/**
 * Withdrawal Preview Route
 *
 * POST /api/vaults/:vaultId/withdrawal-preview
 *
 * Returns a fee, delay, and net-output estimate before the user signs a
 * vault withdrawal transaction.  All computation is pure / off-chain;
 * nothing is written to the ledger.
 *
 * Body (JSON):
 *   amountUsd         — withdrawal amount expressed in USD (number, > 0)
 *   poolLiquidityUsd  — current pool TVL / depth in USD (number, >= 0)
 *   exitFeeBps        — protocol exit fee in basis points  (number, 0-10000, default 0)
 *
 * Response (JSON):
 *   vaultId                — echoed vault identifier
 *   requestedAmountUsd     — echoed input amount
 *   exitFeeUsd             — absolute fee deducted in USD
 *   exitFeeBps             — echoed fee rate
 *   processingDelayLabel   — human-readable settlement expectation
 *   processingDelaySeconds — upper-bound in seconds (0 = instant)
 *   estimatedNetUsd        — expected amount received after fee + slippage
 *   optimisticNetUsd       — best-case estimate
 *   conservativeNetUsd     — worst-case estimate
 *   priceImpactPct         — slippage as a percentage
 *   isLowLiquidity         — true if price impact exceeds 2 %
 *   quotedAt               — ISO timestamp of when the estimate was generated
 */

/** Derive a human-readable processing delay based on vault policy. */
function resolveProcessingDelay(vaultId: string): {
  label: string;
  seconds: number;
} {
  // Vaults that queue redemptions (e.g. liquid-staking style).
  // Real implementation would look this up from on-chain config.
  const DELAYED_VAULT_IDS = new Set(["defindex", "blend-stable"]);
  const normalised = vaultId.toLowerCase();

  if (DELAYED_VAULT_IDS.has(normalised)) {
    return { label: "Up to 24 hours (queued redemption)", seconds: 86_400 };
  }

  return { label: "Instant (~5 seconds on-chain)", seconds: 5 };
}

const withdrawalPreviewRouter = Router({ mergeParams: true });

withdrawalPreviewRouter.post(
  "/:vaultId/withdrawal-preview",
  (req: Request, res: Response): void => {
    const { vaultId } = req.params;

    const { amountUsd, poolLiquidityUsd, exitFeeBps } = req.body as {
      amountUsd?: unknown;
      poolLiquidityUsd?: unknown;
      exitFeeBps?: unknown;
    };

    // ── Input validation ──────────────────────────────────────────────
    if (
      typeof amountUsd !== "number" ||
      !Number.isFinite(amountUsd) ||
      amountUsd <= 0
    ) {
      sendError(
        res,
        400,
        "INVALID_AMOUNT",
        "amountUsd must be a positive finite number.",
      );
      return;
    }

    if (
      typeof poolLiquidityUsd !== "number" ||
      !Number.isFinite(poolLiquidityUsd) ||
      poolLiquidityUsd < 0
    ) {
      sendError(
        res,
        400,
        "INVALID_LIQUIDITY",
        "poolLiquidityUsd must be a non-negative finite number.",
      );
      return;
    }

    const feeBps =
      exitFeeBps === undefined
        ? 0
        : typeof exitFeeBps === "number" &&
            Number.isFinite(exitFeeBps) &&
            exitFeeBps >= 0 &&
            exitFeeBps <= 10_000
          ? exitFeeBps
          : null;

    if (feeBps === null) {
      sendError(
        res,
        400,
        "INVALID_FEE_BPS",
        "exitFeeBps must be a number between 0 and 10000.",
      );
      return;
    }

    // ── Compute estimate ──────────────────────────────────────────────
    const estimate = ExitImpactService.estimateImpact(
      amountUsd,
      poolLiquidityUsd,
      feeBps,
    );

    const { label: processingDelayLabel, seconds: processingDelaySeconds } =
      resolveProcessingDelay(String(vaultId));

    res.json({
      vaultId,
      requestedAmountUsd: amountUsd,
      exitFeeUsd: estimate.feeDragUsd,
      exitFeeBps: feeBps,
      processingDelayLabel,
      processingDelaySeconds,
      estimatedNetUsd: estimate.estimatedReceivedUsd,
      optimisticNetUsd: estimate.optimisticAmountUsd,
      conservativeNetUsd: estimate.conservativeAmountUsd,
      priceImpactPct: estimate.priceImpactPct,
      isLowLiquidity: estimate.isLowLiquidity,
      quotedAt: new Date().toISOString(),
    });
  },
);

export default withdrawalPreviewRouter;
