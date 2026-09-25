/**
 * Pure math functions for YieldVault share price and fee calculations (#722).
 *
 * All amounts are treated as integer units (e.g. micro-tokens or satoshis)
 * to avoid floating-point rounding surprises in production. Functions that
 * must handle real-number inputs (e.g. APY) use standard JS number arithmetic.
 *
 * Invariant:
 *   calculateAssets(calculateShares(D, A, S), A + D, S + shares) ≈ D  (within 1 unit)
 */

/**
 * Calculate the number of shares to mint for a deposit.
 *
 * Formula: shares = depositAmount * totalShares / totalAssets
 * Initial mint (totalShares === 0 or totalAssets === 0): shares = depositAmount
 *
 * @param depositAmount   Amount of assets being deposited (>= 0)
 * @param totalAssets     Total assets currently in the vault (>= 0)
 * @param totalShares     Total shares currently outstanding (>= 0)
 * @returns               Shares to mint (floor division to prevent over-minting)
 */
export function calculateShares(
  depositAmount: number,
  totalAssets: number,
  totalShares: number,
): number {
  if (depositAmount < 0) {
    throw new RangeError("depositAmount must be >= 0");
  }
  if (totalAssets < 0) {
    throw new RangeError("totalAssets must be >= 0");
  }
  if (totalShares < 0) {
    throw new RangeError("totalShares must be >= 0");
  }

  if (depositAmount === 0) return 0;

  // Initial mint: no existing shares or no existing assets
  if (totalShares === 0 || totalAssets === 0) {
    return Math.floor(depositAmount);
  }

  return Math.floor((depositAmount * totalShares) / totalAssets);
}

/**
 * Calculate the amount of assets to return when redeeming shares.
 *
 * Formula: assets = sharesToRedeem * totalAssets / totalShares
 *
 * @param sharesToRedeem  Number of shares being redeemed (>= 0)
 * @param totalAssets     Total assets currently in the vault (>= 0)
 * @param totalShares     Total shares currently outstanding (> 0)
 * @returns               Assets to return (floor division to prevent over-withdrawal)
 */
export function calculateAssets(
  sharesToRedeem: number,
  totalAssets: number,
  totalShares: number,
): number {
  if (sharesToRedeem < 0) {
    throw new RangeError("sharesToRedeem must be >= 0");
  }
  if (totalAssets < 0) {
    throw new RangeError("totalAssets must be >= 0");
  }
  if (totalShares <= 0) {
    throw new RangeError("totalShares must be > 0 when redeeming");
  }

  if (sharesToRedeem === 0) return 0;

  return Math.floor((sharesToRedeem * totalAssets) / totalShares);
}

/**
 * Calculate the protocol harvest fee from a yield amount.
 *
 * Formula: fee = yield_ * feeRateBps / 10000  (floor)
 *
 * @param yield_       Gross yield amount (>= 0)
 * @param feeRateBps   Fee rate in basis points, e.g. 1000 = 10% (0–10000)
 * @returns            Fee amount in the same units as yield_
 */
export function calculateHarvestFee(
  yield_: number,
  feeRateBps: number,
): number {
  if (yield_ < 0) {
    throw new RangeError("yield_ must be >= 0");
  }
  if (feeRateBps < 0 || feeRateBps > 10_000) {
    throw new RangeError("feeRateBps must be in [0, 10000]");
  }

  return Math.floor((yield_ * feeRateBps) / 10_000);
}
