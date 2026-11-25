export const TRANSACTION_ANOMALY_CODES = {
  LARGE_AMOUNT: "LARGE_AMOUNT",
  RAPID_CONSECUTIVE: "RAPID_CONSECUTIVE",
} as const;

export type TransactionAnomalyCode =
  (typeof TRANSACTION_ANOMALY_CODES)[keyof typeof TRANSACTION_ANOMALY_CODES];

export type TransactionAnomalySeverity = "low" | "medium" | "high";

export type TransactionType = "deposit" | "withdrawal" | "transfer";

export interface Transaction {
  id: string;
  amount: number;
  timestamp: Date | string | number;
  type: TransactionType;
}

export interface Anomaly {
  transactionId: string;
  reason: string;
  severity: TransactionAnomalySeverity;
  code: TransactionAnomalyCode;
}

export interface TransactionHistoryAnomalyDetectorOptions {
  largeAmountThreshold?: number;
  rapidWindowMs?: number;
}

export type TransactionHistoryAnomalyErrorCode =
  | "INVALID_INPUT"
  | "INVALID_TRANSACTION"
  | "INVALID_TRANSACTION_ID"
  | "INVALID_TRANSACTION_AMOUNT"
  | "INVALID_TRANSACTION_TIMESTAMP"
  | "UNSUPPORTED_TRANSACTION_TYPE"
  | "INVALID_OPTION";

export class TransactionHistoryAnomalyError extends Error {
  public readonly code: TransactionHistoryAnomalyErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: TransactionHistoryAnomalyErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TransactionHistoryAnomalyError";
    this.code = code;
    this.details = details;
  }
}

interface NormalizedTransaction {
  index: number;
  id: string;
  amount: number;
  timestampMs: number;
  type: TransactionType;
}

const SUPPORTED_TRANSACTION_TYPES: ReadonlySet<TransactionType> = new Set([
  "deposit",
  "withdrawal",
  "transfer",
]);

const DEFAULT_LARGE_AMOUNT_THRESHOLD = 1_000_000;
const DEFAULT_RAPID_WINDOW_MS = 5_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeOptions(
  options?: TransactionHistoryAnomalyDetectorOptions,
): Required<TransactionHistoryAnomalyDetectorOptions> {
  if (options === undefined) {
    return {
      largeAmountThreshold: DEFAULT_LARGE_AMOUNT_THRESHOLD,
      rapidWindowMs: DEFAULT_RAPID_WINDOW_MS,
    };
  }

  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TransactionHistoryAnomalyError(
      "INVALID_OPTION",
      "options must be an object",
    );
  }

  const largeAmountThreshold =
    options.largeAmountThreshold ?? DEFAULT_LARGE_AMOUNT_THRESHOLD;
  const rapidWindowMs = options.rapidWindowMs ?? DEFAULT_RAPID_WINDOW_MS;

  if (!isFiniteNumber(largeAmountThreshold) || largeAmountThreshold < 0) {
    throw new TransactionHistoryAnomalyError(
      "INVALID_OPTION",
      "largeAmountThreshold must be a finite number >= 0",
      { largeAmountThreshold },
    );
  }

  if (!isFiniteNumber(rapidWindowMs) || rapidWindowMs < 0) {
    throw new TransactionHistoryAnomalyError(
      "INVALID_OPTION",
      "rapidWindowMs must be a finite number >= 0",
      { rapidWindowMs },
    );
  }

  return { largeAmountThreshold, rapidWindowMs };
}

function normalizeTimestamp(
  timestamp: Transaction["timestamp"],
  index: number,
  transactionId: string,
): number {
  let ms: number;
  if (timestamp instanceof Date) {
    ms = timestamp.getTime();
  } else if (typeof timestamp === "string" || typeof timestamp === "number") {
    ms = new Date(timestamp).getTime();
  } else {
    throw new TransactionHistoryAnomalyError(
      "INVALID_TRANSACTION_TIMESTAMP",
      "transaction timestamp must be a Date, ISO string, or epoch number",
      { index, transactionId },
    );
  }

  if (!Number.isFinite(ms)) {
    throw new TransactionHistoryAnomalyError(
      "INVALID_TRANSACTION_TIMESTAMP",
      "transaction timestamp is invalid",
      { index, transactionId },
    );
  }

  return ms;
}

function normalizeTransaction(
  tx: unknown,
  index: number,
): NormalizedTransaction {
  if (typeof tx !== "object" || tx === null || Array.isArray(tx)) {
    throw new TransactionHistoryAnomalyError(
      "INVALID_TRANSACTION",
      "transaction must be an object",
      { index },
    );
  }

  const record = tx as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new TransactionHistoryAnomalyError(
      "INVALID_TRANSACTION_ID",
      "transaction id must be a non-empty string",
      { index },
    );
  }

  const amount = record.amount;
  if (!isFiniteNumber(amount) || amount < 0) {
    throw new TransactionHistoryAnomalyError(
      "INVALID_TRANSACTION_AMOUNT",
      "transaction amount must be a finite number >= 0",
      { index, transactionId: id },
    );
  }

  const type = record.type;
  if (
    typeof type !== "string" ||
    !SUPPORTED_TRANSACTION_TYPES.has(type as TransactionType)
  ) {
    throw new TransactionHistoryAnomalyError(
      "UNSUPPORTED_TRANSACTION_TYPE",
      "transaction type is unsupported",
      { index, transactionId: id, type },
    );
  }

  const timestampMs = normalizeTimestamp(
    record.timestamp as Transaction["timestamp"],
    index,
    id,
  );

  return {
    index,
    id,
    amount,
    timestampMs,
    type: type as TransactionType,
  };
}

function compareNormalizedTransactions(
  a: NormalizedTransaction,
  b: NormalizedTransaction,
): number {
  if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.index - b.index;
}

/**
 * Service to detect anomalies in transaction histories.
 */
export class TransactionHistoryAnomalyDetector {
  /**
   * Detects anomalies in a list of transactions based on volume, frequency, and pattern.
   * Returns anomalies in deterministic order: transaction timestamp, transaction id, input index.
   */
  public detectAnomalies(
    transactions: Transaction[],
    options?: TransactionHistoryAnomalyDetectorOptions,
  ): Anomaly[] {
    if (!Array.isArray(transactions)) {
      throw new TransactionHistoryAnomalyError(
        "INVALID_INPUT",
        "transactions must be an array",
      );
    }

    const { largeAmountThreshold, rapidWindowMs } = normalizeOptions(options);

    const normalized = transactions.map((tx, index) =>
      normalizeTransaction(tx, index),
    );
    const sortedTxs = [...normalized].sort(compareNormalizedTransactions);

    const anomalies: Anomaly[] = [];

    for (let i = 0; i < sortedTxs.length; i++) {
      const tx = sortedTxs[i];

      if (tx.amount > largeAmountThreshold) {
        anomalies.push({
          transactionId: tx.id,
          reason: "Unusually large transaction amount detected",
          severity: "high",
          code: TRANSACTION_ANOMALY_CODES.LARGE_AMOUNT,
        });
      }

      if (i > 0) {
        const prevTx = sortedTxs[i - 1];
        const timeDiffMs = tx.timestampMs - prevTx.timestampMs;
        if (timeDiffMs < rapidWindowMs && tx.type === prevTx.type) {
          anomalies.push({
            transactionId: tx.id,
            reason: "High frequency of identical transaction types",
            severity: "medium",
            code: TRANSACTION_ANOMALY_CODES.RAPID_CONSECUTIVE,
          });
        }
      }
    }

    return anomalies;
  }
}

export const transactionHistoryAnomalyDetector =
  new TransactionHistoryAnomalyDetector();
