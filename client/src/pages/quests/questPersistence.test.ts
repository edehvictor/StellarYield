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
