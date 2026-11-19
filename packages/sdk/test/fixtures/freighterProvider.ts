/**
 * Minimal Freighter-like provider fixture for SDK adapter testing.
 * Simulates a browser-based Freighter extension with configurable behaviors.
 *
 * Acceptance Criteria coverage:
 * - [ ] SDK tests cover supported provider methods and missing-method fallbacks.
 * - [ ] Permission denial returns a typed SDK error instead of an unknown exception.
 */

export interface FreighterProviderApi {
  getPublicKey: () => Promise<string>;
  signTransaction: (
    xdr: string,
    opts: { networkPassphrase: string }
  ) => Promise<string>;
  isAllowed?: () => Promise<boolean>;
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  switchNetwork?: (networkPassphrase: string) => Promise<void>;
}

export class FreighterLikeProvider implements SignerAdapter {
  private publicKeyCache?: string;
  private readonly api: FreighterProviderApi;

  constructor(api?: FreighterProviderApi) {
    this.api = api ?? this._defaultApi();
  }

  private _defaultApi(): FreighterProviderApi {
    return {
      getPublicKey: async () => {
        throw new ProviderConnectionError("Freighter", "Wallet not installed");
      },
      signTransaction: async () => {
        throw new ProviderMethodError("Freighter", "signTransaction", "Method not implemented");
      },
      isAllowed: async () => false,
    };
  }

  async getPublicKey(): Promise<string> {
    if (this.publicKeyCache) {
      return this.publicKeyCache;
    }
    try {
      const api = this.api;
      if (!api.getPublicKey) {
        throw new ProviderMethodError("Freighter", "getPublicKey");
      }
      const pubKey = await api.getPublicKey();
      if (!pubKey) {
        throw new ProviderMethodError("Freighter", "getPublicKey", " returned empty public key");
      }
      this.publicKeyCache = pubKey;
      return pubKey;
    } catch (err) {
      if (err instanceof ProviderConnectionError || err instanceof ProviderMethodError) {
        throw err;
      }
      throw new ProviderConnectionError("Freighter", err instanceof Error ? err.message : String(err));
    }
  }

  async signTransaction(
    unsignedXdr: string,
    opts: { networkPassphrase: string }
  ): Promise<string> {
    try {
      const api = this.api;
      if (!api.signTransaction) {
        throw new ProviderMethodError("Freighter", "signTransaction", "Method not implemented");
      }
      const signedXdr = await api.signTransaction(unsignedXdr, {
        networkPassphrase: opts.networkPassphrase,
      });
      if (!signedXdr) {
        throw new ProviderMethodError("Freighter", "signTransaction", " returned empty signed XDR");
      }
      return signedXdr;
    } catch (err) {
      if (err instanceof ProviderConnectionError || err instanceof ProviderMethodError) {
        throw err;
      }
      throw new ProviderMethodError(
        "Freighter",
        "signTransaction",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  async connect(): Promise<void> {
    try {
      const api = this.api;
      if (!api.connect) {
        throw new ProviderMethodError("Freighter", "connect", "Method not implemented");
      }
      await api.connect();
    } catch (err) {
      if (err instanceof ProviderMethodError) {
        throw err;
      }
      throw new ProviderConnectionError("Freighter", err instanceof Error ? err.message : String(err));
    }
  }

  async disconnect(): Promise<void> {
    try {
      const api = this.api;
      if (!api.disconnect) {
        throw new ProviderMethodError("Freighter", "disconnect", "Method not implemented");
      }
      await api.disconnect();
    } catch (err) {
      if (err instanceof ProviderMethodError) {
        throw err;
      }
      throw new ProviderConnectionError("Freighter", err instanceof Error ? err.message : String(err));
    }
  }

  async switchNetwork(networkPassphrase: string): Promise<void> {
    try {
      const api = this.api;
      if (!api.switchNetwork) {
        throw new ProviderMethodError("Freighter", "switchNetwork", "Method not implemented");
      }
      await api.switchNetwork(networkPassphrase);
    } catch (err) {
      if (err instanceof ProviderMethodError) {
        throw err;
      }
      throw new ProviderConnectionError("Freighter", err instanceof Error ? err.message : String(err));
    }
  }
}

export function createFreighterProvider(
  overrides: Partial<FreighterProviderApi> = {}
): FreighterLikeProvider {
  const api: FreighterProviderApi = {
    getPublicKey: async () => {
      throw new ProviderConnectionError("Freighter", "Wallet not installed");
    },
    signTransaction: async () => {
      throw new ProviderMethodError("Freighter", "signTransaction", "Method not implemented");
    },
    isAllowed: async () => false,
    connect: async () => {
      throw new ProviderMethodError("Freighter", "connect", "Method not implemented");
    },
    disconnect: async () => {
      throw new ProviderMethodError("Freighter", "disconnect", "Method not implemented");
    },
    switchNetwork: async () => {
      throw new ProviderMethodError("Freighter", "switchNetwork", "Method not implemented");
    },
    ...overrides,
  };

  return new FreighterLikeProvider(api);
}

export function createFullFreighterProvider(
  overrides: Partial<FreighterProviderApi> = {}
): FreighterLikeProvider {
  const api: FreighterProviderApi = {
    getPublicKey: async () => "GBEN_TEST_PUBLIC_KEY",
    signTransaction: async (xdr: string, opts: { networkPassphrase: string }) => xdr,
    isAllowed: async () => true,
    connect: async () => {},
    disconnect: async () => {},
    switchNetwork: async (networkPassphrase: string) => {},
    ...overrides,
  };

  return new FreighterLikeProvider(api);
}