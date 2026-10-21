/**
 * Portfolio builder dust-allocation validation (#1378).
 *
 * Splitting a portfolio across several vaults can leave some vaults with an
 * allocation that is too small to be worth a deposit — or that rounds to zero
 * once the total is distributed. Those deposits waste fees, can be rejected by
 * the vault, and make the position harder to reconcile.
 *
 * This module is the single source of truth for detecting those allocations.
 * It is pure (no React, no network), so the builder validates locally while the
 * user drags sliders and the server can re-check the same payload before it is
 * submitted. Both layers therefore produce identical results.
 */

/** Smallest non-zero weight, in percentage points, that is not considered dust. */
export const MIN_NONZERO_ALLOCATION_PCT = 0.01;

/** Default minimum economically meaningful deposit, in base token units. */
export const DEFAULT_MINIMUM_ALLOCATION_AMOUNT = 1n;

/** Stable machine-readable reasons an allocation is flagged as dust. */
export type DustIssueCode =
  /** Non-zero weight below `minNonZeroWeightPct`. */
  | "WEIGHT_BELOW_MINIMUM"
  /** Distributed amount is positive but below `minimumAllocationAmount`. */
  | "AMOUNT_BELOW_MINIMUM"
  /** Distributed amount rounds down to zero at the current total. */
  | "AMOUNT_ROUNDS_TO_ZERO";

/** One flagged allocation. A vault may appear twice (weight and amount). */
export interface DustAllocationIssue {
  code: DustIssueCode;
  vaultContractId: string;
  vaultName: string;
  /** Index in the input allocation array. */
  index: number;
  weightPct: number;
  /** Amount this allocation receives after integer distribution. */
  amount: bigint;
  minimumAmount: bigint;
  /** Stable, presentable explanation. */
  message: string;
  /** Stable remediation hint. */
  remediation: string;
}

/** A rebalanced allocation that removes dust without changing the total. */
export interface DustAllocationSuggestion {
  vaultContractId: string;
  weight: number;
}

export interface DustValidationResult {
  valid: boolean;
  /** Stable summary for the UI; empty when there is nothing to report. */
  message: string;
  totalAmount: bigint;
  minimumAllocationAmount: bigint;
  minNonZeroWeightPct: number;
  issues: DustAllocationIssue[];
  /**
   * Weights with dust allocations removed and redistributed, when fixing the
   * issues is possible. `null` when there is nothing to fix.
   */
  suggestedAllocations: DustAllocationSuggestion[] | null;
}

export interface DustAllocationInput {
  vaultContractId: string;
  vaultName?: string;
  /** Percentage of the portfolio, 0-100. */
  weight: number;
}

export interface DustValidationInput {
  totalAmount: bigint;
  allocations: readonly DustAllocationInput[];
  /** Defaults to 1 base unit. */
  minimumAllocationAmount?: bigint;
  /** Defaults to 0.01%. */
  minNonZeroWeightPct?: number;
}

/** Stable copy shared by the client panel and the server validation route. */
export const DUST_VALIDATION_MESSAGES = {
  valid: "No dust allocations detected.",
  emptyTotal: "Enter a total amount to check for dust allocations.",
  emptyAllocations: "No allocations to validate.",
  weightBelowMinimum: (weightPct: number, minimumPct: number) =>
    `Allocation of ${formatPercent(weightPct)}% is below the ${formatPercent(minimumPct)}% minimum non-zero weight.`,
  amountBelowMinimum: (amount: bigint, minimumAmount: bigint) =>
    `Allocation receives ${amount.toString()} base units, below the ${minimumAmount.toString()} unit minimum deposit.`,
  amountRoundsToZero: (weightPct: number) =>
    `Allocation of ${formatPercent(weightPct)}% rounds to zero at the current total amount.`,
  remediationWeight:
    "Increase this allocation above the minimum weight or redistribute it to the other vaults.",
  remediationAmount:
    "Increase the total amount or move this allocation into a larger vault position.",
  suggested: (count: number) =>
    `Move ${count} dust allocation${count === 1 ? "" : "s"} into the remaining vault positions.`,
} as const;

/** Typed input error — callers branch on `code` instead of parsing messages. */
export type PortfolioDustErrorCode =
  | "NEGATIVE_TOTAL_AMOUNT"
  | "INVALID_ALLOCATION_WEIGHT"
  | "INVALID_ALLOCATION";

export class PortfolioDustValidationError extends Error {
  readonly code: PortfolioDustErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: PortfolioDustErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PortfolioDustValidationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Validate allocations for dust.
 *
 * @throws {PortfolioDustValidationError} when the input itself is malformed
 *   (negative total, non-finite/negative weight). Valid-but-empty input
 *   returns a valid result with an explanatory message.
 */
export function validatePortfolioDust(
  input: DustValidationInput,
): DustValidationResult {
  const { totalAmount, allocations } = input;
  const minimumAllocationAmount =
    input.minimumAllocationAmount ?? DEFAULT_MINIMUM_ALLOCATION_AMOUNT;
  const minNonZeroWeightPct =
    input.minNonZeroWeightPct ?? MIN_NONZERO_ALLOCATION_PCT;

  if (typeof totalAmount !== "bigint" || totalAmount < 0n) {
    throw new PortfolioDustValidationError(
      "NEGATIVE_TOTAL_AMOUNT",
      "totalAmount must be a non-negative integer amount.",
      { totalAmount: String(totalAmount) },
    );
  }
  if (
    !Number.isFinite(minNonZeroWeightPct) ||
    minNonZeroWeightPct < 0 ||
    minNonZeroWeightPct > 100
  ) {
    throw new PortfolioDustValidationError(
      "INVALID_ALLOCATION_WEIGHT",
      "minNonZeroWeightPct must be between 0 and 100.",
      { minNonZeroWeightPct },
    );
  }
  if (minimumAllocationAmount < 0n) {
    throw new PortfolioDustValidationError(
      "INVALID_ALLOCATION",
      "minimumAllocationAmount must not be negative.",
      { minimumAllocationAmount: minimumAllocationAmount.toString() },
    );
  }

  for (const [index, allocation] of allocations.entries()) {
    if (
      !allocation ||
      typeof allocation.vaultContractId !== "string" ||
      !allocation.vaultContractId.trim()
    ) {
      throw new PortfolioDustValidationError(
        "INVALID_ALLOCATION",
        `allocations[${index}].vaultContractId is required.`,
        { index, field: "vaultContractId" },
      );
    }
    if (
      !Number.isFinite(allocation.weight) ||
      allocation.weight < 0 ||
      allocation.weight > 100
    ) {
      throw new PortfolioDustValidationError(
        "INVALID_ALLOCATION_WEIGHT",
        `allocations[${index}].weight must be between 0 and 100.`,
        { index, field: "weight", weight: allocation.weight },
      );
    }
  }

  if (allocations.length === 0) {
    return emptyResult(
      totalAmount,
      minimumAllocationAmount,
      minNonZeroWeightPct,
      DUST_VALIDATION_MESSAGES.emptyAllocations,
    );
  }
  if (totalAmount === 0n) {
    return emptyResult(
      totalAmount,
      minimumAllocationAmount,
      minNonZeroWeightPct,
      DUST_VALIDATION_MESSAGES.emptyTotal,
    );
  }

  const amounts = distributeByWeight(totalAmount, allocations);
  const issues: DustAllocationIssue[] = [];

  allocations.forEach((allocation, index) => {
    if (allocation.weight <= 0) return;

    const amount = amounts[index];
    const vaultName = allocation.vaultName?.trim() || allocation.vaultContractId;

    if (allocation.weight < minNonZeroWeightPct) {
      issues.push({
        code: "WEIGHT_BELOW_MINIMUM",
        vaultContractId: allocation.vaultContractId,
        vaultName,
        index,
        weightPct: allocation.weight,
        amount,
        minimumAmount: minimumAllocationAmount,
        message: DUST_VALIDATION_MESSAGES.weightBelowMinimum(
          allocation.weight,
          minNonZeroWeightPct,
        ),
        remediation: DUST_VALIDATION_MESSAGES.remediationWeight,
      });
    }

    if (amount === 0n) {
      issues.push({
        code: "AMOUNT_ROUNDS_TO_ZERO",
        vaultContractId: allocation.vaultContractId,
        vaultName,
        index,
        weightPct: allocation.weight,
        amount,
        minimumAmount: minimumAllocationAmount,
        message: DUST_VALIDATION_MESSAGES.amountRoundsToZero(allocation.weight),
        remediation: DUST_VALIDATION_MESSAGES.remediationAmount,
      });
    } else if (amount < minimumAllocationAmount) {
      issues.push({
        code: "AMOUNT_BELOW_MINIMUM",
        vaultContractId: allocation.vaultContractId,
        vaultName,
        index,
        weightPct: allocation.weight,
        amount,
        minimumAmount: minimumAllocationAmount,
        message: DUST_VALIDATION_MESSAGES.amountBelowMinimum(
          amount,
          minimumAllocationAmount,
        ),
        remediation: DUST_VALIDATION_MESSAGES.remediationAmount,
      });
    }
  });

  const suggestedAllocations =
    issues.length === 0 ? null : buildSuggestion(allocations, issues);

  return {
    valid: issues.length === 0,
    message:
      issues.length === 0
        ? DUST_VALIDATION_MESSAGES.valid
        : summarize(issues),
    totalAmount,
    minimumAllocationAmount,
    minNonZeroWeightPct,
    issues,
    suggestedAllocations,
  };
}

/**
 * Integer distribution used by the builder: floor(weight share), then give the
 * remainder to the largest position. Mirrors `distributeAmount` in
 * `client/src/features/portfolio_builder/portfolioUtils.ts`.
 */
export function distributeByWeight(
  totalAmount: bigint,
  allocations: readonly DustAllocationInput[],
): bigint[] {
  const distributed = allocations.map(
    (allocation) =>
      (totalAmount * BigInt(Math.round(allocation.weight * 100))) / 10000n,
  );
  const remainder =
    totalAmount - distributed.reduce((sum, amount) => sum + amount, 0n);

  if (remainder !== 0n && distributed.length > 0) {
    let largestIndex = 0;
    for (let index = 1; index < distributed.length; index += 1) {
      if (distributed[index] > distributed[largestIndex]) largestIndex = index;
    }
    distributed[largestIndex] += remainder;
  }

  return distributed;
}

function emptyResult(
  totalAmount: bigint,
  minimumAllocationAmount: bigint,
  minNonZeroWeightPct: number,
  message: string,
): DustValidationResult {
  return {
    valid: true,
    message,
    totalAmount,
    minimumAllocationAmount,
    minNonZeroWeightPct,
    issues: [],
    suggestedAllocations: null,
  };
}

function summarize(issues: DustAllocationIssue[]): string {
  const vaultCount = new Set(issues.map((issue) => issue.vaultContractId)).size;
  return `${vaultCount} allocation${vaultCount === 1 ? "" : "s"} would receive dust at this total; adjust or redistribute before depositing.`;
}

/**
 * Drop flagged allocations and proportionally redistribute their weight to the
 * remaining vaults, keeping the total at 100%.
 */
function buildSuggestion(
  allocations: readonly DustAllocationInput[],
  issues: DustAllocationIssue[],
): DustAllocationSuggestion[] | null {
  const dustIds = new Set(issues.map((issue) => issue.vaultContractId));
  const remaining = allocations.filter(
    (allocation) => !dustIds.has(allocation.vaultContractId),
  );
  if (remaining.length === 0) return null;

  const remainingWeight = remaining.reduce(
    (sum, allocation) => sum + Math.max(0, allocation.weight),
    0,
  );
  if (remainingWeight <= 0) return null;

  const suggestions = remaining.map((allocation) => ({
    vaultContractId: allocation.vaultContractId,
    weight: (Math.max(0, allocation.weight) / remainingWeight) * 100,
  }));

  const total = suggestions.reduce((sum, allocation) => sum + allocation.weight, 0);
  if (total !== 100 && suggestions.length > 0) {
    suggestions[0].weight += 100 - total;
  }

  return suggestions;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toString();
}
