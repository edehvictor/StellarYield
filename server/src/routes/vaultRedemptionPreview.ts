import { Router, Request, Response } from "express";
import {
  MAX_REDEMPTION_AMOUNT,
  RedemptionError,
  SHARE_PRICE_DECIMALS,
  formatScaled,
  previewRedemption,
  type RedemptionPreview,
  type RedemptionRequest,
} from "../../../shared/types/vaultRedemption";
import { sendError } from "../utils/errorResponse";
import { WITHDRAWAL_QUOTE_TTL_MS } from "./withdrawalPreview";

/**
 * Vault Share Redemption Preview (#1404)
 *
 * POST /api/vaults/:vaultId/redemption-preview
 *
 * Previews redeeming part (or all) of a position in vault shares, before the
 * user signs. Pure and off-chain: nothing is written to the ledger.
 *
 * The caller supplies the vault state it read on-chain, in the same integer
 * base units as the share balance, so the preview is deterministic.
 *
 * Body (JSON) — amounts are non-negative integers, as JSON numbers (safe
 * integers only) or decimal strings (any size up to the i128 maximum):
 *   totalAssets         — vault total assets
 *   totalShares         — vault total shares outstanding
 *   userShares          — the caller's whole share balance
 *   exactly one of:
 *     shares            — redeem exactly this many shares
 *     assets            — withdraw exactly this many (gross) assets
 *     percentOfPosition — redeem this % of the position (0 < p <= 100, 2 dp)
 *   exitFeeBps          — optional exit fee on the assets paid out (0-10000, default 0)
 *   minRemainingShares  — optional; warn when a smaller remainder would be left
 *
 * Every amount in the response is a decimal string, to avoid precision loss.
 */

const AMOUNT_STRING = /^\d{1,39}$/;

/** Parse a non-negative integer sent as a safe-integer number or a digit string. */
export function parseAmount(value: unknown): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "string" && AMOUNT_STRING.test(value)) {
    const parsed = BigInt(value);
    return parsed <= MAX_REDEMPTION_AMOUNT ? parsed : null;
  }
  return null;
}

/** Parse a percentage (0 < p <= 100, at most 2 decimals) to basis points. */
export function parsePercentToBps(value: unknown): bigint | null {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return bps > 0n && bps <= 10_000n ? bps : null;
}

function serialize(vaultId: string, preview: RedemptionPreview, exitFeeBps: bigint) {
  const quotedAt = new Date();
  return {
    vaultId,
    mode: preview.mode,
    sharesToBurn: preview.sharesToBurn.toString(),
    grossAssets: preview.grossAssets.toString(),
    exitFeeBps: Number(exitFeeBps),
    exitFeeAssets: preview.exitFeeAssets.toString(),
    netAssets: preview.netAssets.toString(),
    remainingShares: preview.remainingShares.toString(),
    remainingAssets: preview.remainingAssets.toString(),
    maxRedeemableAssets: preview.maxRedeemableAssets.toString(),
    sharePrice: formatScaled(preview.sharePriceScaled, SHARE_PRICE_DECIMALS),
    percentOfPosition: Number(preview.percentOfPositionBps) / 100,
    isFullRedemption: preview.isFullRedemption,
    roundingDustAssets: preview.roundingDustAssets.toString(),
    warnings: preview.warnings,
    quotedAt: quotedAt.toISOString(),
    expiresAt: new Date(quotedAt.getTime() + WITHDRAWAL_QUOTE_TTL_MS).toISOString(),
    quoteTtlMs: WITHDRAWAL_QUOTE_TTL_MS,
  };
}

const redemptionPreviewRouter = Router({ mergeParams: true });

redemptionPreviewRouter.post(
  "/:vaultId/redemption-preview",
  (req: Request, res: Response): void => {
    const vaultId = String(req.params.vaultId);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const totalAssets = parseAmount(body.totalAssets);
    const totalShares = parseAmount(body.totalShares);
    const userShares = parseAmount(body.userShares);
    for (const [field, value] of [
      ["totalAssets", totalAssets],
      ["totalShares", totalShares],
      ["userShares", userShares],
    ] as const) {
      if (value === null) {
        sendError(
          res,
          400,
          "INVALID_VAULT_STATE",
          `${field} must be a non-negative integer (a safe-integer number or a digit string).`,
          { field },
        );
        return;
      }
    }

    const provided = (["shares", "assets", "percentOfPosition"] as const).filter(
      (key) => body[key] !== undefined,
    );
    if (provided.length !== 1) {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        "Provide exactly one of shares, assets or percentOfPosition.",
        { provided },
      );
      return;
    }

    let request: RedemptionRequest;
    if (provided[0] === "percentOfPosition") {
      const percentBps = parsePercentToBps(body.percentOfPosition);
      if (percentBps === null) {
        sendError(
          res,
          400,
          "INVALID_PERCENT",
          "percentOfPosition must be greater than 0 and at most 100, with at most 2 decimals.",
          { field: "percentOfPosition" },
        );
        return;
      }
      request = { mode: "percent", percentBps };
    } else {
      const amount = parseAmount(body[provided[0]]);
      if (amount === null) {
        sendError(
          res,
          400,
          "INVALID_AMOUNT",
          `${provided[0]} must be a positive integer (a safe-integer number or a digit string).`,
          { field: provided[0] },
        );
        return;
      }
      request =
        provided[0] === "shares"
          ? { mode: "shares", shares: amount }
          : { mode: "assets", assets: amount };
    }

    let exitFeeBps = 0n;
    if (body.exitFeeBps !== undefined) {
      const fee = parseAmount(body.exitFeeBps);
      if (fee === null || fee > 10_000n) {
        sendError(res, 400, "INVALID_FEE_BPS", "exitFeeBps must be an integer between 0 and 10000.", {
          field: "exitFeeBps",
        });
        return;
      }
      exitFeeBps = fee;
    }

    let minRemainingShares = 0n;
    if (body.minRemainingShares !== undefined) {
      const min = parseAmount(body.minRemainingShares);
      if (min === null) {
        sendError(
          res,
          400,
          "INVALID_MIN_REMAINING",
          "minRemainingShares must be a non-negative integer.",
          { field: "minRemainingShares" },
        );
        return;
      }
      minRemainingShares = min;
    }

    try {
      const preview = previewRedemption({
        state: { totalAssets: totalAssets as bigint, totalShares: totalShares as bigint },
        userShares: userShares as bigint,
        request,
        exitFeeBps,
        minRemainingShares,
      });
      res.json(serialize(vaultId, preview, exitFeeBps));
    } catch (error) {
      if (error instanceof RedemptionError) {
        // VAULT_EMPTY is a state of the vault, not a malformed request.
        const status = error.code === "VAULT_EMPTY" ? 409 : 400;
        sendError(res, status, error.code, error.message, error.details);
        return;
      }
      sendError(res, 500, "REDEMPTION_PREVIEW_FAILED", "The redemption preview is unavailable.");
    }
  },
);

export default redemptionPreviewRouter;
