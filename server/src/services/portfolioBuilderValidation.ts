/**
 * Server-side validation for portfolio builder payloads (#1378).
 *
 * The builder validates locally for instant feedback; this endpoint offers the
 * same authoritative check to API clients and automation before deposits are
 * submitted. It accepts JSON
 * (amounts as decimal strings) and returns the same typed issue codes and
 * stable copy as the client, never a raw provider/contract message.
 */

import {
  MIN_NONZERO_ALLOCATION_PCT,
  PortfolioDustValidationError,
  validatePortfolioDust,
  type DustAllocationIssue,
  type DustValidationResult,
} from "../../../shared/types/portfolioDust";

export type PortfolioBuilderErrorCode =
  | "INVALID_BODY"
  | "INVALID_TOTAL_AMOUNT"
  | "INVALID_MINIMUM_AMOUNT"
  | "INVALID_MIN_NONZERO_WEIGHT"
  | "INVALID_ALLOCATIONS"
  | "INVALID_ALLOCATION"
  | "INVALID_ALLOCATION_WEIGHT"
  | "ALLOCATION_SUM_MISMATCH";

export class PortfolioBuilderValidationError extends Error {
  readonly code: PortfolioBuilderErrorCode;
  readonly statusCode = 400;
  readonly details: Record<string, unknown>;

  constructor(
    code: PortfolioBuilderErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PortfolioBuilderValidationError";
    this.code = code;
    this.details = details;
  }
}

export interface SerializedDustIssue
  extends Omit<DustAllocationIssue, "amount" | "minimumAmount"> {
  amount: string;
  minimumAmount: string;
}

export interface PortfolioBuilderValidationResponse
  extends Omit<DustValidationResult, "totalAmount" | "minimumAllocationAmount" | "issues"> {
  totalAmount: string;
  minimumAllocationAmount: string;
  issues: SerializedDustIssue[];
  weightsTotalPct: number;
}

interface NormalizedAllocation {
  vaultContractId: string;
  vaultName?: string;
  weight: number;
}

const SUM_TOLERANCE_PCT = 0.01;

export function validatePortfolioBuilderPayload(
  payload: unknown,
): PortfolioBuilderValidationResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PortfolioBuilderValidationError(
      "INVALID_BODY",
      "Request body must be a JSON object.",
    );
  }

  const body = payload as Record<string, unknown>;
  const totalAmount = parseAmount(
    body.totalAmount,
    "totalAmount",
    "INVALID_TOTAL_AMOUNT",
    true,
  );
  const minimumAllocationAmount =
    body.minimumAllocationAmount === undefined
      ? 1n
      : parseAmount(
          body.minimumAllocationAmount,
          "minimumAllocationAmount",
          "INVALID_MINIMUM_AMOUNT",
          false,
        );

  const minNonZeroWeightPct =
    body.minNonZeroWeightPct === undefined
      ? MIN_NONZERO_ALLOCATION_PCT
      : parsePercentage(
          body.minNonZeroWeightPct,
          "minNonZeroWeightPct",
          "INVALID_MIN_NONZERO_WEIGHT",
        );

  const allocations = normalizeAllocations(body.allocations);
  const weightsTotalPct = allocations.reduce(
    (sum, allocation) => sum + allocation.weight,
    0,
  );

  if (
    allocations.length > 0 &&
    Math.abs(weightsTotalPct - 100) > SUM_TOLERANCE_PCT
  ) {
    throw new PortfolioBuilderValidationError(
      "ALLOCATION_SUM_MISMATCH",
      "Allocation weights must sum to 100%.",
      {
        fieldErrors: [
          {
            field: "allocations",
            code: "ALLOCATION_SUM_MISMATCH",
            message: `Allocation weights sum to ${weightsTotalPct.toFixed(4)}%; expected 100%.`,
            meta: { totalPct: weightsTotalPct },
          },
        ],
      },
    );
  }

  try {
    const result = validatePortfolioDust({
      totalAmount,
      allocations,
      minimumAllocationAmount,
      minNonZeroWeightPct,
    });

    return {
      valid: result.valid,
      message: result.message,
      totalAmount: result.totalAmount.toString(),
      minimumAllocationAmount: result.minimumAllocationAmount.toString(),
      minNonZeroWeightPct: result.minNonZeroWeightPct,
      weightsTotalPct,
      issues: result.issues.map(serializeIssue),
      suggestedAllocations: result.suggestedAllocations,
    };
  } catch (error) {
    if (error instanceof PortfolioDustValidationError) {
      throw new PortfolioBuilderValidationError(
        error.code === "NEGATIVE_TOTAL_AMOUNT"
          ? "INVALID_TOTAL_AMOUNT"
          : "INVALID_ALLOCATION_WEIGHT",
        error.message,
        { fieldErrors: [{ code: error.code, ...error.details }] },
      );
    }
    throw error;
  }
}

function normalizeAllocations(value: unknown): NormalizedAllocation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new PortfolioBuilderValidationError(
      "INVALID_ALLOCATIONS",
      "allocations must be an array.",
      { fieldErrors: [{ field: "allocations", code: "INVALID_ALLOCATIONS" }] },
    );
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new PortfolioBuilderValidationError(
        "INVALID_ALLOCATION",
        `allocations[${index}] must be an object.`,
        { fieldErrors: [{ field: `allocations[${index}]`, code: "INVALID_ALLOCATION" }] },
      );
    }

    const allocation = item as Record<string, unknown>;
    if (
      typeof allocation.vaultContractId !== "string" ||
      !allocation.vaultContractId.trim()
    ) {
      throw new PortfolioBuilderValidationError(
        "INVALID_ALLOCATION",
        `allocations[${index}].vaultContractId is required.`,
        {
          fieldErrors: [
            {
              field: `allocations[${index}].vaultContractId`,
              code: "INVALID_ALLOCATION",
            },
          ],
        },
      );
    }

    const weight = parsePercentage(
      allocation.weight,
      `allocations[${index}].weight`,
      "INVALID_ALLOCATION_WEIGHT",
    );

    return {
      vaultContractId: allocation.vaultContractId.trim(),
      ...(typeof allocation.vaultName === "string" && allocation.vaultName.trim()
        ? { vaultName: allocation.vaultName.trim() }
        : {}),
      weight,
    };
  });
}

function parseAmount(
  value: unknown,
  field: string,
  code: PortfolioBuilderErrorCode,
  required: boolean,
): bigint {
  if (value === undefined || value === null) {
    if (!required) return 0n;
    throw new PortfolioBuilderValidationError(
      code,
      `${field} is required.`,
      { fieldErrors: [{ field, code }] },
    );
  }

  const text =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number"
        ? String(value)
        : typeof value === "string"
          ? value.trim()
          : "";

  if (!/^\d+$/.test(text)) {
    throw new PortfolioBuilderValidationError(
      code,
      `${field} must be a non-negative integer amount.`,
      { fieldErrors: [{ field, code }] },
    );
  }

  try {
    return BigInt(text);
  } catch {
    throw new PortfolioBuilderValidationError(
      code,
      `${field} must be a non-negative integer amount.`,
      { fieldErrors: [{ field, code }] },
    );
  }
}

function parsePercentage(
  value: unknown,
  field: string,
  code: PortfolioBuilderErrorCode,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new PortfolioBuilderValidationError(
      code,
      `${field} must be a number between 0 and 100.`,
      { fieldErrors: [{ field, code }] },
    );
  }
  return value;
}

function serializeIssue(issue: DustAllocationIssue): SerializedDustIssue {
  return {
    ...issue,
    amount: issue.amount.toString(),
    minimumAmount: issue.minimumAmount.toString(),
  };
}
