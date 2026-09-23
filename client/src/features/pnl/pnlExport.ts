/**
 * Typed PnL Export Schema & Column Validation Engine
 *
 * Provides a validated, stable CSV export format for downstream
 * tax and portfolio accounting tools.
 */

export interface PnLExportRow {
  date: string;
  action: string;
  asset: string;
  amount: number;
  costBasisUsd: number;
  realizedGainUsd: number;
  unrealizedValueUsd: number;
  rewardsUsd: number;
  feesUsd: number;
  txHash: string;
}

export const PNL_CSV_COLUMNS: readonly string[] = [
  "Date",
  "Action",
  "Asset",
  "Amount",
  "Cost Basis USD",
  "Realized Gain USD",
  "Unrealized Value USD",
  "Rewards USD",
  "Fees USD",
  "TxHash",
] as const;

export interface ValidationResult<T> {
  isValid: boolean;
  errors: string[];
  data?: T;
}

function isFiniteNumber(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val);
}

function parseDateIso(val: unknown): string | null {
  if (val instanceof Date) {
    return Number.isFinite(val.getTime()) ? val.toISOString() : null;
  }
  if (typeof val === "string" || typeof val === "number") {
    const d = new Date(val);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

/**
 * Validates and formats a single PnL export row.
 * Ensures required columns exist and numerical values are finite and properly formatted.
 */
export function validatePnLExportRow(
  raw: unknown,
  rowIndex = 0,
): ValidationResult<PnLExportRow> {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return {
      isValid: false,
      errors: [`Row ${rowIndex + 1}: expected an object record.`],
    };
  }

  const obj = raw as Record<string, unknown>;

  // Validate Date
  const dateIso = parseDateIso(obj.date ?? obj.timestamp);
  if (!dateIso) {
    errors.push(`Row ${rowIndex + 1}: invalid or missing date.`);
  }

  // Validate Action
  const action = typeof obj.action === "string" ? obj.action.trim().toUpperCase() : "";
  if (!action) {
    errors.push(`Row ${rowIndex + 1}: missing required action.`);
  }

  // Validate Asset
  const asset = typeof obj.asset === "string" ? obj.asset.trim().toUpperCase() : "USDC";
  if (!asset) {
    errors.push(`Row ${rowIndex + 1}: missing required asset.`);
  }

  // Validate Amount
  const amount = Number(obj.amount ?? obj.quantity ?? obj.shares);
  if (!isFiniteNumber(amount) || amount < 0) {
    errors.push(`Row ${rowIndex + 1}: amount must be a non-negative finite number.`);
  }

  // Validate Cost Basis USD
  const costBasisUsd = Number(obj.costBasisUsd ?? obj.costBasis ?? 0);
  if (!isFiniteNumber(costBasisUsd)) {
    errors.push(`Row ${rowIndex + 1}: costBasisUsd must be a finite number.`);
  }

  // Validate Realized Gain USD
  const realizedGainUsd = Number(obj.realizedGainUsd ?? obj.realized ?? obj.realizedYieldUsd ?? 0);
  if (!isFiniteNumber(realizedGainUsd)) {
    errors.push(`Row ${rowIndex + 1}: realizedGainUsd must be a finite number.`);
  }

  // Validate Unrealized Value USD
  const unrealizedValueUsd = Number(obj.unrealizedValueUsd ?? obj.unrealized ?? obj.currentValue ?? 0);
  if (!isFiniteNumber(unrealizedValueUsd)) {
    errors.push(`Row ${rowIndex + 1}: unrealizedValueUsd must be a finite number.`);
  }

  // Validate Rewards USD
  const rewardsUsd = Number(obj.rewardsUsd ?? obj.rewards ?? obj.reward ?? 0);
  if (!isFiniteNumber(rewardsUsd) || rewardsUsd < 0) {
    errors.push(`Row ${rowIndex + 1}: rewardsUsd must be a non-negative finite number.`);
  }

  // Validate Fees USD
  const feesUsd = Number(obj.feesUsd ?? obj.fees ?? obj.fee ?? 0);
  if (!isFiniteNumber(feesUsd) || feesUsd < 0) {
    errors.push(`Row ${rowIndex + 1}: feesUsd must be a non-negative finite number.`);
  }

  // Validate TxHash
  const txHash = typeof obj.txHash === "string" ? obj.txHash.trim() : (typeof obj.tx_hash === "string" ? obj.tx_hash.trim() : "0x");
  if (!txHash) {
    errors.push(`Row ${rowIndex + 1}: missing txHash.`);
  }

  if (errors.length > 0) {
    return { isValid: false, errors };
  }

  return {
    isValid: true,
    errors: [],
    data: {
      date: dateIso!,
      action,
      asset,
      amount: Number(amount.toFixed(7)),
      costBasisUsd: Number(costBasisUsd.toFixed(2)),
      realizedGainUsd: Number(realizedGainUsd.toFixed(2)),
      unrealizedValueUsd: Number(unrealizedValueUsd.toFixed(2)),
      rewardsUsd: Number(rewardsUsd.toFixed(2)),
      feesUsd: Number(feesUsd.toFixed(2)),
      txHash,
    },
  };
}

/**
 * Validates an entire array of PnL export rows, rejects incomplete or invalid datasets,
 * and orders records chronologically ascending.
 */
export function validatePnLExportDataset(
  rawRows: unknown[],
): ValidationResult<PnLExportRow[]> {
  if (!Array.isArray(rawRows)) {
    return {
      isValid: false,
      errors: ["Export dataset must be an array of records."],
    };
  }

  if (rawRows.length === 0) {
    return {
      isValid: true,
      errors: [],
      data: [],
    };
  }

  const validatedRows: PnLExportRow[] = [];
  const allErrors: string[] = [];

  rawRows.forEach((row, idx) => {
    const result = validatePnLExportRow(row, idx);
    if (!result.isValid) {
      allErrors.push(...result.errors);
    } else if (result.data) {
      validatedRows.push(result.data);
    }
  });

  if (allErrors.length > 0) {
    return {
      isValid: false,
      errors: allErrors,
    };
  }

  // Sort chronologically ascending
  validatedRows.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  return {
    isValid: true,
    errors: [],
    data: validatedRows,
  };
}

function escapeCsvField(val: string | number): string {
  const str = String(val ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Formats a validated PnL export row into a CSV row string in fixed column order.
 */
export function formatPnLExportRow(row: PnLExportRow): string {
  return [
    escapeCsvField(row.date),
    escapeCsvField(row.action),
    escapeCsvField(row.asset),
    escapeCsvField(row.amount.toFixed(7)),
    escapeCsvField(row.costBasisUsd.toFixed(2)),
    escapeCsvField(row.realizedGainUsd.toFixed(2)),
    escapeCsvField(row.unrealizedValueUsd.toFixed(2)),
    escapeCsvField(row.rewardsUsd.toFixed(2)),
    escapeCsvField(row.feesUsd.toFixed(2)),
    escapeCsvField(row.txHash),
  ].join(",");
}

/**
 * Generates the complete CSV string for PnL exports.
 * Throws if the dataset contains validation errors.
 */
export function generatePnLCSV(rawRows: unknown[]): string {
  const validation = validatePnLExportDataset(rawRows);
  if (!validation.isValid || !validation.data) {
    throw new Error(
      `Cannot generate PnL CSV — validation failed:\n${validation.errors.join("\n")}`,
    );
  }

  const rows = [PNL_CSV_COLUMNS.join(",")];
  for (const record of validation.data) {
    rows.push(formatPnLExportRow(record));
  }
  return rows.join("\n");
}
