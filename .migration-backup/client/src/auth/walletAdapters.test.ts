import { describe, expect, it, vi } from "vitest";

vi.mock("@stellar/freighter-api", () => ({
  getAddress: vi.fn(),
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock("@creit.tech/xbull-wallet-connect", () => ({
  xBullWalletConnect: vi.fn(),
}));

vi.mock("@albedo-link/intent", () => ({
  default: {
    publicKey: vi.fn(),
    tx: vi.fn(),
  },
}));
import {
  parseAlbedoPublicKeyResponse,
  parseAlbedoSignedTransactionResponse,
  parseFreighterAddressResponse,
  parseFreighterConnectionResponse,
  parseFreighterSignedTransactionResponse,
  parseXBullConnectResponse,
  parseXBullSignedTransactionResponse,
} from "./walletAdapters";

describe("wallet adapter response parsers", () => {
  it("parses valid Freighter responses", () => {
    expect(parseFreighterConnectionResponse({ isConnected: true })).toEqual({
      isConnected: true,
    });
    expect(parseFreighterAddressResponse({ address: "GABC" })).toEqual({
      address: "GABC",
    });
    expect(parseFreighterSignedTransactionResponse({ signedTxXdr: "signed" })).toEqual({
      signedTxXdr: "signed",
    });
  });

  it("preserves Freighter user-facing errors", () => {
    expect(parseFreighterConnectionResponse({ error: "User rejected access" })).toEqual({
      error: "User rejected access",
      isConnected: false,
    });
    expect(parseFreighterAddressResponse({ error: "Missing address" })).toEqual({
      error: "Missing address",
      address: "",
    });
    expect(parseFreighterSignedTransactionResponse({ error: "Rejected" })).toEqual({
      error: "Rejected",
      signedTxXdr: "",
    });
  });

  it("rejects malformed Freighter responses", () => {
    expect(() => parseFreighterConnectionResponse({ isConnected: "yes" })).toThrow(
      "unsupported connection state",
    );
    expect(() => parseFreighterAddressResponse({ address: "" })).toThrow(
      "did not return a public key",
    );
    expect(() => parseFreighterSignedTransactionResponse({ signedTxXdr: 1 })).toThrow(
      "did not return a signed transaction",
    );
  });

  it("parses valid xBull responses", () => {
    expect(parseXBullConnectResponse({ publicKey: "GXBULL" })).toEqual({
      publicKey: "GXBULL",
    });
    expect(parseXBullSignedTransactionResponse({ signedXDR: "signed" })).toEqual({
      signedXDR: "signed",
    });
  });

  it("rejects malformed xBull responses", () => {
    expect(() => parseXBullConnectResponse({ publicKey: "" })).toThrow(
      "did not return a public key",
    );
    expect(() => parseXBullSignedTransactionResponse({ signedXDR: null })).toThrow(
      "did not return a signed transaction",
    );
  });

  it("parses valid Albedo responses", () => {
    expect(parseAlbedoPublicKeyResponse({ pubkey: "GALBEDO" })).toEqual({
      pubkey: "GALBEDO",
    });
    expect(parseAlbedoSignedTransactionResponse({ signed_envelope_xdr: "signed" })).toEqual({
      signed_envelope_xdr: "signed",
    });
  });

  it("rejects malformed Albedo responses", () => {
    expect(() => parseAlbedoPublicKeyResponse({ pubkey: undefined })).toThrow(
      "did not return a public key",
    );
    expect(() => parseAlbedoSignedTransactionResponse({ signed_envelope_xdr: "" })).toThrow(
      "did not return a signed transaction",
    );
  });
});
