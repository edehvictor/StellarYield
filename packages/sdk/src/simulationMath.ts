/**
 * Boundary-safe simulation math for the SDK (#1855).
 *
 * All calculations use BigInt checked arithmetic and the rounding rules
 * documented for the vault contract: shares are rounded up (never give a user
 * fewer shares than they paid for) and assets are rounded down. Zero, minimum,
 * maximum and near-limit `i128` values are handled explicitly. No function in
 * this module mutates caller-owned state, and failures are returned as typed
 * results so retries can start from the last accepted snapshot.
 */

import { InvalidAmountError, InvalidSimulationParamsError } from "./errors";
import { toTokenUnits, type TokenAmount } from "./types";

/** Largest signed 128-bit integer representable by the vault contract. */
export const I128_MAX = (2n ** 127n) - 1n;
/** Smallest signed 128-bit integer representable by the vault contract. */
export const I128_MIN = -(2n ** 127n);

export type SimulationCalculationCode =
  | "INVALID_AMOUNT"
  | "INVALID_RESERVE"
  | "INVALID_SHARES"
  | "DIVISION_BY_ZERO"
  | "OVERFLOW";

export interface SimulationCalculationFailure {
  code: SimulationCalculationCode;
  message: string;
  field?: string;
}

export type SimulationCalculationResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: SimulationCalculationFailure };

function fail<T>(
  code: SimulationCalculationCode,
  message: string,
  field?: string,
): SimulationCalculationResult<T> {
  return { ok: false, failure: { code, message, ...(field === undefined ? {} : { field }) } };
}

function isRepresentable(value: bigint): boolean {
  return value >= I128_MIN && value <= I128_MAX;
}

/** Checked addition; returns OVERFLOW instead of wrapping around `i128`. */
export function checkedAdd(
  left: bigint,
  right: bigint,
  field = "value",
): SimulationCalculationResult<bigint> {
  const sum = left + right;
  if (!isRepresentable(sum)) {
    return fail("OVERFLOW", "result exceeds the i128 range", field);
  }
  return { ok: true, value: sum };
}

/** Checked multiplication; returns OVERFLOW instead of wrapping around `i128`. */
export function checkedMul(
  left: bigint,
  right: bigint,
  field = "value",
): SimulationCalculationResult<bigint> {
  const product = left * right;
  if (!isRepresentable(product)) {
    return fail("OVERFLOW", "result exceeds the i128 range", field);
  }
  return { ok: true, value: product };
}

/** Ceiling division for share minting: `(n + d - 1) / d`. */
export function ceilDiv(
  numerator: bigint,
  denominator: bigint,
  field = "denominator",
): SimulationCalculationResult<bigint> {
  if (denominator <= 0n) {
    return fail("DIVISION_BY_ZERO", "denominator must be greater than zero", field);
  }
  if (numerator < 0n) {
    return fail("INVALID_AMOUNT", "numerator must not be negative", "amount");
  }
  return { ok: true, value: (numerator + denominator - 1n) / denominator };
}

/** Floor division for asset redemption. */
export function floorDiv(
  numerator: bigint,
  denominator: bigint,
  field = "denominator",
): SimulationCalculationResult<bigint> {
  if (denominator <= 0n) {
    return fail("DIVISION_BY_ZERO", "denominator must be greater than zero", field);
  }
  if (numerator < 0n) {
    return fail("INVALID_AMOUNT", "numerator must not be negative", "amount");
  }
  return { ok: true, value: numerator / denominator };
}

function validateNonNegative(value: bigint, field: string): SimulationCalculationResult<bigint> {
  if (value < 0n) {
    return fail("INVALID_AMOUNT", "must not be negative", field);
  }
  if (!isRepresentable(value)) {
    return fail("OVERFLOW", "value exceeds the i128 range", field);
  }
  return { ok: true, value };
}

export interface DepositSharePreviewInput {
  amount: bigint;
  reserveBefore: bigint;
  sharesBefore: bigint;
}

/**
 * Preview minted shares with checked arithmetic.
 *
 * Zero deposits mint zero shares. The first deposit into an empty vault is
 * 1:1. For an existing vault, `amount * sharesBefore / reserveBefore` is
 * rounded up so the depositor never receives fewer shares than paid for.
 */
export function previewDepositShares(
  input: DepositSharePreviewInput,
): SimulationCalculationResult<bigint> {
  const amount = validateNonNegative(input.amount, "amount");
  if (!amount.ok) return amount;
  const reserve = validateNonNegative(input.reserveBefore, "reserveBefore");
  if (!reserve.ok) return reserve;
  const shares = validateNonNegative(input.sharesBefore, "sharesBefore");
  if (!shares.ok) return shares;

  if (amount.value === 0n || reserve.value === 0n || shares.value === 0n) {
    return { ok: true, value: amount.value };
  }

  const scaled = checkedMul(amount.value, shares.value, "amount");
  if (!scaled.ok) return scaled;
  return ceilDiv(scaled.value, reserve.value, "reserveBefore");
}

export interface WithdrawAssetPreviewInput {
  shares: bigint;
  reserve: bigint;
  sharesBefore: bigint;
}

/** Preview withdrawn assets, rounding down so the vault is never overdrawn. */
export function previewWithdrawAssets(
  input: WithdrawAssetPreviewInput,
): SimulationCalculationResult<bigint> {
  const shares = validateNonNegative(input.shares, "shares");
  if (!shares.ok) return shares;
  const reserve = validateNonNegative(input.reserve, "reserve");
  if (!reserve.ok) return reserve;
  const totalShares = validateNonNegative(input.sharesBefore, "sharesBefore");
  if (!totalShares.ok) return totalShares;

  if (shares.value === 0n) {
    return { ok: true, value: 0n };
  }
  if (totalShares.value === 0n || reserve.value === 0n) {
    return fail("INVALID_SHARES", "vault has no shares or reserves to redeem", "sharesBefore");
  }
  if (shares.value > totalShares.value) {
    return fail("INVALID_SHARES", "cannot redeem more shares than the vault has", "shares");
  }

  const scaled = checkedMul(shares.value, reserve.value, "shares");
  if (!scaled.ok) return scaled;
  return floorDiv(scaled.value, totalShares.value, "sharesBefore");
}

/** Normalize an untrusted amount into exact base units with an i128 bound. */
export function validateSimulationAmount(
  value: TokenAmount,
  field = "amount",
): SimulationCalculationResult<bigint> {
  let units: bigint;
  try {
    units = toTokenUnits(value, { field });
  } catch (error) {
    if (error instanceof InvalidAmountError) {
      return { ok: false, failure: { code: "INVALID_AMOUNT", message: error.message, field } };
    }
    throw error;
  }
  return validateNonNegative(units, field);
}

/** Throw a typed error for a malformed amount, leaving retry decisions to callers. */
export function assertSimulationAmount(value: TokenAmount, field = "amount"): bigint {
  const result = validateSimulationAmount(value, field);
  if (!result.ok) {
    throw new InvalidAmountError(field, value, result.failure.message);
  }
  return result.value;
}

/**
 * Validate all fields of a deposit simulation request before any network call.
 * Throws a typed, non-retryable error on invalid input.
 */
export function assertDepositSimulationParams(params: {
  strategyId?: unknown;
  amount?: unknown;
  token?: unknown;
}): void {
  if (typeof params.strategyId !== "string" || params.strategyId.trim() === "") {
    throw new InvalidSimulationParamsError("strategyId", "must be a non-empty string");
  }
  if (typeof params.token !== "string" || params.token.trim() === "") {
    throw new InvalidSimulationParamsError("token", "must be a non-empty string");
  }
  assertSimulationAmount(params.amount as TokenAmount, "amount");
}
