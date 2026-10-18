/**
 * Vault share redemption preview (#1404).
 *
 * Pure, deterministic BigInt math shared by the server route
 * (`POST /api/vaults/:vaultId/redemption-preview`) and the client, so a preview
 * shown before signing always agrees with what the API returns.
 *
 * Amounts are integer base units (like the on-chain `i128` values), so no
 * floating-point rounding is involved. Rounding always favours the vault, as
 * in ERC-4626, so a preview never promises more than a redemption can pay:
 *
 * - redeeming N shares pays `floor(N * totalAssets / totalShares)` assets;
 * - withdrawing exactly A assets burns `ceil(A * totalShares / totalAssets)` shares.
 */

/** Basis-point denominator (100% = 10_000 bps). */
export const REDEMPTION_BPS_DENOMINATOR = 10_000n;

/** Decimal places of the reported share price. */
export const SHARE_PRICE_DECIMALS = 7;

/** Largest amount accepted: the maximum on-chain `i128`. */
export const MAX_REDEMPTION_AMOUNT = (1n << 127n) - 1n;

export type RedemptionRequest =
  /** Redeem exactly this many shares. */
  | { mode: "shares"; shares: bigint }
  /** Withdraw exactly this many (gross) assets; the shares burned are derived. */
  | { mode: "assets"; assets: bigint }
  /** Redeem this share of the user's position, in basis points (1..10_000). */
  | { mode: "percent"; percentBps: bigint };

export interface VaultState {
  totalAssets: bigint;
  totalShares: bigint;
}

export interface RedemptionInputs {
  state: VaultState;
  /** The user's whole share balance. */
  userShares: bigint;
  request: RedemptionRequest;
  /** Exit fee on the assets paid out, in basis points (default 0). */
  exitFeeBps?: bigint;
  /** Warn when a remainder smaller than this many shares would be left (default 0 = off). */
  minRemainingShares?: bigint;
}

export type RedemptionErrorCode =
  | "INVALID_VAULT_STATE"
  | "VAULT_EMPTY"
  | "INVALID_AMOUNT"
  | "INVALID_PERCENT"
  | "INVALID_FEE_BPS"
  | "INVALID_MIN_REMAINING"
  | "INSUFFICIENT_SHARES"
  | "REDEMPTION_TOO_SMALL";

/** A redemption that cannot be previewed; the code is stable, the message safe to show. */
export class RedemptionError extends Error {
  readonly code: RedemptionErrorCode;
  /** Machine-readable context, e.g. the most the user could redeem. */
  readonly details?: Record<string, string>;

  constructor(code: RedemptionErrorCode, message: string, details?: Record<string, string>) {
    super(message);
    this.name = "RedemptionError";
    this.code = code;
    this.details = details;
  }
}

export type RedemptionWarningCode = "DUST_REMAINDER" | "REMAINDER_WORTHLESS";

export interface RedemptionWarning {
  code: RedemptionWarningCode;
  message: string;
  remediation: string;
}

export interface RedemptionPreview {
  mode: RedemptionRequest["mode"];
  sharesToBurn: bigint;
  /** Assets before the exit fee. */
  grossAssets: bigint;
  exitFeeAssets: bigint;
  /** Assets the user receives: `grossAssets - exitFeeAssets`. */
  netAssets: bigint;
  remainingShares: bigint;
  /** What the remaining shares are worth at the current share price. */
  remainingAssets: bigint;
  /** What the user's whole position is worth (the ceiling for `assets` requests). */
  maxRedeemableAssets: bigint;
  /** Assets per share, scaled by `10 ** SHARE_PRICE_DECIMALS`. */
  sharePriceScaled: bigint;
  /** Share of the position being redeemed, in basis points (rounded down). */
  percentOfPositionBps: bigint;
  isFullRedemption: boolean;
  /**
   * `assets` requests only: value of the burned shares beyond the requested
   * assets, kept by the vault because shares are indivisible. Always `0` for
   * `shares` and `percent` requests.
   */
  roundingDustAssets: bigint;
  warnings: RedemptionWarning[];
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** Format a non-negative scaled integer as a fixed-point decimal string. */
export function formatScaled(value: bigint, decimals: number): string {
  if (value < 0n) throw new RangeError("formatScaled expects a non-negative value");
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  if (decimals === 0) return whole.toString();
  const fraction = (value % scale).toString().padStart(decimals, "0");
  return `${whole}.${fraction}`;
}

/**
 * Preview redeeming part (or all) of a position.
 * @throws RedemptionError when the request cannot be previewed.
 */
export function previewRedemption(input: RedemptionInputs): RedemptionPreview {
  const { totalAssets, totalShares } = input.state;
  const { userShares, request } = input;
  const feeBps = input.exitFeeBps ?? 0n;
  const minRemaining = input.minRemainingShares ?? 0n;

  if (totalAssets < 0n || totalShares < 0n || userShares < 0n) {
    throw new RedemptionError("INVALID_VAULT_STATE", "Vault totals and share balance must not be negative.");
  }
  if (totalAssets > MAX_REDEMPTION_AMOUNT || totalShares > MAX_REDEMPTION_AMOUNT) {
    throw new RedemptionError("INVALID_VAULT_STATE", "Vault totals exceed the supported range.");
  }
  if (userShares > totalShares) {
    throw new RedemptionError("INVALID_VAULT_STATE", "The share balance exceeds the vault's total shares.");
  }
  if (feeBps < 0n || feeBps > REDEMPTION_BPS_DENOMINATOR) {
    throw new RedemptionError("INVALID_FEE_BPS", "The exit fee must be between 0 and 10000 basis points.");
  }
  if (minRemaining < 0n) {
    throw new RedemptionError("INVALID_MIN_REMAINING", "The minimum remaining shares must not be negative.");
  }
  if (totalShares === 0n || totalAssets === 0n) {
    throw new RedemptionError("VAULT_EMPTY", "The vault has no redeemable assets right now.");
  }

  const valueOf = (shares: bigint): bigint => (shares * totalAssets) / totalShares;

  let sharesToBurn: bigint;
  let requestedAssets: bigint | null = null;

  switch (request.mode) {
    case "shares":
      if (request.shares <= 0n || request.shares > MAX_REDEMPTION_AMOUNT) {
        throw new RedemptionError("INVALID_AMOUNT", "Shares to redeem must be a positive amount.");
      }
      sharesToBurn = request.shares;
      break;
    case "assets":
      if (request.assets <= 0n || request.assets > MAX_REDEMPTION_AMOUNT) {
        throw new RedemptionError("INVALID_AMOUNT", "Assets to withdraw must be a positive amount.");
      }
      requestedAssets = request.assets;
      sharesToBurn = ceilDiv(request.assets * totalShares, totalAssets);
      break;
    case "percent":
      if (request.percentBps <= 0n || request.percentBps > REDEMPTION_BPS_DENOMINATOR) {
        throw new RedemptionError("INVALID_PERCENT", "The percentage must be greater than 0 and at most 100.");
      }
      sharesToBurn =
        request.percentBps === REDEMPTION_BPS_DENOMINATOR
          ? userShares
          : (userShares * request.percentBps) / REDEMPTION_BPS_DENOMINATOR;
      break;
  }

  const maxRedeemableAssets = valueOf(userShares);

  if (userShares === 0n || sharesToBurn > userShares) {
    throw new RedemptionError("INSUFFICIENT_SHARES", "The request is larger than your position.", {
      maxShares: userShares.toString(),
      maxAssets: maxRedeemableAssets.toString(),
    });
  }

  const shareValue = valueOf(sharesToBurn);
  const grossAssets = requestedAssets ?? shareValue;
  if (sharesToBurn === 0n || grossAssets === 0n) {
    throw new RedemptionError(
      "REDEMPTION_TOO_SMALL",
      "This amount is too small to redeem: it is worth less than one unit of the vault's asset.",
    );
  }

  const exitFeeAssets = (grossAssets * feeBps) / REDEMPTION_BPS_DENOMINATOR;
  const remainingShares = userShares - sharesToBurn;
  const remainingAssets = valueOf(remainingShares);

  const warnings: RedemptionWarning[] = [];
  if (remainingShares > 0n && minRemaining > 0n && remainingShares < minRemaining) {
    warnings.push({
      code: "DUST_REMAINDER",
      message: `This leaves ${remainingShares} shares, below the ${minRemaining}-share minimum position.`,
      remediation: "Redeem your whole position instead, or leave at least the minimum.",
    });
  }
  if (remainingShares > 0n && remainingAssets === 0n) {
    warnings.push({
      code: "REMAINDER_WORTHLESS",
      message: "The shares left over are worth less than one unit of the vault's asset and cannot be redeemed on their own.",
      remediation: "Redeem your whole position to avoid stranding them.",
    });
  }

  return {
    mode: request.mode,
    sharesToBurn,
    grossAssets,
    exitFeeAssets,
    netAssets: grossAssets - exitFeeAssets,
    remainingShares,
    remainingAssets,
    maxRedeemableAssets,
    sharePriceScaled: (totalAssets * 10n ** BigInt(SHARE_PRICE_DECIMALS)) / totalShares,
    percentOfPositionBps:
      userShares === 0n ? 0n : (sharesToBurn * REDEMPTION_BPS_DENOMINATOR) / userShares,
    isFullRedemption: remainingShares === 0n,
    roundingDustAssets: requestedAssets !== null ? shareValue - requestedAssets : 0n,
    warnings,
  };
}
