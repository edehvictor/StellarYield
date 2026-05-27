import { describe, it, expect } from "vitest";
import type { Quest } from "./types";
import {
  QUEST_STORAGE_VERSION,
  applySimulatedIndexerProgress,
  cloneQuests,
  loadWalletQuestBundle,
  mergeQuestsWithTemplate,
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
];

function mockStorage(initial: Record<string, string> = {}) {
  let store = { ...initial };
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

describe("malformed localStorage data handling", () => {
  it("handles corrupted JSON gracefully", () => {
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

  it("handles missing version field", () => {
    const storage = mockStorage();
    const wallet = "GDNOVERSIONTEST1234567890ABCDEFGHIJKLMNOPQRSTUVW";
    const key = walletQuestStorageKey(wallet);

    storage.setItem(
      key,
      JSON.stringify({
        quests: [],
        achievements: [],
        lastSyncedAt: 1000,
      }),
    );

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests).toHaveLength(TEMPLATE.length);
  });

  it("handles wrong version number", () => {
    const storage = mockStorage();
    const wallet = "GDWRONGVERSIONTEST1234567890ABCDEFGHIJKLMNOPQRST";
    const key = walletQuestStorageKey(wallet);

    storage.setItem(
      key,
      JSON.stringify({
        version: 999,
        quests: [TEMPLATE[1]],
        achievements: [],
        lastSyncedAt: 1000,
      }),
    );

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests).toHaveLength(TEMPLATE.length);
  });

  it("handles non-array quests field", () => {
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

  it("handles non-array achievements field", () => {
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

  it("handles malformed quest objects in array", () => {
    const storage = mockStorage();
    const wallet = "GDMALFORMEDQUEST1234567890ABCDEFGHIJKLMNOPQRSTUV";
    const key = walletQuestStorageKey(wallet);

    storage.setItem(
      key,
      JSON.stringify({
        version: QUEST_STORAGE_VERSION,
        quests: [
          { id: "q1" }, // Missing required fields
          null,
          undefined,
          "not an object",
        ],
        achievements: [],
        lastSyncedAt: 1000,
      }),
    );

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.quests).toHaveLength(TEMPLATE.length);
    expect(loaded.quests.every((q) => q.id && q.title && q.objectives)).toBe(true);
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
