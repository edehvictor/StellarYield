/**
 * Portfolio import validation for external CSV files (#1340).
 *
 * A holdings CSV exported from another tool (or from StellarYield itself) is
 * checked before anything is imported: file-level problems — empty, too large,
 * malformed quoting, missing columns — fail the whole import with one stable
 * code, while row-level problems are collected per row so the valid rows can
 * still be previewed. Every outcome is a code from the catalogs below, so the
 * server and the UI branch on the same names.
 *
 * Header matching ignores case, spaces, and punctuation, so `deposited_usd`,
 * `Deposited USD`, and StellarYield's own export header `Deposited (USD)` all
 * map to `depositedUsd`. Extra columns are ignored. Row numbers count the
 * header as row 1, matching the row numbers a spreadsheet shows.
 */

/** Largest accepted file, in bytes (keeps the JSON request under the API body limit). */
export const PORTFOLIO_IMPORT_MAX_BYTES = 64 * 1024;
/** Largest accepted number of data rows. */
export const PORTFOLIO_IMPORT_MAX_ROWS = 1_000;

/** Columns every import must provide. */
export const PORTFOLIO_IMPORT_COLUMNS = ["protocol", "asset", "depositedUsd", "currentValueUsd"] as const;
export type PortfolioImportColumn = (typeof PORTFOLIO_IMPORT_COLUMNS)[number];

const HEADER_ALIASES: Record<string, PortfolioImportColumn> = {
  protocol: "protocol",
  asset: "asset",
  depositedusd: "depositedUsd",
  deposited: "depositedUsd",
  currentvalueusd: "currentValueUsd",
  currentvalue: "currentValueUsd",
};

// ── File-level failures ────────────────────────────────────────────────────

export type PortfolioImportFailureCode =
  /** The browser could not read the selected file (client-side only). */
  | "IMPORT_UNREADABLE_FILE"
  | "IMPORT_EMPTY_FILE"
  | "IMPORT_FILE_TOO_LARGE"
  | "IMPORT_MALFORMED_CSV"
  | "IMPORT_MISSING_COLUMNS"
  | "IMPORT_DUPLICATE_COLUMNS"
  | "IMPORT_NO_DATA_ROWS"
  | "IMPORT_TOO_MANY_ROWS";

export interface PortfolioImportFailureDescriptor {
  code: PortfolioImportFailureCode;
  /** HTTP status the API answers with for this failure. */
  httpStatus: number;
  message: string;
}

export const PORTFOLIO_IMPORT_FAILURES: Record<PortfolioImportFailureCode, PortfolioImportFailureDescriptor> = {
  IMPORT_UNREADABLE_FILE: {
    code: "IMPORT_UNREADABLE_FILE",
    httpStatus: 400,
    message: "The file could not be read.",
  },
  IMPORT_EMPTY_FILE: {
    code: "IMPORT_EMPTY_FILE",
    httpStatus: 400,
    message: "The file is empty.",
  },
  IMPORT_FILE_TOO_LARGE: {
    code: "IMPORT_FILE_TOO_LARGE",
    httpStatus: 413,
    message: `The file is larger than ${PORTFOLIO_IMPORT_MAX_BYTES / 1024} KB.`,
  },
  IMPORT_MALFORMED_CSV: {
    code: "IMPORT_MALFORMED_CSV",
    httpStatus: 400,
    message: "The file is not valid CSV: a quoted value is never closed.",
  },
  IMPORT_MISSING_COLUMNS: {
    code: "IMPORT_MISSING_COLUMNS",
    httpStatus: 422,
    message: "The header row is missing required columns: protocol, asset, depositedUsd, currentValueUsd.",
  },
  IMPORT_DUPLICATE_COLUMNS: {
    code: "IMPORT_DUPLICATE_COLUMNS",
    httpStatus: 422,
    message: "The header row names the same column more than once.",
  },
  IMPORT_NO_DATA_ROWS: {
    code: "IMPORT_NO_DATA_ROWS",
    httpStatus: 422,
    message: "The file has a header row but no holdings.",
  },
  IMPORT_TOO_MANY_ROWS: {
    code: "IMPORT_TOO_MANY_ROWS",
    httpStatus: 413,
    message: `The file has more than ${PORTFOLIO_IMPORT_MAX_ROWS} holdings.`,
  },
};

export interface PortfolioImportFailure {
  code: PortfolioImportFailureCode;
  message: string;
  details?: { missingColumns?: PortfolioImportColumn[]; duplicateColumns?: PortfolioImportColumn[] };
}

// ── Row-level issues ───────────────────────────────────────────────────────

export type PortfolioImportRowIssueCode =
  | "ROW_COLUMN_COUNT"
  | "ROW_MISSING_VALUE"
  | "ROW_INVALID_AMOUNT"
  | "ROW_NEGATIVE_AMOUNT"
  | "ROW_DUPLICATE_HOLDING";

export interface PortfolioImportRowIssue {
  /** Row number in the file, counting the header as row 1. */
  row: number;
  /** Offending column, or null when the issue concerns the whole row. */
  column: PortfolioImportColumn | null;
  code: PortfolioImportRowIssueCode;
  message: string;
}

export interface ImportedHolding {
  row: number;
  protocol: string;
  asset: string;
  depositedUsd: number;
  currentValueUsd: number;
}

export interface PortfolioImportPreview {
  /** Rows that passed every check, in file order. */
  holdings: ImportedHolding[];
  /** Every row-level problem, ordered by row. */
  issues: PortfolioImportRowIssue[];
  summary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    totalDepositedUsd: number;
    totalCurrentValueUsd: number;
  };
}

export type PortfolioImportResult =
  | { ok: true; preview: PortfolioImportPreview }
  | { ok: false; error: PortfolioImportFailure };

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * Split CSV text into records (RFC 4180: quoted fields, `""` escapes, CRLF, and
 * newlines inside quotes). Returns null when a quoted field is never closed.
 * Blank lines are dropped.
 */
function parseCsvRecords(text: string): string[][] | null {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (inQuotes) return null;
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const AMOUNT_PATTERN = /^-?\d+(\.\d+)?$/;

function fail(code: PortfolioImportFailureCode, details?: PortfolioImportFailure["details"]): PortfolioImportResult {
  return { ok: false, error: { code, message: PORTFOLIO_IMPORT_FAILURES[code].message, details } };
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Validate an external holdings CSV. Never throws: file-level problems return
 * `{ ok: false }`, row-level problems are listed in the preview's `issues`.
 */
export function validatePortfolioImportCsv(
  csv: string,
  limits: { maxBytes?: number; maxRows?: number } = {},
): PortfolioImportResult {
  const maxBytes = limits.maxBytes ?? PORTFOLIO_IMPORT_MAX_BYTES;
  const maxRows = limits.maxRows ?? PORTFOLIO_IMPORT_MAX_ROWS;

  if (typeof csv !== "string" || csv.trim().length === 0) return fail("IMPORT_EMPTY_FILE");
  if (new TextEncoder().encode(csv).length > maxBytes) return fail("IMPORT_FILE_TOO_LARGE");

  // Spreadsheet exports often start with a UTF-8 byte-order mark.
  const records = parseCsvRecords(csv.replace(/^﻿/, ""));
  if (records === null) return fail("IMPORT_MALFORMED_CSV");
  if (records.length === 0) return fail("IMPORT_EMPTY_FILE");

  const [header, ...rows] = records;
  const columnIndex = new Map<PortfolioImportColumn, number>();
  const duplicateColumns: PortfolioImportColumn[] = [];
  header.forEach((name, index) => {
    const column = HEADER_ALIASES[normalizeHeader(name)];
    if (!column) return;
    if (columnIndex.has(column)) duplicateColumns.push(column);
    else columnIndex.set(column, index);
  });

  const missingColumns = PORTFOLIO_IMPORT_COLUMNS.filter((column) => !columnIndex.has(column));
  if (missingColumns.length > 0) return fail("IMPORT_MISSING_COLUMNS", { missingColumns });
  if (duplicateColumns.length > 0) return fail("IMPORT_DUPLICATE_COLUMNS", { duplicateColumns });
  if (rows.length === 0) return fail("IMPORT_NO_DATA_ROWS");
  if (rows.length > maxRows) return fail("IMPORT_TOO_MANY_ROWS");

  const holdings: ImportedHolding[] = [];
  const issues: PortfolioImportRowIssue[] = [];
  const seen = new Set<string>();

  rows.forEach((fields, index) => {
    const row = index + 2;
    if (fields.length !== header.length) {
      issues.push({
        row,
        column: null,
        code: "ROW_COLUMN_COUNT",
        message: `Expected ${header.length} values but found ${fields.length}.`,
      });
      return;
    }

    const value = (column: PortfolioImportColumn) => fields[columnIndex.get(column)!].trim();
    const rowIssues: PortfolioImportRowIssue[] = [];

    for (const column of ["protocol", "asset"] as const) {
      if (value(column) === "") {
        rowIssues.push({ row, column, code: "ROW_MISSING_VALUE", message: `${column} is required.` });
      }
    }

    const amounts: Partial<Record<PortfolioImportColumn, number>> = {};
    for (const column of ["depositedUsd", "currentValueUsd"] as const) {
      const raw = value(column);
      if (raw === "") {
        rowIssues.push({ row, column, code: "ROW_MISSING_VALUE", message: `${column} is required.` });
      } else if (!AMOUNT_PATTERN.test(raw)) {
        rowIssues.push({ row, column, code: "ROW_INVALID_AMOUNT", message: `${column} must be a plain number.` });
      } else if (Number(raw) < 0) {
        rowIssues.push({ row, column, code: "ROW_NEGATIVE_AMOUNT", message: `${column} cannot be negative.` });
      } else {
        amounts[column] = Number(raw);
      }
    }

    if (rowIssues.length === 0) {
      const key = `${value("protocol").toLowerCase()}\u0000${value("asset").toLowerCase()}`;
      if (seen.has(key)) {
        rowIssues.push({
          row,
          column: null,
          code: "ROW_DUPLICATE_HOLDING",
          message: "This protocol and asset already appear on an earlier row.",
        });
      }
      seen.add(key);
    }

    if (rowIssues.length > 0) {
      issues.push(...rowIssues);
      return;
    }

    holdings.push({
      row,
      protocol: value("protocol"),
      asset: value("asset"),
      depositedUsd: amounts.depositedUsd!,
      currentValueUsd: amounts.currentValueUsd!,
    });
  });

  return {
    ok: true,
    preview: {
      holdings,
      issues,
      summary: {
        totalRows: rows.length,
        validRows: holdings.length,
        invalidRows: rows.length - holdings.length,
        totalDepositedUsd: roundUsd(holdings.reduce((sum, h) => sum + h.depositedUsd, 0)),
        totalCurrentValueUsd: roundUsd(holdings.reduce((sum, h) => sum + h.currentValueUsd, 0)),
      },
    },
  };
}
