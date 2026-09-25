import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { stellarAccountsTable } from "@workspace/db/schema";
import type { StellarAccountRow } from "@workspace/db/schema";
import type {
  StellarAccountRecord,
  StellarAccountRepository,
} from "./types";

type DrizzleDatabase = typeof db;

function toRecord(row: StellarAccountRow): StellarAccountRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    publicKey: row.publicKey,
    linkedAt: row.linkedAt,
  };
}

/**
 * Drizzle/PostgreSQL implementation of the account storage port. Only
 * StrKey-validated public keys reach this repository - the controller input
 * middleware rejects everything else first.
 */
export class DrizzleStellarAccountRepository
  implements StellarAccountRepository
{
  public constructor(
    private readonly database: DrizzleDatabase = db,
  ) {}

  public async findByClientAndPublicKey(
    clientId: string,
    publicKey: string,
  ): Promise<StellarAccountRecord | null> {
    const rows = await this.database
      .select()
      .from(stellarAccountsTable)
      .where(
        and(
          eq(stellarAccountsTable.clientId, clientId),
          eq(stellarAccountsTable.publicKey, publicKey),
        ),
      )
      .limit(1);

    const row = rows[0];

    return row === undefined ? null : toRecord(row);
  }

  public async create(input: {
    id: string;
    clientId: string;
    publicKey: string;
    linkedAt: Date;
  }): Promise<StellarAccountRecord> {
    const rows = await this.database
      .insert(stellarAccountsTable)
      .values(input)
      .returning();

    const row = rows[0];

    if (row === undefined) {
      throw new Error("Insert of a linked Stellar account returned no row.");
    }

    return toRecord(row);
  }
}
