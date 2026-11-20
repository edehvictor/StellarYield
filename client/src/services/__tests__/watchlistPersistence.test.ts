import { describe, it, expect } from "vitest";
import type { WatchlistItem } from "../../../../shared/types/watchlist";
import {
  WATCHLIST_STORAGE_VERSION,
  loadWalletWatchlistBundle,
  saveWalletWatchlistBundle,
  clearWalletWatchlistBundle,
  walletWatchlistStorageKey,
  type PersistedWalletWatchlistBundle,
} from "../watchlistPersistence";

function mockStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    getItem(key: string) {
      return store[key] ?? null;
    },
    setItem(key: string, value: string) {
      store[key] = value;
    },
    removeItem(key: string) {
      delete store[key];
    },
    snapshot() {
      return { ...store };
    },
  };
}

const ITEM_A: WatchlistItem = {
  id: "item-1",
  userId: "wallet-a",
  opportunityId: "opp-1",
  opportunityType: "vault",
  opportunityName: "Blend USDC",
  currentApy: 6.5,
  currentTvl: 12_000_000,
  ruleCount: 1,
  alertCount: 0,
} as unknown as WatchlistItem;

describe("per-wallet persistence (reconnect)", () => {
  it("isolates snapshots by wallet address", () => {
    const storage = mockStorage();
    const w1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const w2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    const b1: PersistedWalletWatchlistBundle = {
      version: WATCHLIST_STORAGE_VERSION,
      items: [ITEM_A],
      lastSyncedAt: 111,
    };
    saveWalletWatchlistBundle(w1, b1, storage);

    const loadedW1 = loadWalletWatchlistBundle(w1, storage);
    expect(loadedW1.items).toHaveLength(1);
    expect(loadedW1.items[0].id).toBe("item-1");

    const loadedW2 = loadWalletWatchlistBundle(w2, storage);
    expect(loadedW2.items).toHaveLength(0);

    expect(storage.snapshot()[walletWatchlistStorageKey(w1)]).toBeDefined();
    expect(storage.snapshot()[walletWatchlistStorageKey(w2)]).toBeUndefined();
  });

  it("does not leak wallet A's items into wallet B's freshly loaded bundle", () => {
    const storage = mockStorage();
    const walletA = "GWALLETA0000000000000000000000000000000000000000000001";
    const walletB = "GWALLETB0000000000000000000000000000000000000000000002";

    saveWalletWatchlistBundle(
      walletA,
      { version: WATCHLIST_STORAGE_VERSION, items: [ITEM_A], lastSyncedAt: Date.now() },
      storage
    );

    const loadedB = loadWalletWatchlistBundle(walletB, storage);
    expect(loadedB.items).toEqual([]);
    expect(loadedB.lastSyncedAt).toBeNull();
  });
});

describe("save and load watchlist snapshot", () => {
  it("saves and loads a snapshot correctly", () => {
    const storage = mockStorage();
    const wallet = "GDSAVETEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";

    const bundle: PersistedWalletWatchlistBundle = {
      version: WATCHLIST_STORAGE_VERSION,
      items: [ITEM_A],
      lastSyncedAt: 1234567890,
    };

    saveWalletWatchlistBundle(wallet, bundle, storage);
    const loaded = loadWalletWatchlistBundle(wallet, storage);

    expect(loaded.version).toBe(WATCHLIST_STORAGE_VERSION);
    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0].opportunityName).toBe("Blend USDC");
    expect(loaded.lastSyncedAt).toBe(1234567890);
  });

  it("loads an empty bundle when nothing saved exists", () => {
    const storage = mockStorage();
    const wallet = "GDFRESHTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123";

    const loaded = loadWalletWatchlistBundle(wallet, storage);

    expect(loaded.version).toBe(WATCHLIST_STORAGE_VERSION);
    expect(loaded.items).toHaveLength(0);
    expect(loaded.lastSyncedAt).toBeNull();
  });
});

describe("malformed localStorage data handling", () => {
  it("handles corrupted JSON gracefully", () => {
    const storage = mockStorage();
    const wallet = "GDCORRUPTTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXY";
    const key = walletWatchlistStorageKey(wallet);

    storage.setItem(key, "{invalid json here");

    const loaded = loadWalletWatchlistBundle(wallet, storage);

    expect(loaded.version).toBe(WATCHLIST_STORAGE_VERSION);
    expect(loaded.items).toHaveLength(0);
  });

  it("handles missing version field", () => {
    const storage = mockStorage();
    const wallet = "GDNOVERSIONTEST1234567890ABCDEFGHIJKLMNOPQRSTUVW";
    const key = walletWatchlistStorageKey(wallet);

    storage.setItem(key, JSON.stringify({ items: [ITEM_A], lastSyncedAt: 1000 }));

    const loaded = loadWalletWatchlistBundle(wallet, storage);
    expect(loaded.version).toBe(WATCHLIST_STORAGE_VERSION);
    expect(loaded.items).toHaveLength(0);
  });

  it("handles wrong version number", () => {
    const storage = mockStorage();
    const wallet = "GDWRONGVERSIONTEST1234567890ABCDEFGHIJKLMNOPQRST";
    const key = walletWatchlistStorageKey(wallet);

    storage.setItem(
      key,
      JSON.stringify({ version: 999, items: [ITEM_A], lastSyncedAt: 1000 })
    );

    const loaded = loadWalletWatchlistBundle(wallet, storage);
    expect(loaded.version).toBe(WATCHLIST_STORAGE_VERSION);
    expect(loaded.items).toHaveLength(0);
  });

  it("handles non-array items field", () => {
    const storage = mockStorage();
    const wallet = "GDNONARRAYTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWX";
    const key = walletWatchlistStorageKey(wallet);

    storage.setItem(
      key,
      JSON.stringify({ version: WATCHLIST_STORAGE_VERSION, items: "not an array", lastSyncedAt: 1000 })
    );

    const loaded = loadWalletWatchlistBundle(wallet, storage);
    expect(Array.isArray(loaded.items)).toBe(true);
    expect(loaded.items).toHaveLength(0);
  });

  it("handles null storage value", () => {
    const storage = mockStorage();
    const wallet = "GDNULLTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123";

    const loaded = loadWalletWatchlistBundle(wallet, storage);
    expect(loaded.version).toBe(WATCHLIST_STORAGE_VERSION);
    expect(loaded.items).toHaveLength(0);
  });

  it("handles empty string storage value", () => {
    const storage = mockStorage();
    const wallet = "GDEMPTYTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12";
    const key = walletWatchlistStorageKey(wallet);

    storage.setItem(key, "");

    const loaded = loadWalletWatchlistBundle(wallet, storage);
    expect(loaded.version).toBe(WATCHLIST_STORAGE_VERSION);
    expect(loaded.items).toHaveLength(0);
  });

  it("silently handles storage quota exceeded errors", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };

    const wallet = "GDQUOTATEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1";
    const bundle: PersistedWalletWatchlistBundle = {
      version: WATCHLIST_STORAGE_VERSION,
      items: [ITEM_A],
      lastSyncedAt: 1000,
    };

    expect(() => saveWalletWatchlistBundle(wallet, bundle, storage)).not.toThrow();
  });

  it("handles storage in private browsing mode", () => {
    const storage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };

    const wallet = "GDPRIVATETEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXY";

    expect(() => loadWalletWatchlistBundle(wallet, storage)).not.toThrow();
    expect(() =>
      saveWalletWatchlistBundle(
        wallet,
        { version: WATCHLIST_STORAGE_VERSION, items: [], lastSyncedAt: null },
        storage
      )
    ).not.toThrow();
    expect(() => clearWalletWatchlistBundle(wallet, storage)).not.toThrow();
  });
});

describe("reset behavior", () => {
  it("clears wallet data via clearWalletWatchlistBundle", () => {
    const storage = mockStorage();
    const wallet = "GDRESETTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1";
    const key = walletWatchlistStorageKey(wallet);

    saveWalletWatchlistBundle(
      wallet,
      { version: WATCHLIST_STORAGE_VERSION, items: [ITEM_A], lastSyncedAt: 1000 },
      storage
    );
    expect(storage.getItem(key)).toBeTruthy();

    clearWalletWatchlistBundle(wallet, storage);
    expect(storage.getItem(key)).toBeNull();

    const loaded = loadWalletWatchlistBundle(wallet, storage);
    expect(loaded.items).toHaveLength(0);
    expect(loaded.lastSyncedAt).toBeNull();
  });

  it("resets one wallet without affecting another", () => {
    const storage = mockStorage();
    const wallet1 = "GDRESET1TEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const wallet2 = "GDRESET2TEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    saveWalletWatchlistBundle(
      wallet1,
      { version: WATCHLIST_STORAGE_VERSION, items: [ITEM_A], lastSyncedAt: 1000 },
      storage
    );
    saveWalletWatchlistBundle(
      wallet2,
      { version: WATCHLIST_STORAGE_VERSION, items: [ITEM_A], lastSyncedAt: 2000 },
      storage
    );

    clearWalletWatchlistBundle(wallet1, storage);

    expect(loadWalletWatchlistBundle(wallet1, storage).items).toHaveLength(0);
    expect(loadWalletWatchlistBundle(wallet2, storage).items).toHaveLength(1);
  });
});

describe("deterministic and isolated tests", () => {
  it("isolates storage operations between test runs", () => {
    const storage1 = mockStorage();
    const storage2 = mockStorage();
    const wallet = "GDISOLATETEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXY";

    saveWalletWatchlistBundle(
      wallet,
      { version: WATCHLIST_STORAGE_VERSION, items: [ITEM_A], lastSyncedAt: 1000 },
      storage1
    );

    const loaded1 = loadWalletWatchlistBundle(wallet, storage1);
    const loaded2 = loadWalletWatchlistBundle(wallet, storage2);

    expect(loaded1.lastSyncedAt).toBe(1000);
    expect(loaded2.lastSyncedAt).toBeNull();
  });
});
