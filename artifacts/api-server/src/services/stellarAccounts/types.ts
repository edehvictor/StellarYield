/**
 * Domain record for a linked Stellar account as the service layer observes
 * it. `publicKey` is always a StrKey-validated value.
 */
export interface StellarAccountRecord {
  readonly id: string;
  readonly clientId: string;
  readonly publicKey: string;
  readonly linkedAt: Date;
}

/**
 * Storage port used by the link use case. `create` must enforce the
 * `(clientId, publicKey)` unique constraint so concurrent duplicate links
 * surface as an error the service can re-classify.
 */
export interface StellarAccountRepository {
  findByClientAndPublicKey(
    clientId: string,
    publicKey: string,
  ): Promise<StellarAccountRecord | null>;

  create(input: {
    id: string;
    clientId: string;
    publicKey: string;
    linkedAt: Date;
  }): Promise<StellarAccountRecord>;
}

export interface LinkStellarAccountInput {
  readonly clientId: string;
  /** StrKey-validated Stellar public key (G... format). */
  readonly publicKey: string;
  /** Injectable clock for deterministic tests; defaults to `new Date()`. */
  readonly now?: Date;
}

/** Use-case port consumed by the route layer. */
export interface LinkStellarAccountUseCase {
  execute(input: LinkStellarAccountInput): Promise<StellarAccountRecord>;
}
