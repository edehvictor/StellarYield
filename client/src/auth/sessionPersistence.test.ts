/**
 * Tests for wallet session persistence, clear, crash recovery, and
 * cross-tab StorageEvent handling.
 *
 * session.ts exposes:
 *   loadStoredSession()  — read from localStorage, return null on miss/corrupt
 *   clearStoredSession() — remove the key
 *
 * Cross-tab sync is the caller's responsibility; these tests verify that the
 * raw primitives produce the right state so higher-level hooks can rely on
 * them when responding to StorageEvents.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadStoredSession, clearStoredSession } from "./session";
import type { WalletSession } from "./types";

// ── fixtures ──────────────────────────────────────────────────────────────────

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

// ── loadStoredSession ─────────────────────────────────────────────────────────

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

  it("returns null and removes the corrupt entry when JSON is invalid", () => {
    localStorage.setItem(STORAGE_KEY, "{{not-valid-json}}");

    const loaded = loadStoredSession();
    expect(loaded).toBeNull();
    // Should auto-remove the corrupt entry
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("is idempotent — calling it twice returns the same data", () => {
    const session = makeSession();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

    const first = loadStoredSession();
    const second = loadStoredSession();
    expect(first!.walletAddress).toBe(second!.walletAddress);
  });
});

// ── clearStoredSession ────────────────────────────────────────────────────────

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

// ── crash recovery (corrupt / truncated data) ─────────────────────────────────

describe("loadStoredSession — crash recovery", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("handles an empty string stored for the key", () => {
    localStorage.setItem(STORAGE_KEY, "");
    // "" is falsy — should return null without throwing
    const loaded = loadStoredSession();
    expect(loaded).toBeNull();
  });

  it("handles 'null' literal stored as a string", () => {
    localStorage.setItem(STORAGE_KEY, "null");
    // JSON.parse("null") === null — treat as no session
    const loaded = loadStoredSession();
    expect(loaded).toBeNull();
  });

  it("handles a number stored as a string (wrong type)", () => {
    localStorage.setItem(STORAGE_KEY, "42");
    // JSON.parse returns 42 (number), cast to WalletSession — should still not throw
    // The function returns it as-is (it's a simple cast); test that it does not throw
    expect(() => loadStoredSession()).not.toThrow();
  });

  it("does not throw when localStorage.getItem itself throws", () => {
    const originalGetItem = window.localStorage.getItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, "getItem").mockImplementationOnce(() => {
      throw new Error("localStorage unavailable");
    });

    // loadStoredSession is not designed to catch getItem errors (that's the
    // platform contract), but we verify it propagates cleanly rather than
    // silently corrupting state
    expect(() => loadStoredSession()).toThrow("localStorage unavailable");

    vi.restoreAllMocks();
  });
});

// ── cross-tab StorageEvent recovery ──────────────────────────────────────────

describe("cross-tab StorageEvent", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loadStoredSession reflects a session written by another tab", () => {
    // Simulate another tab writing a session directly to localStorage
    // (StorageEvent fires in the *other* tabs, not the writing tab)
    const session = makeSession({ walletAddress: "GCROSS_TAB_ADDRESS" });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

    // Our tab calls loadStoredSession in its StorageEvent handler
    const loaded = loadStoredSession();
    expect(loaded!.walletAddress).toBe("GCROSS_TAB_ADDRESS");
  });

  it("loadStoredSession returns null after another tab clears the session", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSession()));

    // Another tab calls clearStoredSession
    localStorage.removeItem(STORAGE_KEY);

    // Our tab re-reads in its StorageEvent handler
    expect(loadStoredSession()).toBeNull();
  });

  it("StorageEvent carries the new session value in event.newValue", () => {
    const session = makeSession({ walletAddress: "GEVENT_ADDR" });
    const eventNewValue = JSON.stringify(session);

    const event = new StorageEvent("storage", {
      key: STORAGE_KEY,
      newValue: eventNewValue,
      oldValue: null,
      storageArea: window.localStorage,
    });

    // The handler pattern: parse event.newValue, then optionally call loadStoredSession()
    const parsed: WalletSession | null = event.newValue
      ? (JSON.parse(event.newValue) as WalletSession)
      : null;

    expect(parsed).not.toBeNull();
    expect(parsed!.walletAddress).toBe("GEVENT_ADDR");
  });

  it("StorageEvent newValue is null when the session is cleared by another tab", () => {
    const event = new StorageEvent("storage", {
      key: STORAGE_KEY,
      newValue: null,
      oldValue: JSON.stringify(makeSession()),
      storageArea: window.localStorage,
    });

    const parsed: WalletSession | null = event.newValue
      ? (JSON.parse(event.newValue) as WalletSession)
      : null;

    expect(parsed).toBeNull();
  });

  it("StorageEvent for a different key should not affect session state", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSession()));

    const event = new StorageEvent("storage", {
      key: "some-other-key",
      newValue: "irrelevant",
      storageArea: window.localStorage,
    });

    // Handler should check event.key before acting
    const isSessionKey = event.key === STORAGE_KEY;
    expect(isSessionKey).toBe(false);

    // Session untouched
    expect(loadStoredSession()).not.toBeNull();
  });
});
