import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

vi.mock("@albedo-link/intent", () => ({ default: {} }));
vi.mock("@stellar/freighter-api", () => ({
  getAddress: vi.fn(),
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
}));
vi.mock("@creit.tech/xbull-wallet-connect", () => ({
  xBullWalletConnect: vi.fn(),
}));
vi.mock("./walletAdapters", () => ({
  getAdapter: vi.fn(),
  EXTENSION_ADAPTERS: [],
}));

import {
  connectWalletSession,
  recoverSession,
  loadStoredSession,
} from "./session";
import type { WalletSession } from "./types";

const STORAGE_KEY = "stellar-yield.wallet-session";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFingerprint(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

const mockSessionKey = {
  publicKey: () =>
    "GAYY2M7Z5Q4F4V6X2H6ZQZQY2D7TQK5J4R4H7S6C3N4B2M5A7L8C9D0E",
  secret: () =>
    "SBMOCKSESSIONSECRETKEYFORWALLETSTALECONFIGTESTS000000000000000",
  sign: (payload: Buffer | Uint8Array) =>
    Buffer.from(`sig:${Buffer.from(payload).toString("utf8").slice(-8)}`, "utf8"),
};

const mockStoredKey = {
  publicKey: () =>
    "GBZZ2M7Z5Q4F4V6X2H6ZQZQY2D7TQK5J4R4H7S6C3N4B2M5A7L8C9D0F",
  secret: () =>
    "SBMOCKSTOREDSESSIONSECRETKEYFORWALLETSTALECONFIGTEST000000000",
  sign: (payload: Buffer | Uint8Array) =>
    Buffer.from(`sig:${Buffer.from(payload).toString("utf8").slice(-8)}`, "utf8"),
};

describe("wallet lifecycle stale auth configuration snapshots (#1878)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();

    if (globalThis.crypto?.subtle) {
      vi.spyOn(globalThis.crypto.subtle, "digest").mockResolvedValue(
        new Uint8Array(32).fill(7).buffer as ArrayBuffer,
      );
    }

    vi.spyOn(Keypair, "random").mockReturnValue(mockSessionKey as unknown as Keypair);
    vi.spyOn(Keypair, "fromSecret").mockImplementation((secret: string) => {
      if (secret === mockSessionKey.secret()) {
        return mockSessionKey as unknown as Keypair;
      }
      if (secret === mockStoredKey.secret()) {
        return mockStoredKey as unknown as Keypair;
      }
      return {
        publicKey: () => "GUNKNOWNPUBLICKEYFORTESTS000000000000000000000000000000000",
        secret: () => secret,
        sign: (payload: Buffer | Uint8Array) =>
          Buffer.from(`sig:${Buffer.from(payload).toString("utf8").slice(-8)}`, "utf8"),
      } as unknown as Keypair;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stores the immutable auth config fingerprint on successful smart-wallet connection", async () => {
    const fingerprint = makeFingerprint("a");
    const walletAddress = StrKey.encodeContract(Buffer.alloc(32, 7));
    const challenge = `stellar-yield-auth:email:user@example.com:${walletAddress}:${mockSessionKey.publicKey()}:${fingerprint}:2099-01-01T00:00:00.000Z`;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/auth/challenge")) {
        return jsonResponse({
          challenge,
          walletAddressType: "contract",
          acceptedSignerTypes: ["session-key", "contract-wallet"],
          authConfigFingerprint: fingerprint,
        });
      }
      if (url.endsWith("/api/auth/verify")) {
        return jsonResponse({
          verified: true,
          walletAddressType: "contract",
          acceptedSignerTypes: ["session-key", "contract-wallet"],
          authConfigFingerprint: fingerprint,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await connectWalletSession({
      providerId: "email",
      identifier: "user@example.com",
    });

    expect(session.verificationStatus).toBe("verified");
    expect(session.authConfigFingerprint).toBe(fingerprint);
    expect(loadStoredSession()?.authConfigFingerprint).toBe(fingerprint);
  });

  it("refreshes and retries once when verification rejects a stale config snapshot", async () => {
    const staleFingerprint = makeFingerprint("b");
    const freshFingerprint = makeFingerprint("c");
    const walletAddress = StrKey.encodeContract(Buffer.alloc(32, 7));
    const staleChallenge = `stellar-yield-auth:email:user@example.com:${walletAddress}:${mockSessionKey.publicKey()}:${staleFingerprint}:2099-01-01T00:00:00.000Z`;
    const freshChallenge = `stellar-yield-auth:email:user@example.com:${walletAddress}:${mockSessionKey.publicKey()}:${freshFingerprint}:2099-01-01T00:00:00.000Z`;

    let challengeCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/challenge")) {
        challengeCalls += 1;
        const active = challengeCalls === 1 ? staleChallenge : freshChallenge;
        const activeFingerprint =
          challengeCalls === 1 ? staleFingerprint : freshFingerprint;
        return jsonResponse({
          challenge: active,
          walletAddressType: "contract",
          acceptedSignerTypes: ["session-key", "contract-wallet"],
          authConfigFingerprint: activeFingerprint,
        });
      }
      if (url.endsWith("/api/auth/verify")) {
        const body = JSON.parse(String(init?.body)) as { challenge: string };
        if (body.challenge === staleChallenge) {
          return jsonResponse(
            {
              error: "Wallet authentication configuration snapshot is stale.",
              code: "STALE_WALLET_AUTH_CONFIG",
              currentAuthConfigFingerprint: freshFingerprint,
            },
            409,
          );
        }
        return jsonResponse({
          verified: true,
          walletAddressType: "contract",
          acceptedSignerTypes: ["session-key", "contract-wallet"],
          authConfigFingerprint: freshFingerprint,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await connectWalletSession({
      providerId: "email",
      identifier: "user@example.com",
    });

    expect(session.verificationStatus).toBe("verified");
    expect(session.authConfigFingerprint).toBe(freshFingerprint);
    expect(
      fetchMock.mock.calls.filter(([arg]) =>
        String(arg).endsWith("/api/auth/challenge"),
      ),
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([arg]) =>
        String(arg).endsWith("/api/auth/verify"),
      ),
    ).toHaveLength(2);
    expect(loadStoredSession()?.authConfigFingerprint).toBe(freshFingerprint);
  });

  it("preserves recovered smart-wallet session as degraded when stale config cannot be refreshed", async () => {
    const staleFingerprint = makeFingerprint("d");
    const walletAddress = StrKey.encodeContract(Buffer.alloc(32, 7));
    const stored: WalletSession = {
      walletAddress,
      walletAddressType: "contract",
      providerId: "email",
      providerLabel: "Email Smart Wallet",
      sessionKeyAddress: mockStoredKey.publicKey(),
      sessionSecret: mockStoredKey.secret(),
      loginHint: "user@example.com",
      verificationStatus: "verified",
      connectedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      authConfigFingerprint: staleFingerprint,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const staleChallenge = `stellar-yield-auth:email:user@example.com:${walletAddress}:${mockStoredKey.publicKey()}:${staleFingerprint}:2099-01-01T00:00:00.000Z`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/auth/challenge")) {
        return jsonResponse({
          challenge: staleChallenge,
          walletAddressType: "contract",
          acceptedSignerTypes: ["session-key", "contract-wallet"],
          authConfigFingerprint: staleFingerprint,
        });
      }
      if (url.endsWith("/api/auth/verify")) {
        return jsonResponse(
          {
            error: "Wallet authentication configuration snapshot is stale.",
            code: "STALE_WALLET_AUTH_CONFIG",
            currentAuthConfigFingerprint: makeFingerprint("e"),
          },
          409,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await recoverSession();

    expect(result.status).toBe("degraded");
    expect(result.session?.walletAddress).toBe(walletAddress);
    expect(result.session?.verificationStatus).toBe("degraded");
    expect(result.session?.sessionSecret).toBe(mockStoredKey.secret());
    expect(loadStoredSession()?.walletAddress).toBe(walletAddress);
    expect(loadStoredSession()?.verificationStatus).toBe("degraded");
  });
});