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

type FreighterConnectionResponse = {
  error?: string;
  isConnected: boolean;
};

type FreighterAddressResponse = {
  error?: string;
  address: string;
};

type FreighterSignedTransactionResponse = {
  error?: string;
  signedTxXdr: string;
};

type XBullConnectResponse = {
  publicKey: string;
};

type XBullSignedTransactionResponse = {
  signedXDR: string;
};

type AlbedoPublicKeyResponse = {
  pubkey: string;
};

type AlbedoSignedTransactionResponse = {
  signed_envelope_xdr: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalError(value: Record<string, unknown>): string | undefined {
  return typeof value.error === "string" && value.error.trim() ? value.error : undefined;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value;
}

export function parseFreighterConnectionResponse(value: unknown): FreighterConnectionResponse {
  if (!isRecord(value)) {
    throw new Error("Freighter returned an unsupported connection response.");
  }

  const error = optionalError(value);
  if (error) {
    return { error, isConnected: false };
  }

  if (typeof value.isConnected !== "boolean") {
    throw new Error("Freighter returned an unsupported connection state.");
  }

  return { isConnected: value.isConnected };
}

export function parseFreighterAddressResponse(value: unknown): FreighterAddressResponse {
  if (!isRecord(value)) {
    throw new Error("Freighter returned an unsupported address response.");
  }

  const error = optionalError(value);
  if (error) {
    return { error, address: "" };
  }

  return {
    address: requireString(value.address, "Freighter did not return a public key."),
  };
}

export function parseFreighterSignedTransactionResponse(value: unknown): FreighterSignedTransactionResponse {
  if (!isRecord(value)) {
    throw new Error("Freighter returned an unsupported signing response.");
  }

  const error = optionalError(value);
  if (error) {
    return { error, signedTxXdr: "" };
  }

  return {
    signedTxXdr: requireString(value.signedTxXdr, "Freighter did not return a signed transaction."),
  };
}

export function parseXBullConnectResponse(value: unknown): XBullConnectResponse {
  if (!isRecord(value)) {
    throw new Error("xBull returned an unsupported connection response.");
  }

  return {
    publicKey: requireString(value.publicKey, "xBull did not return a public key."),
  };
}

export function parseXBullSignedTransactionResponse(value: unknown): XBullSignedTransactionResponse {
  if (!isRecord(value)) {
    throw new Error("xBull returned an unsupported signing response.");
  }

  return {
    signedXDR: requireString(value.signedXDR, "xBull did not return a signed transaction."),
  };
}

export function parseAlbedoPublicKeyResponse(value: unknown): AlbedoPublicKeyResponse {
  if (!isRecord(value)) {
    throw new Error("Albedo returned an unsupported public key response.");
  }

  return {
    pubkey: requireString(value.pubkey, "Albedo did not return a public key."),
  };
}

export function parseAlbedoSignedTransactionResponse(value: unknown): AlbedoSignedTransactionResponse {
  if (!isRecord(value)) {
    throw new Error("Albedo returned an unsupported signing response.");
  }

  return {
    signed_envelope_xdr: requireString(
      value.signed_envelope_xdr,
      "Albedo did not return a signed transaction.",
    ),
  };
}

// ── Freighter adapter ─────────────────────────────────────────────────────

class FreighterAdapter implements WalletAdapter {
  readonly id = "freighter" as const;
  readonly label = "Freighter";

  async isAvailable(): Promise<boolean> {
    try {
      const result = parseFreighterConnectionResponse(await isConnected());
      return !result.error && result.isConnected;
    } catch {
      return false;
    }
  }

  async getPublicKey(): Promise<string> {
    const connectionResult = parseFreighterConnectionResponse(await isConnected());
    if (connectionResult.error || !connectionResult.isConnected) {
      throw new Error(connectionResult.error ?? "Freighter extension was not detected. Install it to continue.");
    }
    const accessResult = await requestAccess();
    if (accessResult.error) {
      throw new Error(accessResult.error);
    }
    const addressResult = parseFreighterAddressResponse(await getAddress());
    if (addressResult.error || !addressResult.address) {
      throw new Error(addressResult.error ?? "Freighter did not return a public key.");
    }
    return addressResult.address;
  }

  async signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
    const signed = parseFreighterSignedTransactionResponse(await freighterSign(xdr, { networkPassphrase }));
    if (signed.error || !signed.signedTxXdr) {
      throw new Error(signed.error ?? "Transaction was rejected by Freighter.");
    }
    return signed.signedTxXdr;
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
      const result = parseXBullConnectResponse(await wallet.connect());
      wallet.closeWallet();
      return result.publicKey;
    } finally {
      wallet.closeConnections();
    }
  }

  async signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
    const wallet = this.getInstance();
    try {
      await wallet.openWallet();
      const result = parseXBullSignedTransactionResponse(
        await wallet.sign({ xdr, publicKey: undefined, network: networkPassphrase }),
      );
      wallet.closeWallet();
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
    const result = parseAlbedoPublicKeyResponse(await (albedo as AlbedoInstance).publicKey({}));
    return result.pubkey;
  }

  async signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
    const result = parseAlbedoSignedTransactionResponse(await (albedo as AlbedoInstance).tx({
      xdr,
      network_passphrase: networkPassphrase,
    }));
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
