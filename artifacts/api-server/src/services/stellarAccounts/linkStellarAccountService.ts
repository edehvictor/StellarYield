import { randomUUID } from "node:crypto";
import { AccountLinkError } from "../../lib/errors";
import type {
  LinkStellarAccountInput,
  LinkStellarAccountUseCase,
  StellarAccountRecord,
  StellarAccountRepository,
} from "./types";

/**
 * Links a StrKey-validated Stellar public key to a client.
 *
 * - Existing links are returned as-is (idempotent), so empty/duplicate
 *   submissions never create duplicate rows.
 * - Storage failures are wrapped into a stable typed 503; the raw provider
 *   error is attached as `cause` for logging and never serialized.
 * - A create that loses the unique-constraint race to a concurrent request
 *   re-reads storage and returns the winning record instead of failing.
 */
export class LinkStellarAccountService implements LinkStellarAccountUseCase {
  public constructor(
    private readonly accounts: StellarAccountRepository,
  ) {}

  public async execute(
    input: LinkStellarAccountInput,
  ): Promise<StellarAccountRecord> {
    const linkedAt = input.now ?? new Date();

    const existing = await this.findAccount(input.clientId, input.publicKey);

    if (existing !== null) {
      return existing;
    }

    try {
      return await this.accounts.create({
        id: randomUUID(),
        clientId: input.clientId,
        publicKey: input.publicKey,
        linkedAt,
      });
    } catch (cause) {
      // Either a concurrent request won the unique-constraint race (return
      // its record) or storage is unavailable (stable typed 503).
      const winner = await this.findAccount(
        input.clientId,
        input.publicKey,
      ).catch(() => null);

      if (winner !== null) {
        return winner;
      }

      throw AccountLinkError.accountServiceUnavailable(cause);
    }
  }

  private async findAccount(
    clientId: string,
    publicKey: string,
  ): Promise<StellarAccountRecord | null> {
    try {
      return await this.accounts.findByClientAndPublicKey(
        clientId,
        publicKey,
      );
    } catch (cause) {
      throw AccountLinkError.accountServiceUnavailable(cause);
    }
  }
}
