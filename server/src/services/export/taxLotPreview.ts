/**
 * Tax Lot Export Preview Builder (#424)
 *
 * Converts raw vault transactions into a contributor-friendly preview that
 * surfaces cost basis, realized yield, and warning conditions *before* a
 * user downloads the CSV. The preview is meant to be rendered as a table
 * in the client so users can verify their export, while warnings explain
 * the cases where the underlying CSV would still be technically valid but
 * tax-incomplete.
 */

import type { TransactionRecord } from "./csvGenerator";

export type RawTaxAction = "DEPOSIT" | "WITHDRAWAL" | "HARVEST" | string;

export interface RawTaxTransaction {
  action: RawTaxAction;
  amount: number;
  shares: number;
  sharePriceAtTx: number;
  txHash: string;
  /** Timestamp is intentionally `unknown` so we can detect malformed rows. */
  timestamp: unknown;
  /** Symbol of the asset; defaults to USDC when missing for backwards compat. */
  asset?: string;
}

export type PreviewWarningCode =
  | "MISSING_BASIS"
  | "MISSING_TIMESTAMP"
  | "UNSUPPORTED_TOKEN";

export interface PreviewWarning {
  code: PreviewWarningCode;
  message: string;
  /** Index into `rows` that triggered the warning (or `null` if global). */
  rowIndex: number | null;
}

export interface TaxLotPreviewRow {
  /** ISO-8601 timestamp string, or `null` when the source row was missing one. */
  date: string | null;
  action: string;
  asset: string;
  amount: number;
  /** USD cost basis (acquisition value). `null` when we cannot derive it. */
  costBasisUsd: number | null;
  /** Realized yield (USD) for the row. `null` when not applicable. */
  realizedYieldUsd: number | null;
  txHash: string;
  /** Warning codes that apply to this row, in the order they were detected. */
  warnings: PreviewWarningCode[];
}

export interface TaxLotPreview {
  rows: TaxLotPreviewRow[];
  warnings: PreviewWarning[];
  totals: {
    costBasisUsd: number;
    realizedYieldUsd: number;
    rows: number;
  };
  /**
   * Whether the underlying CSV can be downloaded without losing data. The
   * client should only enable the download button when this is `true`.
   */
  canDownload: boolean;
}

const DEFAULT_SUPPORTED_TOKENS = new Set(["USDC"]);

const ZERO_BASIS_PRICE = 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const toIsoDate = (value: unknown): string | null => {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? value.toISOString() : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    const t = date.getTime();
    return Number.isFinite(t) ? date.toISOString() : null;
  }
  return null;
};

/**
 * Build a tax-lot preview from raw transactions.
 *
 * The function never throws on a malformed row — instead it emits the row
 * with the relevant warning code and toggles `canDownload` off so the
 * client can guide the user to fix the export upstream.
 */
export function buildTaxLotPreview(
  rawTxs: RawTaxTransaction[],
  options: { supportedTokens?: Iterable<string> } = {},
): TaxLotPreview {
  const supported = options.supportedTokens
    ? new Set(Array.from(options.supportedTokens, (t) => t.toUpperCase()))
    : DEFAULT_SUPPORTED_TOKENS;

  const rows: TaxLotPreviewRow[] = [];
  const warnings: PreviewWarning[] = [];
  let totalCostBasis = 0;
  let totalRealizedYield = 0;
  let canDownload = true;

  rawTxs.forEach((tx, rowIndex) => {
    const rowWarnings: PreviewWarningCode[] = [];

    const date = toIsoDate(tx.timestamp);
    if (date === null) {
      rowWarnings.push("MISSING_TIMESTAMP");
      warnings.push({
        code: "MISSING_TIMESTAMP",
        message: `Row ${rowIndex + 1} (tx ${tx.txHash}) is missing a usable timestamp.`,
        rowIndex,
      });
      canDownload = false;
    }

    const asset = (tx.asset ?? "USDC").toUpperCase();
    if (!supported.has(asset)) {
      rowWarnings.push("UNSUPPORTED_TOKEN");
      warnings.push({
        code: "UNSUPPORTED_TOKEN",
        message: `Row ${rowIndex + 1} uses unsupported asset "${asset}"; values are passed through but may need manual classification.`,
        rowIndex,
      });
      canDownload = false;
    }

    const action = String(tx.action).toUpperCase();
    const hasSharePrice =
      isFiniteNumber(tx.sharePriceAtTx) && tx.sharePriceAtTx > ZERO_BASIS_PRICE;

    let costBasisUsd: number | null = null;
    let realizedYieldUsd: number | null = null;

    if (action === "DEPOSIT") {
      if (!hasSharePrice) {
        rowWarnings.push("MISSING_BASIS");
        warnings.push({
          code: "MISSING_BASIS",
          message: `Deposit ${tx.txHash} is missing a share price at acquisition; cost basis cannot be derived.`,
          rowIndex,
        });
        canDownload = false;
      } else if (isFiniteNumber(tx.amount)) {
        costBasisUsd = tx.amount * tx.sharePriceAtTx;
        totalCostBasis += costBasisUsd;
      }
    } else if (action === "HARVEST" || action === "WITHDRAWAL") {
      if (hasSharePrice && isFiniteNumber(tx.amount)) {
        realizedYieldUsd = tx.amount * tx.sharePriceAtTx;
        totalRealizedYield += realizedYieldUsd;
      } else if (action === "HARVEST") {
        // A harvest with no price is treated as a missing basis for tax
        // purposes: we cannot value the gain.
        rowWarnings.push("MISSING_BASIS");
        warnings.push({
          code: "MISSING_BASIS",
          message: `Harvest ${tx.txHash} is missing a share price; realized yield cannot be valued.`,
          rowIndex,
        });
        canDownload = false;
      }
    }

    rows.push({
      date,
      action,
      asset,
      amount: isFiniteNumber(tx.amount) ? tx.amount : 0,
      costBasisUsd,
      realizedYieldUsd,
      txHash: tx.txHash,
      warnings: rowWarnings,
    });
  });

  return {
    rows,
    warnings,
    totals: {
      costBasisUsd: Number(totalCostBasis.toFixed(2)),
      realizedYieldUsd: Number(totalRealizedYield.toFixed(2)),
      rows: rows.length,
    },
    canDownload,
  };
}

/**
 * Convert preview rows into the legacy `TransactionRecord` shape consumed
 * by `generateCSV` / `createCSVStream`. Rows with a missing timestamp are
 * skipped (callers should refuse to download in that case) so the CSV
 * never contains an empty `Date` column.
 */
export function previewToCsvRecords(
  preview: TaxLotPreview,
): TransactionRecord[] {
  return preview.rows
    .filter((row) => row.date !== null)
    .map((row) => ({
      date: row.date as string,
      action: row.action,
      asset: row.asset,
      amount: row.amount,
      usdValue:
        row.costBasisUsd ?? row.realizedYieldUsd ?? row.amount,
      txHash: row.txHash,
    }));
}
