import type { TransactionIntentStatus } from "@workspace/db/schema";

/**
 * Domain record for a transaction intent as the service layer observes it.
 * `payload` may legitimately be an empty object for intents created without
 * auxiliary data — all consumers must tolerate empty state structures.
 */
export interface TransactionIntentRecord {
  readonly id: string;
  readonly clientId: string;
  readonly status: TransactionIntentStatus;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly cancelledAt: Date | null;
}

/**
 * Storage port used by the cancel use case. Implementations must make
 * `cancelIfPending` an atomic compare-and-set on `(id, clientId, status =
 * 'pending')` executed inside a database transaction so concurrent requests
 * cannot both observe a cancellation.
 */
export interface TransactionIntentRepository {
  /** Returns the intent or `null` when it does not exist / was cleared. */
  findById(intentId: string): Promise<TransactionIntentRecord | null>;

  /**
   * Atomically flips a pending intent to cancelled.
   *
   * @returns the updated record, or `null` when the row was missing or no
   * longer pending (the caller must re-read to classify the outcome).
   */
  cancelIfPending(
    intentId: string,
    clientId: string,
    cancelledAt: Date,
  ): Promise<TransactionIntentRecord | null>;
}

export interface CancelTransactionIntentInput {
  readonly intentId: string;
  readonly clientId: string;
  /** Injectable clock for deterministic tests; defaults to `new Date()`. */
  readonly now?: Date;
}

/** Use-case port consumed by the route layer. */
export interface CancelTransactionIntentUseCase {
  execute(
    input: CancelTransactionIntentInput,
  ): Promise<TransactionIntentRecord>;
}
