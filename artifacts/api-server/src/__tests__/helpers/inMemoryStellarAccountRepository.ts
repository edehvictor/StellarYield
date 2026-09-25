import type {
  StellarAccountRecord,
  StellarAccountRepository,
} from "../../services/stellarAccounts/types";

export interface SeedAccountInput {
  readonly id?: string;
  readonly clientId: string;
  readonly publicKey: string;
}

export type StorageFailureMode = "none" | "read" | "write" | "all";

/**
 * In-memory implementation of the account storage port used by unit and
 * integration tests so the full request pipeline can run without a live
 * PostgreSQL instance. Mirrors the unique-constraint semantics of the
 * Drizzle implementation and can simulate provider outages and lost races.
 */
export class InMemoryStellarAccountRepository
  implements StellarAccountRepository
{
  private readonly records = new Map<string, StellarAccountRecord>();
  private createAttempts = 0;

  /** Simulates a database/network outage for the given operation side. */
  public failureMode: StorageFailureMode = "none";
  public failureError: Error | null = null;

  /**
   * When set, `create` fails with a unique-constraint violation and
   * subsequent reads return this record - modelling a concurrent request
   * that won the link race.
   */
  public duplicateRaceWinner: StellarAccountRecord | null = null;

  public seed(input: SeedAccountInput): StellarAccountRecord {
    const record: StellarAccountRecord = {
      id: input.id ?? "00000000-0000-4000-8000-000000000001",
      clientId: input.clientId,
      publicKey: input.publicKey,
      linkedAt: new Date("2026-09-25T00:00:00.000Z"),
    };

    this.records.set(this.key(input.clientId, input.publicKey), record);

    return record;
  }

  public size(): number {
    return this.records.size;
  }

  public clear(): void {
    this.records.clear();
    this.failureMode = "none";
    this.failureError = null;
    this.duplicateRaceWinner = null;
    this.createAttempts = 0;
  }

  public async findByClientAndPublicKey(
    clientId: string,
    publicKey: string,
  ): Promise<StellarAccountRecord | null> {
    this.maybeFail("read");

    if (this.duplicateRaceWinner !== null && this.createAttempts > 0) {
      return { ...this.duplicateRaceWinner };
    }

    const record = this.records.get(this.key(clientId, publicKey));

    return record === undefined ? null : { ...record };
  }

  public async create(input: {
    id: string;
    clientId: string;
    publicKey: string;
    linkedAt: Date;
  }): Promise<StellarAccountRecord> {
    this.createAttempts += 1;
    this.maybeFail("write");

    if (this.duplicateRaceWinner !== null) {
      throw new Error(
        'duplicate key value violates constraint "stellar_accounts_client_id_public_key_unique"',
      );
    }

    const record: StellarAccountRecord = { ...input };
    this.records.set(this.key(input.clientId, input.publicKey), record);

    return { ...record };
  }

  private key(clientId: string, publicKey: string): string {
    return `${clientId}::${publicKey}`;
  }

  private maybeFail(operation: "read" | "write"): void {
    const applies =
      this.failureMode === "all" || this.failureMode === operation;

    if (applies && this.failureError !== null) {
      throw this.failureError;
    }
  }
}
