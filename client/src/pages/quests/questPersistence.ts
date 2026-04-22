import type { Achievement, Quest } from "./types";

export const QUEST_STORAGE_VERSION = 1;

const LEGACY_QUESTS_KEY = "sy_quests";
const LEGACY_ACHIEVEMENTS_KEY = "sy_achievements";

/** Display-safe snapshot for a wallet (never trust as proof of completion on-chain). */
export interface PersistedWalletQuestBundle {
  version: typeof QUEST_STORAGE_VERSION;
  quests: Quest[];
  achievements: Achievement[];
  /** When progress was last confirmed via indexer/backend (ms epoch). */
  lastSyncedAt: number | null;
}

export type StorageBackend = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export function walletQuestStorageKey(walletAddress: string): string {
  return `sy_quest_wallet_v${QUEST_STORAGE_VERSION}_${walletAddress}`;
}

/** Deep clone quest definitions so we never mutate templates in memory. */
export function cloneQuests(quests: Quest[]): Quest[] {
  return structuredClone(quests);
}

/**
 * Ensures new quests from the template appear while preserving saved progress for known IDs.
 */
export function mergeQuestsWithTemplate(
  persisted: Quest[] | null | undefined,
  template: Quest[],
): Quest[] {
  const base = cloneQuests(template);
  if (!persisted?.length) return base;

  const byId = new Map(persisted.map((q) => [q.id, q]));
  return base.map((q) => {
    const saved = byId.get(q.id);
    return saved ? structuredClone(saved) : q;
  });
}

/**
 * Simulates indexer-confirmed objective progress (replace with real API in production).
 */
export function applySimulatedIndexerProgress(quests: Quest[]): Quest[] {
  return quests.map((q) => {
    if (q.id === "q1") {
      const progress = 100;
      const completed = progress >= q.objectives[0].target;
      return {
        ...q,
        status: completed ? "claimable" : "active",
        objectives: [{ ...q.objectives[0], progress }],
      };
    }
    if (q.id === "q2") {
      const progress = 12;
      return {
        ...q,
        objectives: [{ ...q.objectives[0], progress }],
      };
    }
    if (q.id === "q4") {
      const progress = 3;
      const completed = progress >= q.objectives[0].target;
      return {
        ...q,
        status: completed ? "claimable" : "active",
        objectives: [{ ...q.objectives[0], progress }],
      };
    }
    return q;
  });
}

function parseBundle(raw: string | null): PersistedWalletQuestBundle | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedWalletQuestBundle;
    if (
      parsed &&
      parsed.version === QUEST_STORAGE_VERSION &&
      Array.isArray(parsed.quests) &&
      Array.isArray(parsed.achievements)
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readLegacyBundle(storage: StorageBackend): Omit<
  PersistedWalletQuestBundle,
  "version"
> | null {
  try {
    const rawQ = storage.getItem(LEGACY_QUESTS_KEY);
    const rawA = storage.getItem(LEGACY_ACHIEVEMENTS_KEY);
    if (!rawQ) return null;
    const quests = JSON.parse(rawQ) as Quest[];
    if (!Array.isArray(quests)) return null;
    const achievements = rawA
      ? (JSON.parse(rawA) as Achievement[])
      : [];
    storage.removeItem(LEGACY_QUESTS_KEY);
    storage.removeItem(LEGACY_ACHIEVEMENTS_KEY);
    return {
      quests,
      achievements: Array.isArray(achievements) ? achievements : [],
      lastSyncedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export function loadWalletQuestBundle(
  walletAddress: string,
  template: Quest[],
  storage: StorageBackend = localStorage,
): PersistedWalletQuestBundle {
  const key = walletQuestStorageKey(walletAddress);
  const fromDisk = parseBundle(storage.getItem(key));

  if (fromDisk) {
    return {
      ...fromDisk,
      quests: mergeQuestsWithTemplate(fromDisk.quests, template),
    };
  }

  const migrated = readLegacyBundle(storage);
  if (migrated) {
    return {
      version: QUEST_STORAGE_VERSION,
      quests: mergeQuestsWithTemplate(migrated.quests, template),
      achievements: migrated.achievements,
      lastSyncedAt: migrated.lastSyncedAt,
    };
  }

  return {
    version: QUEST_STORAGE_VERSION,
    quests: cloneQuests(template),
    achievements: [],
    lastSyncedAt: null,
  };
}

export function saveWalletQuestBundle(
  walletAddress: string,
  bundle: PersistedWalletQuestBundle,
  storage: StorageBackend = localStorage,
): void {
  try {
    storage.setItem(
      walletQuestStorageKey(walletAddress),
      JSON.stringify(bundle),
    );
  } catch {
    /* quota or private mode — non-fatal */
  }
}
