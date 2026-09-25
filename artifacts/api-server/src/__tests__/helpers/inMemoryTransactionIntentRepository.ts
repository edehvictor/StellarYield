import type { TransactionIntentStatus } from "@workspace/db/schema";
import type {
  TransactionIntentRecord,
  TransactionIntentRepository,
} from "../../services/transactionIntents/types";

export interface SeedIntentInput {
  readonly id: string;
  readonly clientId: string;
  readonly status?: TransactionIntentStatus;
  readonly payload?: Record<string, unknown>;
}

export type StorageFailureMode = "none" | "read" | "write" | "all";

export type CancelRace =
  | { readonly action: "setStatus"; readonly status: TransactionIntentStatus }
  | { readonly action: "delete" };

/**
 * In-memory implementation of the intent storage port used by unit and
 * integration tests so the full request pipeline can run without a live
 * PostgreSQL instance. Mirrors the compare-and-set semantics of the Drizzle
 * implementation and can simulate provider outages and lost races.
 */
export class InMemoryTransactionIntentRepository
  implements TransactionIntentRepository
{
  private readonly intents = new Map<string, TransactionIntentRecord>();

  /** Simulates a database/network outage for the given operation side. */
  public failureMode: StorageFailureMode = "none";
  public failureError: Error | null = null;

  /**
   * When set, the next `cancelIfPending` call loses a race: it performs no
   * write, applies `action` to the stored row, and returns `null`.
   */
  public cancelRace: CancelRace | null = null;

  public seed(input: SeedIntentInput): TransactionIntentRecord {
    const now = new Date("2026-09-25T00:00:00.000Z");
    const record: TransactionIntentRecord = {
      id: input.id,
      clientId: input.clientId,
      status: input.status ?? "pending",
      payload: input.payload ?? { swap: { asset: "XLM", amount: "100" } },
      createdAt: now,
      updatedAt: now,
      cancelledAt: null,
    };

    this.intents.set(record.id, record);

    return record;
  }

  public get(intentId: string): TransactionIntentRecord | null {
    return this.intents.get(intentId) ?? null;
  }

  public clear(): void {
    this.intents.clear();
    this.failureMode = "none";
    this.failureError = null;
    this.cancelRace = null;
  }

  public async findById(
    intentId: string,
  ): Promise<TransactionIntentRecord | null> {
    this.maybeFail("read");
    const record = this.intents.get(intentId);

    return record === undefined ? null : { ...record };
  }

  public async cancelIfPending(
    intentId: string,
    clientId: string,
    cancelledAt: Date,
  ): Promise<TransactionIntentRecord | null> {
    this.maybeFail("write");

    const race = this.cancelRace;
    if (race !== null) {
      this.cancelRace = null;

      if (race.action === "delete") {
        this.intents.delete(intentId);
      } else {
        const current = this.intents.get(intentId);
        if (current !== undefined) {
          this.intents.set(intentId, {
            ...current,
            status: race.status,
            updatedAt: cancelledAt,
          });
        }
      }

      return null;
    }

    const record = this.intents.get(intentId);

    if (
      record === undefined ||
      record.clientId !== clientId ||
      record.status !== "pending"
    ) {
      return null;
    }

    const updated: TransactionIntentRecord = {
      ...record,
      status: "cancelled",
      cancelledAt,
      updatedAt: cancelledAt,
    };

    this.intents.set(intentId, updated);

    return { ...updated };
  }

  private maybeFail(operation: "read" | "write"): void {
    const applies =
      this.failureMode === "all" || this.failureMode === operation;

    if (applies && this.failureError !== null) {
      throw this.failureError;
    }
  }
}
