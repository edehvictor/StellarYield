/**
 * #1880 — Harden wallet lifecycle against duplicate submissions.
 */
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

import { getAdapter } from "./walletAdapters";
import {
  connectWalletSession,
  createWalletOperationId,
  getConnectOperationKey,
  loadStoredSession,
  recoverSession,
} from "./session";
import type { WalletSession } from "./types";

const STORAGE_KEY = "stellar-yield.wallet-session";
const FINGERPRINT = "f".repeat(64);
const ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const OTHER_ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));

const mockSessionKey = {
  publicKey: () => "GAYY2M7Z5Q4F4V6X2H6ZQZQY2D7TQK5J4R4H7S6C3N4B2M5A7L8C9D0E",
  secret: () => "SBMOCKSESSIONSECRETKEYFORDUPLICATESUBMISSIONTESTS0000000000000",
  sign: (payload: Buffer | Uint8Array) =>
    Buffer.from(`sig:${Buffer.from(payload).toString("utf8").slice(-8)}`, "utf8"),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function challengeFor(walletAddress: string) {
  return `stellar-yield-auth:email:user@example.com:${walletAddress}:${mockSessionKey.publicKey()}:${FINGERPRINT}:2099-01-01T00:00:00.000Z`;
}

const walletAddress = StrKey.encodeContract(Buffer.alloc(32, 7));

function verifyCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith("/api/auth/verify"),
  );
}

describe("wallet lifecycle duplicate submissions (#1880)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    if (globalThis.crypto?.subtle) {
      vi.spyOn(globalThis.crypto.subtle, "digest").mockResolvedValue(
        new Uint8Array(32).fill(7).buffer as ArrayBuffer,
      );
    }
    vi.spyOn(Keypair, "random").mockReturnValue(mockSessionKey as unknown as Keypair);
    vi.spyOn(Keypair, "fromSecret").mockReturnValue(
      mockSessionKey as unknown as Keypair,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("operation identity", () => {
    it("creates unique, server-acceptable operation ids", () => {
      const a = createWalletOperationId();
      const b = createWalletOperationId();
      expect(a).not.toBe(b);
      expect(a).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    });

    it("keys connect operations by provider and normalised identifier", () => {
      expect(getConnectOperationKey({ providerId: "freighter" })).toBe("freighter");
      expect(
        getConnectOperationKey({ providerId: "email", identifier: " User@Example.com " }),
      ).toBe("email:user@example.com");
      expect(getConnectOperationKey()).toBe("freighter");
    });
  });

  describe("normal operation", () => {
    it("sends the operation identity in the body and Idempotency-Key header", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/auth/challenge")) {
          return jsonResponse({ challenge: challengeFor(walletAddress), authConfigFingerprint: FINGERPRINT });
        }
        const body = JSON.parse(String(init?.body)) as { operationId: string };
        return jsonResponse({
          verified: true,
          walletAddressType: "contract",
          acceptedSignerTypes: [],
          authConfigFingerprint: FINGERPRINT,
          operationId: body.operationId,
          replayed: false,
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const session = await connectWalletSession({
        providerId: "email",
        identifier: "user@example.com",
      });

      expect(session.verificationStatus).toBe("verified");
      const [[, init]] = verifyCalls(fetchMock) as [[string, RequestInit]];
      const body = JSON.parse(String(init.body)) as { operationId: string };
      expect(body.operationId).toMatch(/^wallet-verify-/);
      expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
        body.operationId,
      );
    });
  });

  describe("safe retry", () => {
    it("retries a lost verify response with the same operation identity and payload", async () => {
      let verifyAttempts = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/auth/challenge")) {
          return jsonResponse({ challenge: challengeFor(walletAddress), authConfigFingerprint: FINGERPRINT });
        }
        verifyAttempts += 1;
        if (verifyAttempts === 1) {
          // The server applied the verification but the response was lost.
          throw new TypeError("Failed to fetch");
        }
        const body = JSON.parse(String(init?.body)) as { operationId: string };
        return jsonResponse({
          verified: true,
          walletAddressType: "contract",
          acceptedSignerTypes: [],
          authConfigFingerprint: FINGERPRINT,
          operationId: body.operationId,
          replayed: true,
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const session = await connectWalletSession({
        providerId: "email",
        identifier: "user@example.com",
      });

      expect(session.verificationStatus).toBe("verified");
      const calls = verifyCalls(fetchMock) as [string, RequestInit][];
      expect(calls).toHaveLength(2);
      expect(calls[0][1].body).toBe(calls[1][1].body);
      expect(
        fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/api/auth/challenge")),
      ).toHaveLength(1);
    });

    it("retries a 5xx verify response with the same body", async () => {
      let verifyAttempts = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/api/auth/challenge")) {
          return jsonResponse({ challenge: challengeFor(walletAddress), authConfigFingerprint: FINGERPRINT });
        }
        verifyAttempts += 1;
        return verifyAttempts === 1
          ? jsonResponse({ error: "unavailable" }, 503)
          : jsonResponse({ verified: true, walletAddressType: "contract", acceptedSignerTypes: [] });
      });
      vi.stubGlobal("fetch", fetchMock);

      const session = await connectWalletSession({ providerId: "email", identifier: "user@example.com" });
      expect(session.verificationStatus).toBe("verified");
      const calls = verifyCalls(fetchMock) as [string, RequestInit][];
      expect(calls).toHaveLength(2);
      expect(calls[0][1].body).toBe(calls[1][1].body);
    });

    it("does not retry 4xx verify responses", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/api/auth/challenge")) {
          return jsonResponse({ challenge: challengeFor(walletAddress), authConfigFingerprint: FINGERPRINT });
        }
        return jsonResponse({ error: "WALLET_OPERATION_CONFLICT" }, 409);
      });
      vi.stubGlobal("fetch", fetchMock);

      const session = await connectWalletSession({ providerId: "email", identifier: "user@example.com" });
      expect(session.verificationStatus).toBe("degraded");
      expect(verifyCalls(fetchMock)).toHaveLength(1);
    });
  });

  describe("duplicate connect submissions", () => {
    it("shares one in-flight smart-wallet connect between duplicate submissions", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/api/auth/challenge")) {
          return jsonResponse({ challenge: challengeFor(walletAddress), authConfigFingerprint: FINGERPRINT });
        }
        return jsonResponse({ verified: true, walletAddressType: "contract", acceptedSignerTypes: [] });
      });
      vi.stubGlobal("fetch", fetchMock);
      const setItem = vi.spyOn(Storage.prototype, "setItem");

      const opts = { providerId: "email" as const, identifier: "user@example.com" };
      const [a, b, c] = await Promise.all([
        connectWalletSession(opts),
        connectWalletSession({ ...opts, identifier: "  USER@example.com " }),
        connectWalletSession(opts),
      ]);

      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(Keypair.random).toHaveBeenCalledTimes(1);
      expect(verifyCalls(fetchMock)).toHaveLength(1);
      expect(setItem.mock.calls.filter(([k]) => k === STORAGE_KEY)).toHaveLength(1);
    });

    it("prompts an extension wallet once for duplicate submissions", async () => {
      let resolveKey!: (value: string) => void;
      const adapter = {
        isAvailable: vi.fn().mockResolvedValue(true),
        getPublicKey: vi.fn(
          () => new Promise<string>((resolve) => { resolveKey = resolve; }),
        ),
      };
      vi.mocked(getAdapter).mockReturnValue(adapter as never);

      const first = connectWalletSession({ providerId: "freighter" });
      const second = connectWalletSession({ providerId: "freighter" });
      await vi.waitFor(() => expect(adapter.getPublicKey).toHaveBeenCalled());
      resolveKey(ACCOUNT);

      expect(await first).toBe(await second);
      expect(adapter.getPublicKey).toHaveBeenCalledTimes(1);
    });

    it("starts a fresh attempt once the previous one has settled", async () => {
      const adapter = {
        isAvailable: vi.fn().mockResolvedValue(true),
        getPublicKey: vi.fn().mockResolvedValue(ACCOUNT),
      };
      vi.mocked(getAdapter).mockReturnValue(adapter as never);

      await connectWalletSession({ providerId: "freighter" });
      await connectWalletSession({ providerId: "freighter" });
      expect(adapter.getPublicKey).toHaveBeenCalledTimes(2);
    });
  });

  describe("failure preserves existing state", () => {
    const existing: WalletSession = {
      walletAddress: ACCOUNT,
      walletAddressType: "account",
      providerId: "freighter",
      providerLabel: "Freighter",
      verificationStatus: "verified",
      connectedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };

    it("keeps the persisted session when a duplicate-submitted connect fails, and allows retry", async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
      const adapter = {
        isAvailable: vi.fn().mockResolvedValue(true),
        getPublicKey: vi
          .fn()
          .mockRejectedValueOnce(new Error("User declined"))
          .mockResolvedValueOnce(OTHER_ACCOUNT),
      };
      vi.mocked(getAdapter).mockReturnValue(adapter as never);

      const results = await Promise.allSettled([
        connectWalletSession({ providerId: "freighter" }),
        connectWalletSession({ providerId: "freighter" }),
      ]);
      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      expect(adapter.getPublicKey).toHaveBeenCalledTimes(1);
      expect(loadStoredSession()).toEqual(existing);

      const retried = await connectWalletSession({ providerId: "freighter" });
      expect(retried.walletAddress).toBe(OTHER_ACCOUNT);
      expect(loadStoredSession()?.walletAddress).toBe(retried.walletAddress);
    });

    it("shares one in-flight recovery between duplicate recover calls", async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
      const adapter = { isAvailable: vi.fn().mockResolvedValue(true) };
      vi.mocked(getAdapter).mockReturnValue(adapter as never);

      const [a, b] = await Promise.all([recoverSession(), recoverSession()]);
      expect(a).toBe(b);
      expect(a.status).toBe("recovered");
      expect(adapter.isAvailable).toHaveBeenCalledTimes(1);
    });
  });
});
