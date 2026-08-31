import { Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { WalletRejectedError, InvalidXdrError } from "./errors";

export interface SignerAdapter {
  getPublicKey(): Promise<string>;
  signTransaction(
    unsignedXdr: string,
    opts: { networkPassphrase: string; contractId?: string }
  ): Promise<string>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  switchNetwork(networkPassphrase: string): Promise<void>;
}

export class ServerKeypairSigner implements SignerAdapter {
  constructor(private readonly keypair: Keypair) {}

  public static fromSecret(secretKey: string): ServerKeypairSigner {
    return new ServerKeypairSigner(Keypair.fromSecret(secretKey));
  }

  public static random(): ServerKeypairSigner {
    return new ServerKeypairSigner(Keypair.random());
  }

  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async signTransaction(
    unsignedXdr: string,
    opts: { networkPassphrase: string }
  ): Promise<string> {
    try {
      const tx = TransactionBuilder.fromXDR(unsignedXdr, opts.networkPassphrase);
      tx.sign(this.keypair);
      return tx.toXDR();
    } catch (error) {
      throw new InvalidXdrError(
        unsignedXdr,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

export class CustomSigner implements SignerAdapter {
  constructor(
    private readonly publicKey: string,
    private readonly signFn: (
      unsignedXdr: string,
      networkPassphrase: string
    ) => Promise<string>
  ) {}

  async getPublicKey(): Promise<string> {
    return this.publicKey;
  }

  async signTransaction(
    unsignedXdr: string,
    opts: { networkPassphrase: string }
  ): Promise<string> {
    try {
      return await this.signFn(unsignedXdr, opts.networkPassphrase);
    } catch (error) {
      throw new WalletRejectedError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

export class FreighterSigner implements SignerAdapter {
  private publicKeyCache?: string;

  constructor(
    private readonly freighterApi?: {
      getPublicKey: () => Promise<string>;
      signTransaction: (
        xdr: string,
        opts: { networkPassphrase: string }
      ) => Promise<string>;
      isAllowed?: () => Promise<boolean>;
    }
  ) {}

  private getApi() {
    if (this.freighterApi) {
      return this.freighterApi;
    }
    const globalObj = typeof globalThis !== "undefined" ? (globalThis as any) : {};
    if (globalObj.freighter) {
      return globalObj.freighter;
    }
    throw new WalletRejectedError(
      "Freighter wallet is not installed or unavailable in current environment."
    );
  }

  async getPublicKey(): Promise<string> {
    if (this.publicKeyCache) {
      return this.publicKeyCache;
    }
    const api = this.getApi();
    try {
      const pubKey = await api.getPublicKey();
      if (!pubKey) {
        throw new WalletRejectedError("Freighter returned empty public key");
      }
      this.publicKeyCache = pubKey;
      return pubKey;
    } catch (err) {
      if (err instanceof WalletRejectedError) {
        throw err;
      }
      throw new WalletRejectedError(
        `Failed to retrieve public key from Freighter: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async signTransaction(
    unsignedXdr: string,
    opts: { networkPassphrase: string }
  ): Promise<string> {
    const api = this.getApi();
    try {
      const signedXdr = await api.signTransaction(unsignedXdr, {
        networkPassphrase: opts.networkPassphrase,
      });
      if (!signedXdr) {
        throw new WalletRejectedError("Freighter returned empty signed XDR string");
      }
      return signedXdr;
    } catch (err) {
      if (err instanceof WalletRejectedError) {
        throw err;
      }
      throw new WalletRejectedError(
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

export function createTestKeypairSigner(): ServerKeypairSigner {
  return ServerKeypairSigner.random();
}
