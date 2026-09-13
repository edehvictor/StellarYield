/**
 * Tests for wallet session persistence, clear, crash recovery,
 * cross-tab StorageEvent handling, expiry, staleness, and BroadcastChannel.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

import {
  loadStoredSession,
  clearStoredSession,
  isSessionExpired,
  isSessionStale,
  onSessionEvent,
  broadcastSessionEvent,
  SESSION_TTL_MS,
  STALE_THRESHOLD_MS,
} from "./session";
import type { WalletSession } from "./types";

const STORAGE_KEY = "stellar-yield.wallet-session";

function makeSession(overrides: Partial<WalletSession> = {}): WalletSession {
  return {
    walletAddress: "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    walletAddressType: "account",
    providerId: "freighter",
    providerLabel: "Freighter",
    verificationStatus: "verified",
    connectedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("loadStoredSession", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when localStorage has no session", () => {
    expect(loadStoredSession()).toBeNull();
  });

  it("returns the stored session when valid JSON is present", () => {
    const session = makeSession();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

    const loaded = loadStoredSession();
    expect(loaded).not.toBeNull();
    expect(loaded!.walletAddress).toBe(session.walletAddress);
    expect(loaded!.providerId).toBe("freighter");
    expect(loaded!.verificationStatus).toBe("verified");
  });

  it("preserves all optional fields (sessionKeyAddress, loginHint)", () => {
    const session = makeSession({
      providerId: "email",
      providerLabel: "Email Smart Wallet",
      walletAddressType: "contract",
      sessionKeyAddress: "GBSESSION_KEY_ADDRESS",
      sessionSecret: "SECRET",
      loginHint: "user@example.com",
      verificationStatus: "degraded",
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

    const loaded = loadStoredSession();
    expect(loaded!.sessionKeyAddress).toBe("GBSESSION_KEY_ADDRESS");
    expect(loaded!.loginHint).toBe("user@example.com");
    expect(loaded!.verificationStatus).toBe("degraded");
  });

  it("preserves new permission and origin fields", () => {
    const session = makeSession({
      permissions: ["read", "sign", "trade"],
      origin: { tabId: "abc-123", origin: "https://stellar.yield" },
      lastVerifiedAt: new Date().toISOString(),
      providerAvailable: true,
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

    const loaded = loadStoredSession();
    expect(loaded!.permissions).toEqual(["read", "sign", "trade"]);
    expect(loaded!.origin?.tabId).toBe("abc-123");
    expect(loaded!.providerAvailable).toBe(true);
  });

  it("returns null and removes the corrupt entry when JSON is invalid", () => {
    localStorage.setItem(STORAGE_KEY, "{{not-valid-json}}");

    const loaded = loadStoredSession();
    expect(loaded).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("is idempotent", () => {
    const session = makeSession();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

    const first = loadStoredSession();
    const second = loadStoredSession();
    expect(first!.walletAddress).toBe(second!.walletAddress);
  });
});

describe("clearStoredSession", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("removes the session from localStorage", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSession()));
    clearStoredSession();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("is a no-op when no session is stored", () => {
    expect(() => clearStoredSession()).not.toThrow();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("causes loadStoredSession to return null after clearing", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSession()));
    clearStoredSession();
    expect(loadStoredSession()).toBeNull();
  });
});

describe("loadStoredSession — crash recovery", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("handles an empty string stored for the key", () => {
    localStorage.setItem(STORAGE_KEY, "");
    const loaded = loadStoredSession();
    expect(loaded).toBeNull();
  });

  it("handles 'null' literal stored as a string", () => {
    localStorage.setItem(STORAGE_KEY, "null");
    const loaded = loadStoredSession();
    expect(loaded).toBeNull();
  });

  it("handles a number stored as a string (wrong type)", () => {
    localStorage.setItem(STORAGE_KEY, "42");
    expect(() => loadStoredSession()).not.toThrow();
  });
});

describe("cross-tab StorageEvent", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loadStoredSession reflects a session written by another tab", () => {
    const session = makeSession({ walletAddress: "GCROSS_TAB_ADDRESS" });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

    const loaded = loadStoredSession();
    expect(loaded!.walletAddress).toBe("GCROSS_TAB_ADDRESS");
  });

  it("loadStoredSession returns null after another tab clears the session", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSession()));
    localStorage.removeItem(STORAGE_KEY);

    expect(loadStoredSession()).toBeNull();
  });

  it("StorageEvent carries the new session value in event.newValue", () => {
    const session = makeSession({ walletAddress: "GEVENT_ADDR" });
    const eventNewValue = JSON.stringify(session);

    const event = new StorageEvent("storage", {
      key: STORAGE_KEY,
      newValue: eventNewValue,
      oldValue: null,
    });

    const parsed: WalletSession | null = event.newValue
      ? (JSON.parse(event.newValue) as WalletSession)
      : null;

    expect(parsed).not.toBeNull();
    expect(parsed!.walletAddress).toBe("GEVENT_ADDR");
  });

  it("StorageEvent for a different key should not affect session state", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSession()));

    const event = new StorageEvent("storage", {
      key: "some-other-key",
      newValue: "irrelevant",
    });

    const isSessionKey = event.key === STORAGE_KEY;
    expect(isSessionKey).toBe(false);
    expect(loadStoredSession()).not.toBeNull();
  });
});

describe("isSessionExpired", () => {
  it("returns false for a fresh session", () => {
    const session = makeSession({ connectedAt: new Date().toISOString() });
    expect(isSessionExpired(session)).toBe(false);
  });

  it("returns true when session is older than SESSION_TTL_MS", () => {
    const session = makeSession({
      connectedAt: new Date(Date.now() - SESSION_TTL_MS - 1000).toISOString(),
    });
    expect(isSessionExpired(session)).toBe(true);
  });

  it("returns false when connectedAt is missing", () => {
    const session = makeSession({ connectedAt: undefined });
    expect(isSessionExpired(session)).toBe(false);
  });
});

describe("isSessionStale", () => {
  it("returns false for a recently active session", () => {
    const session = makeSession({ lastActivityAt: new Date().toISOString() });
    expect(isSessionStale(session)).toBe(false);
  });

  it("returns true when idle longer than STALE_THRESHOLD_MS", () => {
    const session = makeSession({
      lastActivityAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000).toISOString(),
    });
    expect(isSessionStale(session)).toBe(true);
  });

  it("returns true when lastActivityAt is missing", () => {
    const session = makeSession({ lastActivityAt: undefined });
    expect(isSessionStale(session)).toBe(true);
  });
});

describe("BroadcastChannel cross-tab events", () => {
  it("broadcastSessionEvent does not throw when BroadcastChannel is available", () => {
    expect(() => broadcastSessionEvent({ type: "disconnect", payload: null })).not.toThrow();
  });

  it("onSessionEvent returns a function", () => {
    const unsub = onSessionEvent(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("onSessionEvent returns no-op when BroadcastChannel unavailable", () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error testing unavailable channel
    globalThis.BroadcastChannel = undefined;

    try {
      const unsub = onSessionEvent(() => {});
      expect(typeof unsub).toBe("function");
      unsub();
    } finally {
      globalThis.BroadcastChannel = original;
    }
  });

  it("broadcastSessionEvent handles different event types", () => {
    expect(() => broadcastSessionEvent({ type: "disconnect", payload: null })).not.toThrow();
    expect(() => broadcastSessionEvent({ type: "account-change", payload: makeSession() })).not.toThrow();
    expect(() => broadcastSessionEvent({ type: "session-update", payload: makeSession() })).not.toThrow();
  });
});
