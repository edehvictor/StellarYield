/**
 * Vault deposit minimum/maximum validation (#1317).
 *
 * Rejects deposit amounts that are below a minimum (dust — not economically
 * meaningful, and previously accepted at any positive value) or above a
 * maximum (a single-deposit concentration/fat-finger guard) threshold,
 * returning a typed, deterministic error rather than letting a bad amount
 * reach quoting/routing or a downstream provider.
 *
 * Bounds are expressed in stroops (the smallest unit of a 7-decimal SAC
 * token such as XLM or USDC), matching `DepositAssetInput.amountInStroops`
 * in `depositRoutingService.ts`.
 */

/** Minimum deposit amount in stroops (0.1 units of a 7-decimal token). */
export const MIN_DEPOSIT_AMOUNT_STROOPS = 1_000_000n;

/** Maximum deposit amount in stroops (100,000,000 units of a 7-decimal token). */
export const MAX_DEPOSIT_AMOUNT_STROOPS = 1_000_000_000_000_000n;

export type DepositAmountValidationErrorCode =
  | "DEPOSIT_AMOUNT_INVALID"
  | "DEPOSIT_BELOW_MINIMUM"
  | "DEPOSIT_ABOVE_MAXIMUM";

export interface DepositAmountValidationError {
  code: DepositAmountValidationErrorCode;
  message: string;
}

export interface DepositAmountValidationOptions {
  min?: bigint;
  max?: bigint;
}

/**
 * Validates a deposit amount (in stroops, as a non-negative integer string)
 * against the configured minimum/maximum bounds.
 *
 * Returns `null` when the amount is valid, or a typed
 * {@link DepositAmountValidationError} describing exactly why it was
 * rejected — never throws, so callers can turn the result directly into an
 * HTTP error response.
 */
export function validateDepositAmount(
  amountInStroops: string,
  options: DepositAmountValidationOptions = {}
): DepositAmountValidationError | null {
  const min = options.min ?? MIN_DEPOSIT_AMOUNT_STROOPS;
  const max = options.max ?? MAX_DEPOSIT_AMOUNT_STROOPS;

  if (typeof amountInStroops !== "string" || !/^\d+$/.test(amountInStroops)) {
    return {
      code: "DEPOSIT_AMOUNT_INVALID",
      message: "Deposit amount must be a non-negative integer string (stroops).",
    };
  }

  const amount = BigInt(amountInStroops);

  if (amount < min) {
    return {
      code: "DEPOSIT_BELOW_MINIMUM",
      message: `Deposit amount (${amount.toString()} stroops) is below the minimum of ${min.toString()} stroops.`,
    };
  }

  if (amount > max) {
    return {
      code: "DEPOSIT_ABOVE_MAXIMUM",
      message: `Deposit amount (${amount.toString()} stroops) exceeds the maximum of ${max.toString()} stroops.`,
    };
  }

  return null;
}
