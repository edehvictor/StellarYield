/**
 * Unified Wallet Adapter Layer
 *
 * Provides a single `WalletAdapter` interface for Freighter, xBull and Albedo.
 * All wallet-specific SDK calls are isolated here so the rest of the app
 * only depends on `WalletAdapter`.
 */

import { getAddress, isConnected, requestAccess, signTransaction as freighterSign } from "@stellar/freighter-api";
import { xBullWalletConnect } from "@creit.tech/xbull-wallet-connect";
import albedo from "@albedo-link/intent";

import type { ExtensionWalletProviderId } from "./types";

// ── Interface ─────────────────────────────────────────────────────────────

export interface WalletAdapter {
  /** Provider identifier */
  id: ExtensionWalletProviderId;
  /** Human-readable label */
  label: string;
  /** Returns true if the wallet is available in this browser */
  isAvailable(): Promise<boolean>;
  /** Connect and return the user's public key */
  getPublicKey(): Promise<string>;
  /** Sign an XDR-encoded transaction and return the signed XDR */
  signTransaction(xdr: string, networkPassphrase: string): Promise<string>;
}

// ── Freighter adapter ─────────────────────────────────────────────────────

class FreighterAdapter implements WalletAdapter {
  readonly id = "freighter" as const;
  readonly label = "Freighter";

  async isAvailable(): Promise<boolean> {
    try {
      const result = await isConnected();
      return !result.error && result.isConnected;
    } catch {
      return false;
    }
  }

  async getPublicKey(): Promise<string> {
    const connectionResult = await isConnected();
    if (connectionResult.error || !connectionResult.isConnected) {
      throw new Error("Freighter extension was not detected. Install it to continue.");
    }
    const accessResult = await requestAccess();
    if (accessResult.error) {
      throw new Error(accessResult.error);
    }
    const addressResult = await getAddress();
    if (addressResult.error || !addressResult.address) {
      throw new Error(addressResult.error ?? "Failed to read wallet address.");
    }
    return addressResult.address;
  }

  async signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
    const signed = await freighterSign(xdr, { networkPassphrase });
    const signedXdr = signed?.signedTxXdr;
    if (!signedXdr) throw new Error("Transaction was rejected by Freighter.");
    return signedXdr;
  }
}

// ── xBull adapter ─────────────────────────────────────────────────────────

class XBullAdapter implements WalletAdapter {
  readonly id = "xbull" as const;
  readonly label = "xBull";

  private getInstance(): InstanceType<typeof xBullWalletConnect> {
    return new xBullWalletConnect();
  }

  async isAvailable(): Promise<boolean> {
    // xBull works via postMessage in-page; always available
    return typeof window !== "undefined";
  }

  async getPublicKey(): Promise<string> {
    const wallet = this.getInstance();
    try {
      await wallet.openWallet();
      const result = (await wallet.connect()) as { publicKey: string };
      wallet.closeWallet();
      if (!result?.publicKey) throw new Error("xBull did not return a public key.");
      return result.publicKey;
    } finally {
      wallet.closeConnections();
    }
  }

  async signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
    const wallet = this.getInstance();
    try {
      await wallet.openWallet();
      const result = (await wallet.sign({ xdr, publicKey: undefined, network: networkPassphrase })) as {
        signedXDR: string;
      };
      wallet.closeWallet();
      if (!result?.signedXDR) throw new Error("xBull rejected the transaction.");
      return result.signedXDR;
    } finally {
      wallet.closeConnections();
    }
  }
}

// ── Albedo adapter ────────────────────────────────────────────────────────

class AlbedoAdapter implements WalletAdapter {
  readonly id = "albedo" as const;
  readonly label = "Albedo";

  async isAvailable(): Promise<boolean> {
    return typeof window !== "undefined";
  }

  async getPublicKey(): Promise<string> {
    const result = (await (albedo as AlbedoInstance).publicKey({})) as {
      pubkey: string;
    };
    if (!result?.pubkey) throw new Error("Albedo did not return a public key.");
    return result.pubkey;
  }

  async signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
    const result = (await (albedo as AlbedoInstance).tx({
      xdr,
      network_passphrase: networkPassphrase,
    })) as { signed_envelope_xdr: string };
    if (!result?.signed_envelope_xdr) throw new Error("Albedo rejected the transaction.");
    return result.signed_envelope_xdr;
  }
}

// Albedo's JS is untyped; this minimal interface is enough for our use.
interface AlbedoInstance {
  publicKey(params: Record<string, unknown>): Promise<unknown>;
  tx(params: { xdr: string; network_passphrase: string; pubkey?: string }): Promise<unknown>;
}

// ── Registry ──────────────────────────────────────────────────────────────

const freighterAdapter = new FreighterAdapter();
const xBullAdapter = new XBullAdapter();
const albedoAdapter = new AlbedoAdapter();

/** All extension/browser wallet adapters in display order. */
export const EXTENSION_ADAPTERS: WalletAdapter[] = [
  freighterAdapter,
  xBullAdapter,
  albedoAdapter,
];

/** Look up an adapter by provider ID. Returns undefined if not found. */
export function getAdapter(id: ExtensionWalletProviderId): WalletAdapter | undefined {
  return EXTENSION_ADAPTERS.find((a) => a.id === id);
}
