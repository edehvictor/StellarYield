import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { transactionIntentsTable } from "@workspace/db/schema";
import type {
  TransactionIntentRecord,
  TransactionIntentRepository,
} from "./types";
import type { TransactionIntentRow } from "@workspace/db/schema";

type DrizzleDatabase = typeof db;

function toRecord(row: TransactionIntentRow): TransactionIntentRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    status: row.status,
    payload: row.payload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cancelledAt: row.cancelledAt,
  };
}

/**
 * Drizzle/PostgreSQL implementation of the intent storage port.
 *
 * `cancelIfPending` runs inside a single database transaction and guards the
 * update with `status = 'pending'`, so concurrent cancellations or an
 * execution racing the request resolve atomically: exactly one writer wins,
 * everyone else observes `null` and re-classifies the outcome.
 */
export class DrizzleTransactionIntentRepository
  implements TransactionIntentRepository
{
  public constructor(
    private readonly database: DrizzleDatabase = db,
  ) {}

  public async findById(
    intentId: string,
  ): Promise<TransactionIntentRecord | null> {
    const rows = await this.database
      .select()
      .from(transactionIntentsTable)
      .where(eq(transactionIntentsTable.id, intentId))
      .limit(1);

    const row = rows[0];

    return row === undefined ? null : toRecord(row);
  }

  public async cancelIfPending(
    intentId: string,
    clientId: string,
    cancelledAt: Date,
  ): Promise<TransactionIntentRecord | null> {
    return this.database.transaction(async (tx) => {
      const rows = await tx
        .update(transactionIntentsTable)
        .set({
          status: "cancelled",
          cancelledAt,
          updatedAt: cancelledAt,
        })
        .where(
          and(
            eq(transactionIntentsTable.id, intentId),
            eq(transactionIntentsTable.clientId, clientId),
            eq(transactionIntentsTable.status, "pending"),
          ),
        )
        .returning();

      const row = rows[0];

      return row === undefined ? null : toRecord(row);
    });
  }
}
