/**
 * Vault share redemption preview for partial withdrawals (#1404).
 *
 * Thin, pure view-model helpers over the BigInt math in
 * `shared/types/vaultRedemption.ts`. The server route
 * `POST /api/vaults/:vaultId/redemption-preview` is built on the same module,
 * so the figures shown before signing agree with the API to the last unit.
 */
import {
  RedemptionError,
  SHARE_PRICE_DECIMALS,
  formatScaled,
  previewRedemption,
  type RedemptionErrorCode,
  type RedemptionPreview,
  type VaultState,
} from "../../../../shared/types/vaultRedemption";

export type { RedemptionPreview, VaultState } from "../../../../shared/types/vaultRedemption";

/** Quick-select portions of the position, in percent. */
export const PARTIAL_WITHDRAWAL_PRESETS = [25, 50, 75, 100] as const;

/**
 * Shares for a preset portion of `balance`, rounded down; 100% is the whole
 * balance exactly so a "Max" click never leaves dust behind.
 */
export function sharesForPreset(balance: bigint, percent: number): bigint {
  if (balance <= 0n || !Number.isInteger(percent) || percent <= 0) return 0n;
  if (percent >= 100) return balance;
  return (balance * BigInt(percent)) / 100n;
}

export type RedemptionView =
  | { ok: true; preview: RedemptionPreview; sharePrice: string }
  | {
      ok: false;
      code: RedemptionErrorCode;
      /** Stable, presentable text — never a raw exception message. */
      message: string;
      /** Set for `INSUFFICIENT_SHARES`: the most the user could redeem. */
      maxShares?: bigint;
      maxAssets?: bigint;
    };

export interface BuildRedemptionViewInput {
  totals: VaultState;
  /** The user's whole share balance. */
  userShares: bigint;
  /** Shares the user wants to redeem. */
  shares: bigint;
  /** Warn when a smaller remainder would be left. */
  minRemainingShares?: bigint;
}

/** Preview redeeming `shares`; a rejected request becomes a presentable error. */
export function buildRedemptionView(input: BuildRedemptionViewInput): RedemptionView {
  try {
    const preview = previewRedemption({
      state: input.totals,
      userShares: input.userShares,
      request: { mode: "shares", shares: input.shares },
      minRemainingShares: input.minRemainingShares,
    });
    return {
      ok: true,
      preview,
      sharePrice: formatScaled(preview.sharePriceScaled, SHARE_PRICE_DECIMALS),
    };
  } catch (error) {
    if (error instanceof RedemptionError) {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        maxShares: error.details?.maxShares ? BigInt(error.details.maxShares) : undefined,
        maxAssets: error.details?.maxAssets ? BigInt(error.details.maxAssets) : undefined,
      };
    }
    return {
      ok: false,
      code: "INVALID_VAULT_STATE",
      message: "The redemption preview is unavailable.",
    };
  }
}

/** Percent of the position as text, e.g. `25` or `33.33`, from basis points. */
export function formatPercentFromBps(bps: bigint): string {
  const whole = bps / 100n;
  const fraction = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
