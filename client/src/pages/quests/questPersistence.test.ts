import { describe, it, expect } from "vitest";
import type { Quest } from "./types";
import {
  QUEST_STORAGE_VERSION,
  DEFAULT_CACHE_TTL_MS,
  MIGRATION_FIXTURES,
  applySimulatedIndexerProgress,
  cloneQuests,
  isCacheStale,
  invalidateWalletQuestCache,
  loadWalletQuestBundle,
  mergeQuestsWithTemplate,
  migrateQuestBundle,
  sanitizeAchievement,
  sanitizeQuest,
  sanitizeQuestObjective,
  saveWalletQuestBundle,
  walletQuestStorageKey,
  type PersistedWalletQuestBundle,
} from "./questPersistence";

const TEMPLATE: Quest[] = [
  {
    id: "qNew",
    title: "New Quest From Template",
    description: "Added after user saved progress.",
    points: 10,
    status: "locked",
    badgeContractId: "CBADGE_NEW",
    category: "social",
    icon: "Landmark",
    objectives: [{ id: "on", description: "Do thing", target: 1, progress: 0, unit: "x" }],
  },
  {
    id: "q1",
    title: "First Deposit",
    description: "Deposit USDC.",
    points: 50,
    status: "active",
    badgeContractId: "CBADGE_FIRST_DEPOSIT",
    category: "deposit",
    icon: "Landmark",
    objectives: [{ id: "o1", description: "Deposit 100 USDC", target: 100, progress: 0, unit: "USDC" }],
  },
  {
    id: "q2",
    title: "Diamond Hands",
    description: "Hold your vault position for 30 consecutive days.",
    points: 150,
    status: "active",
    badgeContractId: "CBADGE_DIAMOND_HANDS",
    category: "hold",
    icon: "Gem",
    objectives: [{ id: "o2", description: "Hold for 30 days", target: 30, progress: 0, unit: "days" }],
  },
];

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

describe("mergeQuestsWithTemplate", () => {
  it("preserves saved progress for matching ids and picks up new template quests", () => {
    const persisted: Quest[] = [
      {
        ...TEMPLATE[1],
        objectives: [{ ...TEMPLATE[1].objectives[0], progress: 42 }],
        status: "active",
      },
    ];

    const merged = mergeQuestsWithTemplate(persisted, TEMPLATE);
    expect(merged.find((q) => q.id === "q1")?.objectives[0].progress).toBe(42);
    expect(merged.find((q) => q.id === "qNew")).toBeDefined();
    expect(merged.find((q) => q.id === "qNew")?.title).toBe("New Quest From Template");
  });

  it("returns a fresh template copy when nothing persisted", () => {
    const merged = mergeQuestsWithTemplate(null, TEMPLATE);
    expect(merged).toHaveLength(TEMPLATE.length);
    expect(merged[1].objectives[0].progress).toBe(0);
  });
});

describe("applySimulatedIndexerProgress", () => {
  it("updates known demo quests deterministically", () => {
    const base = cloneQuests(TEMPLATE);
    const updated = applySimulatedIndexerProgress(base);
    const q1 = updated.find((q) => q.id === "q1");
    expect(q1?.objectives[0].progress).toBe(100);
    expect(q1?.status).toBe("claimable");
  });
});

describe("per-wallet persistence (reconnect)", () => {
  it("isolates snapshots by wallet address", () => {
    const storage = mockStorage();
    const w1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const w2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    const b1: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: mergeQuestsWithTemplate(
        [
          {
            ...TEMPLATE[1],
            objectives: [{ ...TEMPLATE[1].objectives[0], progress: 77 }],
          },
        ],
        TEMPLATE,
      ),
      achievements: [],
      lastSyncedAt: 111,
    };
    saveWalletQuestBundle(w1, b1, storage);

    const loadedW1 = loadWalletQuestBundle(w1, TEMPLATE, storage);
    expect(loadedW1.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(77);

    const loadedW2 = loadWalletQuestBundle(w2, TEMPLATE, storage);
    expect(loadedW2.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(0);

    expect(storage.snapshot()[walletQuestStorageKey(w1)]).toBeDefined();
    expect(storage.snapshot()[walletQuestStorageKey(w2)]).toBeUndefined();
  });

  it("migrates legacy global keys once into the active wallet bundle", () => {
    const storage = mockStorage({
      sy_quests: JSON.stringify([
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 55 }],
        },
      ]),
      sy_achievements: JSON.stringify([]),
    });
    const w = "GCCCCC";
    const loaded = loadWalletQuestBundle(w, TEMPLATE, storage);
    expect(loaded.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(55);
    expect(storage.getItem("sy_quests")).toBeNull();
    saveWalletQuestBundle(w, loaded, storage);
    expect(storage.getItem(walletQuestStorageKey(w))).toBeTruthy();
  });
});

describe("refresh reconciliation", () => {
  it("applies indexer-shaped updates on top of cached quests", () => {
    const cached: Quest[] = mergeQuestsWithTemplate(
      [{ ...TEMPLATE[1], objectives: [{ ...TEMPLATE[1].objectives[0], progress: 10 }] }],
      TEMPLATE,
    );
    const next = applySimulatedIndexerProgress(cached);
    const q1 = next.find((q) => q.id === "q1");
    expect(q1?.objectives[0].progress).toBe(100);
    expect(q1?.status).toBe("claimable");
  });
});

describe("save and load quest progress", () => {
  it("saves quest progress and loads it back correctly", () => {
    const storage = mockStorage();
    const wallet = "GDSAVETEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";

    const bundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          status: "active",
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 75 }],
        },
      ],
      achievements: [
        {
          questId: "q1",
          title: "First Deposit",
          badgeContractId: "CBADGE_FIRST_DEPOSIT",
          mintedAt: 1234567890,
          txHash: "tx_abc123",
        },
      ],
      lastSyncedAt: 1234567890,
    };

    saveWalletQuestBundle(wallet, bundle, storage);
    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(75);
    expect(loaded.achievements).toHaveLength(1);
    expect(loaded.achievements[0].txHash).toBe("tx_abc123");
    expect(loaded.lastSyncedAt).toBe(1234567890);
  });

  it("saves multiple quest progress updates independently", () => {
    const storage = mockStorage();
    const wallet = "GDMULTITEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234";

    const bundle1: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 25 }],
        },
      ],
      achievements: [],
      lastSyncedAt: 1000,
    };

    saveWalletQuestBundle(wallet, bundle1, storage);

    const bundle2: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 50 }],
        },
      ],
      achievements: [],
      lastSyncedAt: 2000,
    };

    saveWalletQuestBundle(wallet, bundle2, storage);
    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(50);
    expect(loaded.lastSyncedAt).toBe(2000);
  });

  it("loads fresh template when no saved data exists", () => {
    const storage = mockStorage();
    const wallet = "GDFRESHTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123";

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests).toHaveLength(TEMPLATE.length);
    expect(loaded.quests[1].objectives[0].progress).toBe(0);
    expect(loaded.achievements).toHaveLength(0);
    expect(loaded.lastSyncedAt).toBeNull();
  });

  it("preserves achievements across saves", () => {
    const storage = mockStorage();
    const wallet = "GDACHIEVETEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXY";

    const achievement1 = {
      questId: "q1",
      title: "First Deposit",
      badgeContractId: "CBADGE_FIRST_DEPOSIT",
      mintedAt: 1000,
      txHash: "tx_first",
    };

    const achievement2 = {
      questId: "q2",
      title: "Diamond Hands",
      badgeContractId: "CBADGE_DIAMOND_HANDS",
      mintedAt: 2000,
      txHash: "tx_second",
    };

    const bundle1: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: cloneQuests(TEMPLATE),
      achievements: [achievement1],
      lastSyncedAt: 1000,
    };

    saveWalletQuestBundle(wallet, bundle1, storage);

    const bundle2: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: cloneQuests(TEMPLATE),
      achievements: [achievement1, achievement2],
      lastSyncedAt: 2000,
    };

    saveWalletQuestBundle(wallet, bundle2, storage);
    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.achievements).toHaveLength(2);
    expect(loaded.achievements[0].txHash).toBe("tx_first");
    expect(loaded.achievements[1].txHash).toBe("tx_second");
  });
});

describe("malformed localStorage data handling & corrupted state recovery", () => {
  it("handles corrupted JSON gracefully without crashing", () => {
    const storage = mockStorage();
    const wallet = "GDCORRUPTTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXY";
    const key = walletQuestStorageKey(wallet);

    storage.setItem(key, "{invalid json here");

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests).toHaveLength(TEMPLATE.length);
    expect(loaded.achievements).toHaveLength(0);
    expect(loaded.lastSyncedAt).toBeNull();
  });

  it("handles missing version field by upgrading gracefully", () => {
    const storage = mockStorage();
    const wallet = "GDNOVERSIONTEST1234567890ABCDEFGHIJKLMNOPQRSTUVW";
    const key = walletQuestStorageKey(wallet);

    storage.setItem(
      key,
      JSON.stringify({
        quests: [
          {
            ...TEMPLATE[1],
            objectives: [{ ...TEMPLATE[1].objectives[0], progress: 65 }],
          },
        ],
        achievements: [],
        lastSyncedAt: 1000,
      }),
    );

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(65);
  });

  it("handles wrong version number and recovers valid progress", () => {
    const storage = mockStorage();
    const wallet = "GDWRONGVERSIONTEST1234567890ABCDEFGHIJKLMNOPQRST";
    const key = walletQuestStorageKey(wallet);

    storage.setItem(
      key,
      JSON.stringify({
        version: 999,
        quests: [
          {
            ...TEMPLATE[1],
            objectives: [{ ...TEMPLATE[1].objectives[0], progress: 70 }],
          },
        ],
        achievements: [],
        lastSyncedAt: 1000,
      }),
    );

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(70);
  });

  it("handles non-array quests field gracefully", () => {
    const storage = mockStorage();
    const wallet = "GDNONARRAYTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWX";
    const key = walletQuestStorageKey(wallet);

    storage.setItem(
      key,
      JSON.stringify({
        version: QUEST_STORAGE_VERSION,
        quests: "not an array",
        achievements: [],
        lastSyncedAt: 1000,
      }),
    );

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.quests).toHaveLength(TEMPLATE.length);
    expect(Array.isArray(loaded.quests)).toBe(true);
  });

  it("handles non-array achievements field gracefully", () => {
    const storage = mockStorage();
    const wallet = "GDNONARRAYACH1234567890ABCDEFGHIJKLMNOPQRSTUVWXY";
    const key = walletQuestStorageKey(wallet);

    storage.setItem(
      key,
      JSON.stringify({
        version: QUEST_STORAGE_VERSION,
        quests: [],
        achievements: "not an array",
        lastSyncedAt: 1000,
      }),
    );

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(Array.isArray(loaded.achievements)).toBe(true);
    expect(loaded.achievements).toHaveLength(0);
  });

  it("handles null storage value", () => {
    const storage = mockStorage();
    const wallet = "GDNULLTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123";

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests).toHaveLength(TEMPLATE.length);
    expect(loaded.achievements).toHaveLength(0);
  });

  it("handles empty string storage value", () => {
    const storage = mockStorage();
    const wallet = "GDEMPTYTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12";
    const key = walletQuestStorageKey(wallet);

    storage.setItem(key, "");

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests).toHaveLength(TEMPLATE.length);
  });

  it("recovers partially corrupted quest arrays and restores corrupted items from template", () => {
    const storage = mockStorage();
    const wallet = "GDPARTIALCORRUPT1234567890ABCDEFGHIJKLMNOPQRST";
    const key = walletQuestStorageKey(wallet);

    storage.setItem(
      key,
      JSON.stringify({
        version: QUEST_STORAGE_VERSION,
        quests: [
          null,
          undefined,
          "invalid string quest",
          { id: "q1", objectives: [{ id: "o1", description: "Deposit 100", target: 100, progress: 88, unit: "USDC" }] },
          { id: "q2", objectives: "corrupted_objectives", status: null },
        ],
        achievements: [
          null,
          { questId: "q1", title: "First Deposit", badgeContractId: "CB1", mintedAt: 1000, txHash: "tx_1" },
          { questId: null, txHash: null },
        ],
        lastSyncedAt: 123456,
      }),
    );

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.quests).toHaveLength(TEMPLATE.length);
    // Preserves progress from valid quest
    expect(loaded.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(88);
    // Repaired quest q2 has valid structure from template
    const q2 = loaded.quests.find((q) => q.id === "q2");
    expect(q2).toBeDefined();
    expect(Array.isArray(q2?.objectives)).toBe(true);
    expect(q2?.objectives[0].target).toBe(30);
    // Filtered out corrupted achievements while keeping valid one
    expect(loaded.achievements).toHaveLength(1);
    expect(loaded.achievements[0].txHash).toBe("tx_1");
  });

  it("sanitizes invalid objective progress values (NaN, negative, string)", () => {
    const fallbackObj = TEMPLATE[1].objectives[0];
    const sanitizedNaN = sanitizeQuestObjective({ progress: NaN, target: 100 }, fallbackObj);
    expect(sanitizedNaN.progress).toBe(0);

    const sanitizedNegative = sanitizeQuestObjective({ progress: -50, target: 100 }, fallbackObj);
    expect(sanitizedNegative.progress).toBe(0);

    const sanitizedString = sanitizeQuestObjective({ progress: "75", target: "100" }, fallbackObj);
    expect(sanitizedString.progress).toBe(75);
    expect(sanitizedString.target).toBe(100);
  });

  it("sanitizes corrupted achievements safely", () => {
    expect(sanitizeAchievement(null)).toBeNull();
    expect(sanitizeAchievement({})).toBeNull();
    expect(sanitizeAchievement({ questId: "", txHash: "" })).toBeNull();

    const validAch = sanitizeAchievement({
      questId: "q1",
      title: "First Deposit",
      mintedAt: "2026-01-01T00:00:00Z",
      txHash: "tx_abc",
    });
    expect(validAch).not.toBeNull();
    expect(validAch?.txHash).toBe("tx_abc");
    expect(validAch?.mintedAt).toBe(new Date("2026-01-01T00:00:00Z").getTime());
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
    const bundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: cloneQuests(TEMPLATE),
      achievements: [],
      lastSyncedAt: 1000,
    };

    expect(() => saveWalletQuestBundle(wallet, bundle, storage)).not.toThrow();
  });

  it("handles storage in private browsing mode", () => {
    const storage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {},
    };

    const wallet = "GDPRIVATETEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXY";

    expect(() => loadWalletQuestBundle(wallet, TEMPLATE, storage)).not.toThrow();

    const bundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: cloneQuests(TEMPLATE),
      achievements: [],
      lastSyncedAt: 1000,
    };

    expect(() => saveWalletQuestBundle(wallet, bundle, storage)).not.toThrow();
  });
});

describe("migration fixtures and legacy state upgrade", () => {
  it("upgrades global v0 unversioned state fixture to active wallet bundle", () => {
    const storage = mockStorage({
      sy_quests: MIGRATION_FIXTURES.v0Global.sy_quests,
      sy_achievements: MIGRATION_FIXTURES.v0Global.sy_achievements,
    });

    const wallet = "GDMIGRATEV0GLOBAL1234567890ABCDEFGHIJKLMNOPQRSTU";
    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(60);
    expect(loaded.achievements).toHaveLength(1);
    expect(loaded.achievements[0].txHash).toBe("tx_legacy_001");
    // Global keys should be removed after migration
    expect(storage.getItem("sy_quests")).toBeNull();
    expect(storage.getItem("sy_achievements")).toBeNull();
  });

  it("upgrades v0 unversioned wallet key (sy_quest_wallet_<addr>) to v1 key", () => {
    const wallet = "GDMIGRATEV0WALLET1234567890ABCDEFGHIJKLMNOPQRSTU";
    const oldKey = `sy_quest_wallet_${wallet}`;
    const storage = mockStorage({
      [oldKey]: JSON.stringify({
        quests: [
          {
            id: "q1",
            title: "First Deposit",
            description: "Deposit USDC.",
            points: 50,
            status: "active",
            badgeContractId: "CBADGE_FIRST_DEPOSIT",
            category: "deposit",
            icon: "Landmark",
            objectives: [{ id: "o1", description: "Deposit 100 USDC", target: 100, progress: 95, unit: "USDC" }],
          },
        ],
        achievements: [],
        lastSyncedAt: 5000,
      }),
    });

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);
    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(95);
    expect(storage.getItem(oldKey)).toBeNull();
    expect(storage.getItem(walletQuestStorageKey(wallet))).toBeTruthy();
  });

  it("migrates legacy flat objectives fixture into standard objective array", () => {
    const migrated = migrateQuestBundle(MIGRATION_FIXTURES.v0FlatObjectives, TEMPLATE);
    const q1 = migrated.quests.find((q) => q.id === "q1");

    expect(q1).toBeDefined();
    expect(Array.isArray(q1?.objectives)).toBe(true);
    expect(q1?.objectives[0].progress).toBe(85);
    expect(q1?.objectives[0].target).toBe(100);
  });

  it("migrates legacy boolean status fixture into valid QuestStatus", () => {
    const migrated = migrateQuestBundle(MIGRATION_FIXTURES.v0LegacyStatus, TEMPLATE);
    const q1 = migrated.quests.find((q) => q.id === "q1");
    const q2 = migrated.quests.find((q) => q.id === "q2");

    expect(q1?.status).toBe("claimable");
    expect(q2?.status).toBe("completed");
    expect(migrated.achievements).toHaveLength(1);
    expect(migrated.achievements[0].txHash).toBe("tx_legacy_002");
  });

  it("migrates partially corrupted fixture without throwing", () => {
    const migrated = migrateQuestBundle(MIGRATION_FIXTURES.partiallyCorrupted, TEMPLATE);
    expect(migrated.version).toBe(QUEST_STORAGE_VERSION);
    expect(migrated.quests).toHaveLength(TEMPLATE.length);
    expect(migrated.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(45);
    expect(migrated.achievements).toHaveLength(1);
    expect(migrated.achievements[0].txHash).toBe("tx_valid_1");
  });
});

describe("stale cache detection, invalidation, and recovery", () => {
  it("correctly evaluates isCacheStale based on lastSyncedAt and TTL", () => {
    const now = 1700000000000;

    // Fresh cache (within TTL)
    expect(isCacheStale({ lastSyncedAt: now - 1000 }, DEFAULT_CACHE_TTL_MS, now)).toBe(false);
    expect(isCacheStale({ lastSyncedAt: now - 3600000 }, DEFAULT_CACHE_TTL_MS, now)).toBe(false);

    // Stale cache (older than TTL)
    expect(isCacheStale({ lastSyncedAt: now - DEFAULT_CACHE_TTL_MS - 1000 }, DEFAULT_CACHE_TTL_MS, now)).toBe(true);

    // Missing, null, undefined, or NaN timestamps are considered stale
    expect(isCacheStale(null, DEFAULT_CACHE_TTL_MS, now)).toBe(true);
    expect(isCacheStale({ lastSyncedAt: null }, DEFAULT_CACHE_TTL_MS, now)).toBe(true);
    expect(isCacheStale({ lastSyncedAt: NaN }, DEFAULT_CACHE_TTL_MS, now)).toBe(true);
    expect(isCacheStale({ lastSyncedAt: 0 }, DEFAULT_CACHE_TTL_MS, now)).toBe(true);

    // Future clock skew beyond 5 minutes is considered stale
    expect(isCacheStale({ lastSyncedAt: now + 10 * 60 * 1000 }, DEFAULT_CACHE_TTL_MS, now)).toBe(true);
  });

  it("invalidates wallet cache using invalidateWalletQuestCache", () => {
    const storage = mockStorage();
    const wallet = "GDINVALIDATETEST1234567890ABCDEFGHIJKLMNOPQRSTUV";
    const key = walletQuestStorageKey(wallet);

    const bundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: cloneQuests(TEMPLATE),
      achievements: [],
      lastSyncedAt: Date.now(),
    };

    saveWalletQuestBundle(wallet, bundle, storage);
    expect(storage.getItem(key)).toBeTruthy();

    invalidateWalletQuestCache(wallet, storage);
    expect(storage.getItem(key)).toBeNull();
  });

  it("resets stale progress when allowStale is false", () => {
    const storage = mockStorage();
    const wallet = "GDSTALETEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXY";
    const staleTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago

    const bundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 99 }],
        },
      ],
      achievements: [
        {
          questId: "q1",
          title: "First Deposit",
          badgeContractId: "CB1",
          mintedAt: staleTime,
          txHash: "tx_stale_1",
        },
      ],
      lastSyncedAt: staleTime,
    };

    saveWalletQuestBundle(wallet, bundle, storage);

    // Loading with allowStale: false resets progress to template
    const loadedWithoutStale = loadWalletQuestBundle(wallet, TEMPLATE, storage, { allowStale: false });
    expect(loadedWithoutStale.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(0);
    expect(loadedWithoutStale.achievements).toHaveLength(1); // achievements preserved
    expect(loadedWithoutStale.lastSyncedAt).toBeNull();

    // Loading with allowStale: true (default) returns cached progress for optimistic display
    saveWalletQuestBundle(wallet, bundle, storage);
    const loadedWithStale = loadWalletQuestBundle(wallet, TEMPLATE, storage, { allowStale: true });
    expect(loadedWithStale.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(99);
  });
});

describe("reset behavior", () => {
  it("clears wallet data when removeItem is called", () => {
    const storage = mockStorage();
    const wallet = "GDRESETTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1";
    const key = walletQuestStorageKey(wallet);

    const bundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 99 }],
        },
      ],
      achievements: [
        {
          questId: "q1",
          title: "First Deposit",
          badgeContractId: "CBADGE_FIRST_DEPOSIT",
          mintedAt: 1000,
          txHash: "tx_reset",
        },
      ],
      lastSyncedAt: 1000,
    };

    saveWalletQuestBundle(wallet, bundle, storage);
    expect(storage.getItem(key)).toBeTruthy();

    storage.removeItem(key);
    expect(storage.getItem(key)).toBeNull();

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);
    expect(loaded.quests[1].objectives[0].progress).toBe(0);
    expect(loaded.achievements).toHaveLength(0);
    expect(loaded.lastSyncedAt).toBeNull();
  });

  it("resets progress for specific wallet without affecting others", () => {
    const storage = mockStorage();
    const wallet1 = "GDRESET1TEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const wallet2 = "GDRESET2TEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    const bundle1: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 50 }],
        },
      ],
      achievements: [],
      lastSyncedAt: 1000,
    };

    const bundle2: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 75 }],
        },
      ],
      achievements: [],
      lastSyncedAt: 2000,
    };

    saveWalletQuestBundle(wallet1, bundle1, storage);
    saveWalletQuestBundle(wallet2, bundle2, storage);

    storage.removeItem(walletQuestStorageKey(wallet1));

    const loaded1 = loadWalletQuestBundle(wallet1, TEMPLATE, storage);
    const loaded2 = loadWalletQuestBundle(wallet2, TEMPLATE, storage);

    expect(loaded1.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(0);
    expect(loaded2.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(75);
  });

  it("allows fresh start after reset", () => {
    const storage = mockStorage();
    const wallet = "GDFRESHSTARTTEST1234567890ABCDEFGHIJKLMNOPQRSTUV";
    const key = walletQuestStorageKey(wallet);

    const oldBundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          status: "completed",
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 100 }],
        },
      ],
      achievements: [
        {
          questId: "q1",
          title: "First Deposit",
          badgeContractId: "CBADGE_FIRST_DEPOSIT",
          mintedAt: 1000,
          txHash: "tx_old",
        },
      ],
      lastSyncedAt: 1000,
    };

    saveWalletQuestBundle(wallet, oldBundle, storage);
    storage.removeItem(key);

    const newBundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 10 }],
        },
      ],
      achievements: [],
      lastSyncedAt: 2000,
    };

    saveWalletQuestBundle(wallet, newBundle, storage);
    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(10);
    expect(loaded.quests.find((q) => q.id === "q1")?.status).not.toBe("completed");
    expect(loaded.achievements).toHaveLength(0);
    expect(loaded.lastSyncedAt).toBe(2000);
  });
});

describe("deterministic and isolated tests", () => {
  it("does not mutate template quests", () => {
    const storage = mockStorage();
    const wallet = "GDMUTATETEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const originalProgress = TEMPLATE[1].objectives[0].progress;

    const bundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 88 }],
        },
      ],
      achievements: [],
      lastSyncedAt: 1000,
    };

    saveWalletQuestBundle(wallet, bundle, storage);
    loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(TEMPLATE[1].objectives[0].progress).toBe(originalProgress);
  });

  it("returns independent copies on each load", () => {
    const storage = mockStorage();
    const wallet = "GDINDEPENDENTTEST1234567890ABCDEFGHIJKLMNOPQRSTU";

    const bundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 33 }],
        },
      ],
      achievements: [],
      lastSyncedAt: 1000,
    };

    saveWalletQuestBundle(wallet, bundle, storage);

    const loaded1 = loadWalletQuestBundle(wallet, TEMPLATE, storage);
    const loaded2 = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    loaded1.quests[0].objectives[0].progress = 999;

    expect(loaded2.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(33);
  });

  it("isolates storage operations between test runs", () => {
    const storage1 = mockStorage();
    const storage2 = mockStorage();
    const wallet = "GDISOLATETEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXY";

    const bundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: cloneQuests(TEMPLATE),
      achievements: [],
      lastSyncedAt: 1000,
    };

    saveWalletQuestBundle(wallet, bundle, storage1);

    const loaded1 = loadWalletQuestBundle(wallet, TEMPLATE, storage1);
    const loaded2 = loadWalletQuestBundle(wallet, TEMPLATE, storage2);

    expect(loaded1.lastSyncedAt).toBe(1000);
    expect(loaded2.lastSyncedAt).toBeNull();
  });

  it("produces consistent results with same inputs", () => {
    const storage = mockStorage();
    const wallet = "GDCONSISTENTTEST1234567890ABCDEFGHIJKLMNOPQRSTUV";

    const bundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 42 }],
        },
      ],
      achievements: [],
      lastSyncedAt: 1000,
    };

    saveWalletQuestBundle(wallet, bundle, storage);

    const loaded1 = loadWalletQuestBundle(wallet, TEMPLATE, storage);
    const loaded2 = loadWalletQuestBundle(wallet, TEMPLATE, storage);
    const loaded3 = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded1.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(42);
    expect(loaded2.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(42);
    expect(loaded3.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(42);
  });
});
