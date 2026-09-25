import { jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Lifecycle of a transaction intent.
 *
 * - `pending`   : waiting to be executed or cancelled; the only cancellable state.
 * - `cancelled` : explicitly cancelled by its owning client.
 * - `processed` : executed on-chain / settled downstream; can no longer be cancelled.
 * - `cleared`   : expired or swept out of the pending set; can no longer be cancelled.
 */
export const transactionIntentStatusValues = [
  "pending",
  "cancelled",
  "processed",
  "cleared",
] as const;

export type TransactionIntentStatus = (typeof transactionIntentStatusValues)[number];

export const transactionIntentStatusEnum = pgEnum(
  "transaction_intent_status",
  transactionIntentStatusValues,
);

export const transactionIntentsTable = pgTable("transaction_intents", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  status: transactionIntentStatusEnum("status").notNull().default("pending"),
  payload: jsonb("payload")
    .$type<Record<string, unknown>>()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
});

export const insertTransactionIntentSchema = createInsertSchema(
  transactionIntentsTable,
);

export type InsertTransactionIntent = z.infer<
  typeof insertTransactionIntentSchema
>;

export type TransactionIntentRow =
  typeof transactionIntentsTable.$inferSelect;
