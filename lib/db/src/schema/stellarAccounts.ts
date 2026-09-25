import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A Stellar public key linked to a client. `publicKey` is validated with
 * StrKey decoding before it ever reaches this table, so stored values are
 * always well-formed 56-character G-prefixed keys.
 */
export const stellarAccountsTable = pgTable(
  "stellar_accounts",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    publicKey: text("public_key").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("stellar_accounts_client_id_public_key_unique").on(
      table.clientId,
      table.publicKey,
    ),
  ],
);

export const insertStellarAccountSchema = createInsertSchema(
  stellarAccountsTable,
);

export type InsertStellarAccount = z.infer<
  typeof insertStellarAccountSchema
>;

export type StellarAccountRow = typeof stellarAccountsTable.$inferSelect;
