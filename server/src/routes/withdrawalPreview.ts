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
 *   expiresAt              — ISO timestamp when the quote becomes stale
 *                            (quotedAt + 60s TTL, see WITHDRAWAL_QUOTE_TTL_MS)
 *   quoteTtlMs             — TTL in milliseconds (always 60000)
 *   reserveImpact          — present only when currentReserveUsd and vaultTvlUsd are
 *                            both supplied; see ReserveImpactPreview (#1321)
 *
 * Optional body fields (all three required together to receive reserveImpact):
 *   currentReserveUsd — vault's current idle reserve in USD (number, >= 0)
 *   vaultTvlUsd        — vault's total value locked in USD (number, > 0)
 *   minBufferPct       — minimum acceptable reserve ratio, 0-100 (default: 8)
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

/**
 * Quote time-to-live for withdrawal previews (#1308).
 * Mirrors the zap quote TTL (60s) so transaction modals share one
 * deterministic staleness contract: `expiresAt = quotedAt + TTL`.
 */
export const WITHDRAWAL_QUOTE_TTL_MS = 60_000;

withdrawalPreviewRouter.post(
  "/:vaultId/withdrawal-preview",
  (req: Request, res: Response): void => {
    const { vaultId } = req.params;

    const {
      amountUsd,
      poolLiquidityUsd,
      exitFeeBps,
      currentReserveUsd,
      vaultTvlUsd,
      minBufferPct,
    } = req.body as {
      amountUsd?: unknown;
      poolLiquidityUsd?: unknown;
      exitFeeBps?: unknown;
      currentReserveUsd?: unknown;
      vaultTvlUsd?: unknown;
      minBufferPct?: unknown;
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

    // ── Optional reserve-impact preview inputs ─────────────────────────
    const reserveInputsProvided =
      currentReserveUsd !== undefined || vaultTvlUsd !== undefined;

    if (reserveInputsProvided) {
      if (typeof currentReserveUsd !== "number" || !Number.isFinite(currentReserveUsd) || currentReserveUsd < 0) {
        sendError(
          res,
          400,
          "INVALID_RESERVE",
          "currentReserveUsd must be a non-negative finite number.",
        );
        return;
      }
      if (typeof vaultTvlUsd !== "number" || !Number.isFinite(vaultTvlUsd) || vaultTvlUsd <= 0) {
        sendError(
          res,
          400,
          "INVALID_TVL",
          "vaultTvlUsd must be a positive finite number.",
        );
        return;
      }
      if (
        minBufferPct !== undefined &&
        (typeof minBufferPct !== "number" || !Number.isFinite(minBufferPct) || minBufferPct < 0 || minBufferPct > 100)
      ) {
        sendError(
          res,
          400,
          "INVALID_MIN_BUFFER_PCT",
          "minBufferPct must be a number between 0 and 100.",
        );
        return;
      }
    }

    // ── Compute estimate ──────────────────────────────────────────────
    const estimate = ExitImpactService.estimateImpact(
      amountUsd,
      poolLiquidityUsd,
      feeBps,
    );

    const { label: processingDelayLabel, seconds: processingDelaySeconds } =
      resolveProcessingDelay(String(vaultId));

    const quotedAt = new Date();
    const expiresAt = new Date(quotedAt.getTime() + WITHDRAWAL_QUOTE_TTL_MS);

    const reserveImpact = reserveInputsProvided
      ? ExitImpactService.previewReserveImpact(
          currentReserveUsd as number,
          vaultTvlUsd as number,
          amountUsd,
          minBufferPct as number | undefined,
        )
      : undefined;

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
      quotedAt: quotedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      quoteTtlMs: WITHDRAWAL_QUOTE_TTL_MS,
      ...(reserveImpact ? { reserveImpact } : {}),
    });
  },
);

export default withdrawalPreviewRouter;
