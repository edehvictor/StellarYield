import { Readable } from "stream";

/**
 * CSV Export Engine — Tax & Accounting Data Transformer
 *
 * Compiles a user's entire transaction history into a standardized
 * CSV format for tax reporting. Handles large datasets gracefully
 * using Node.js streams.
 */

export interface TransactionRecord {
  date: string;
  action: string;
  asset: string;
  amount: number;
  usdValue: number;
  txHash: string;
}

/** CSV column headers matching the standardized tax format. */
export const CSV_HEADERS = [
  "Date",
  "Action",
  "Asset",
  "Amount",
  "USD Value",
  "TxHash",
];

/** Schema version for the tax CSV format (bump when columns change). */
export const CSV_SCHEMA_VERSION = 1;

/** Expected header line (exact order, comma-joined). */
export const CSV_HEADER_LINE = CSV_HEADERS.join(",");

/** Typed validation error codes — never parsed from provider messages. */
export type CsvSchemaErrorCode =
  | "INVALID_HEADER"
  | "WRONG_COLUMN_COUNT"
  | "INVALID_DATE"
  | "INVALID_ACTION"
  | "INVALID_ASSET"
  | "INVALID_AMOUNT"
  | "INVALID_USD_VALUE"
  | "INVALID_TX_HASH"
  | "INVALID_RECORD";

export interface CsvSchemaIssue {
  row: number;
  code: CsvSchemaErrorCode;
  field: string;
  message: string;
}

export class CsvValidationError extends Error {
  readonly code = "CSV_SCHEMA_VALIDATION_FAILED" as const;
  readonly issues: CsvSchemaIssue[];
  constructor(issues: CsvSchemaIssue[]) {
    super(
      `Cannot generate CSV — schema validation failed:\n${issues
        .map((i) => `[row ${i.row}] ${i.code}: ${i.message}`)
        .join("\n")}`,
    );
    this.name = "CsvValidationError";
    this.issues = issues;
  }
}

/**
 * Validate one transaction record against the deterministic CSV schema.
 * Returns the list of issues (empty when valid). `row` is 1-based for messages.
 */
export function validateTransactionRecord(
  record: unknown,
  row = 1,
): CsvSchemaIssue[] {
  const issues: CsvSchemaIssue[] = [];
  const push = (
    code: CsvSchemaErrorCode,
    field: string,
    message: string,
  ): void => {
    issues.push({ row, code, field, message });
  };

  if (!record || typeof record !== "object") {
    push("INVALID_RECORD", "", "Record must be an object.");
    return issues;
  }

  const r = record as Partial<TransactionRecord>;

  if (
    typeof r.date !== "string" ||
    r.date.trim().length === 0 ||
    !Number.isFinite(Date.parse(r.date))
  ) {
    push("INVALID_DATE", "date", "date must be a non-empty parseable date string.");
  }
  if (typeof r.action !== "string" || r.action.trim().length === 0) {
    push("INVALID_ACTION", "action", "action must be a non-empty string.");
  }
  if (typeof r.asset !== "string" || r.asset.trim().length === 0) {
    push("INVALID_ASSET", "asset", "asset must be a non-empty string.");
  }
  if (
    typeof r.amount !== "number" ||
    !Number.isFinite(r.amount) ||
    r.amount < 0
  ) {
    push(
      "INVALID_AMOUNT",
      "amount",
      "amount must be a finite number >= 0.",
    );
  }
  if (
    typeof r.usdValue !== "number" ||
    !Number.isFinite(r.usdValue) ||
    r.usdValue < 0
  ) {
    push(
      "INVALID_USD_VALUE",
      "usdValue",
      "usdValue must be a finite number >= 0.",
    );
  }
  if (
    typeof r.txHash !== "string" ||
    r.txHash.trim().length === 0
  ) {
    push("INVALID_TX_HASH", "txHash", "txHash must be a non-empty string.");
  }
  return issues;
}

/**
 * Validate a whole dataset. Throws `CsvValidationError` listing every bad row.
 * Empty datasets are valid (header-only CSV).
 */
export function validateTransactionDataset(records: unknown): void {
  if (!Array.isArray(records)) {
    throw new CsvValidationError([
      {
        row: 0,
        code: "INVALID_RECORD",
        field: "",
        message: "Records must be an array.",
      },
    ]);
  }
  const issues: CsvSchemaIssue[] = [];
  records.forEach((record, index) => {
    issues.push(...validateTransactionRecord(record, index + 1));
  });
  if (issues.length > 0) throw new CsvValidationError(issues);
}

/** Split one CSV line into fields, honouring RFC-4180 double-quote escaping. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Validate rendered CSV text: exact header order plus per-row column count
 * and field-level checks. Throws `CsvValidationError` on mismatch.
 */
export function validateCsvContent(csv: string): void {
  const lines = csv.split("\n");
  const header = lines[0] ?? "";
  if (header !== CSV_HEADER_LINE) {
    throw new CsvValidationError([
      {
        row: 0,
        code: "INVALID_HEADER",
        field: "header",
        message: `Expected header "${CSV_HEADER_LINE}" but got "${header}".`,
      },
    ]);
  }
  const issues: CsvSchemaIssue[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    const fields = parseCsvLine(line);
    if (fields.length !== CSV_HEADERS.length) {
      issues.push({
        row: i,
        code: "WRONG_COLUMN_COUNT",
        field: "",
        message: `Expected ${CSV_HEADERS.length} columns but got ${fields.length}.`,
      });
      continue;
    }
    const [date, action, asset, amountRaw, usdRaw, txHash] = fields;
    if (!date || !Number.isFinite(Date.parse(date))) {
      issues.push({
        row: i,
        code: "INVALID_DATE",
        field: "date",
        message: "date must be a non-empty parseable date string.",
      });
    }
    if (!action.trim()) {
      issues.push({
        row: i,
        code: "INVALID_ACTION",
        field: "action",
        message: "action must be a non-empty string.",
      });
    }
    if (!asset.trim()) {
      issues.push({
        row: i,
        code: "INVALID_ASSET",
        field: "asset",
        message: "asset must be a non-empty string.",
      });
    }
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount < 0) {
      issues.push({
        row: i,
        code: "INVALID_AMOUNT",
        field: "amount",
        message: "amount must be a finite number >= 0.",
      });
    }
    const usdValue = Number(usdRaw);
    if (!Number.isFinite(usdValue) || usdValue < 0) {
      issues.push({
        row: i,
        code: "INVALID_USD_VALUE",
        field: "usdValue",
        message: "usdValue must be a finite number >= 0.",
      });
    }
    if (!txHash.trim()) {
      issues.push({
        row: i,
        code: "INVALID_TX_HASH",
        field: "txHash",
        message: "txHash must be a non-empty string.",
      });
    }
  }
  if (issues.length > 0) throw new CsvValidationError(issues);
}

/**
 * Escape a CSV field value.
 *
 * Wraps in double quotes if it contains commas, double quotes, or newlines.
 * Internal double quotes are escaped by doubling them.
 */
function escapeCSVField(field: string): string {
  if (
    field.includes(",") ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r")
  ) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * Convert a single transaction record into a CSV row string.
 */
function recordToCSVRow(record: TransactionRecord): string {
  return [
    escapeCSVField(record.date),
    escapeCSVField(record.action),
    escapeCSVField(record.asset),
    escapeCSVField(record.amount.toFixed(7)),
    escapeCSVField(record.usdValue.toFixed(2)),
    escapeCSVField(record.txHash),
  ].join(",");
}

/**
 * Generate a CSV string from an array of transaction records.
 *
 * For small datasets (< 1000 transactions), this is simpler
 * than streaming.
 *
 * @param records - Array of transaction records.
 * @returns Complete CSV string with headers.
 */
export function generateCSV(records: TransactionRecord[]): string {
  validateTransactionDataset(records);
  const rows = [CSV_HEADER_LINE];
  for (const record of records) {
    rows.push(recordToCSVRow(record));
  }
  return rows.join("\n");
}

/**
 * Create a readable stream that emits CSV data row by row.
 *
 * For large datasets (thousands of transactions), streaming prevents
 * memory exhaustion and allows piping directly to the HTTP response.
 *
 * @param records - Array of transaction records (or async iterable).
 * @returns A readable stream emitting CSV content.
 */
export function createCSVStream(records: TransactionRecord[]): Readable {
  validateTransactionDataset(records);
  let index = -1;
  const total = records.length;

  return new Readable({
    read() {
      if (index === -1) {
        this.push(CSV_HEADER_LINE + "\n");
        index = 0;
        return;
      }

      if (index >= total) {
        this.push(null);
        return;
      }

      // Push in batches of 100 for efficiency
      const batchEnd = Math.min(index + 100, total);
      let chunk = "";
      for (let i = index; i < batchEnd; i++) {
        chunk += recordToCSVRow(records[i]) + "\n";
      }
      this.push(chunk);
      index = batchEnd;
    },
  });
}

/**
 * Replace any character that is not alphanumeric, dot, underscore or hyphen
 * with a single hyphen, and trim leading/trailing hyphens. Keeps export
 * filenames safe across operating systems and Content-Disposition headers.
 */
export function sanitizeFilenameSegment(value: string): string {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".") // collapse runs of dots so no segment contains ".."
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** Resolve the current deployment environment for filename tagging. */
function currentEnvironment(): string {
  const raw =
    process.env.STELLAR_NETWORK ??
    process.env.NETWORK ??
    process.env.NODE_ENV ??
    "production";
  return sanitizeFilenameSegment(raw.toLowerCase()) || "production";
}

/**
 * Create a standardized, filesystem-safe filename for an export download.
 *
 * Format: `stellaryield-<reportType>-<environment>-<shortAddr>-<YYYY-MM-DD>.<ext>`
 * e.g. `stellaryield-tax-report-testnet-GABCDEFG-2026-05-26.csv`.
 *
 * @param address - The user's wallet address (first 8 chars are used).
 * @param options - Optional report type (default `tax-report`) and extension
 *   (default `csv`). All segments are sanitized of unsafe characters.
 */
export function createExportFilename(
  address: string,
  options: { reportType?: string; extension?: string } = {},
): string {
  const reportType = sanitizeFilenameSegment(options.reportType ?? "tax-report");
  const extension = sanitizeFilenameSegment(options.extension ?? "csv") || "csv";
  const env = currentEnvironment();
  const date = new Date().toISOString().split("T")[0];
  const shortAddr = sanitizeFilenameSegment(address.slice(0, 8));
  return `stellaryield-${reportType}-${env}-${shortAddr}-${date}.${extension}`;
}
