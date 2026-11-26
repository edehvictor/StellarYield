/**
 * Boundary-safe validation of the amounts shown in the transaction review modal (#1890).
 *
 * Amounts arrive as display strings. They are parsed into integer base units
 * with BigInt (never parseFloat) so zero, minimum, maximum and near-limit
 * values compare exactly. Policy:
 *  - Only plain non-negative decimals (`^\d+(\.\d+)?$`) are accepted.
 *  - More fractional digits than the token's decimals is rejected, never
 *    silently rounded (a reviewed amount must equal the signed amount).
 *  - Values above the Soroban i128 maximum are rejected.
 *  - The guaranteed minimum may be zero but must not exceed the estimate.
 */

export const DEFAULT_TOKEN_DECIMALS = 7;
export const I128_MAX = (BigInt(1) << BigInt(127)) - BigInt(1);

export function parseDecimalToUnits(raw: string, decimals: number = DEFAULT_TOKEN_DECIMALS): bigint | null {
  if (typeof raw !== "string" || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const [whole, frac = ""] = raw.split(".");
  if (frac.length > decimals) return null;
  const units = BigInt(whole + frac.padEnd(decimals, "0"));
  return units > I128_MAX ? null : units;
}

export interface ReviewAmountInput {
  inputToken: { amount: string; decimals?: number };
  vaultToken: { amount: string; decimals?: number; minAmount?: string };
  slippageTolerance: number;
}

export type ReviewAmountResult = { valid: true } | { valid: false; reason: string };

export function validateReviewAmounts({ inputToken, vaultToken, slippageTolerance }: ReviewAmountInput): ReviewAmountResult {
  const input = parseDecimalToUnits(inputToken.amount, inputToken.decimals);
  if (input === null) return { valid: false, reason: "Deposit amount is invalid or out of range." };
  if (input === BigInt(0)) return { valid: false, reason: "Deposit amount must be greater than zero." };

  const out = parseDecimalToUnits(vaultToken.amount, vaultToken.decimals);
  if (out === null) return { valid: false, reason: "Estimated output is invalid or out of range." };
  if (out === BigInt(0)) return { valid: false, reason: "Estimated output is zero; the amount is too small to deposit." };

  if (vaultToken.minAmount !== undefined) {
    const min = parseDecimalToUnits(vaultToken.minAmount, vaultToken.decimals);
    if (min === null) return { valid: false, reason: "Guaranteed minimum is invalid or out of range." };
    if (min > out) return { valid: false, reason: "Guaranteed minimum exceeds the estimated output." };
  }

  if (!Number.isFinite(slippageTolerance) || slippageTolerance < 0 || slippageTolerance > 100) {
    return { valid: false, reason: "Slippage tolerance is invalid." };
  }
  return { valid: true };
}

/** Shortens an address for display; short values are shown whole rather than duplicated/overlapped. */
export function shortenAddress(address: string): string {
  if (typeof address !== "string") return "";
  return address.length <= 10 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}
