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
const CSV_HEADERS = [
  "Date",
  "Action",
  "Asset",
  "Amount",
  "USD Value",
  "TxHash",
];

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
  const rows = [CSV_HEADERS.join(",")];
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
  let index = -1;
  const total = records.length;

  return new Readable({
    read() {
      if (index === -1) {
        this.push(CSV_HEADERS.join(",") + "\n");
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
 * Create a filename for the tax export CSV.
 *
 * @param address - The user's wallet address.
 * @returns A safe filename string.
 */
export function createExportFilename(address: string): string {
  const date = new Date().toISOString().split("T")[0];
  const shortAddr = address.slice(0, 8);
  return `stellaryield-tax-report-${shortAddr}-${date}.csv`;
}
