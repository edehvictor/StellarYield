import type { Achievement, Quest, QuestObjective, QuestStatus } from "./types";

export const QUEST_STORAGE_VERSION = 1;
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_STALE_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

export interface LoadQuestBundleOptions {
  /** Maximum cache age in ms before treating as stale (defaults to DEFAULT_CACHE_TTL_MS) */
  maxAgeMs?: number;
  /** If false, resets stale cached progress while preserving achievements */
  allowStale?: boolean;
}

export function walletQuestStorageKey(walletAddress: string): string {
  return `sy_quest_wallet_v${QUEST_STORAGE_VERSION}_${walletAddress}`;
}

/** Deep clone quest definitions so we never mutate templates in memory. */
export function cloneQuests(quests: Quest[]): Quest[] {
  return structuredClone(quests);
}

/**
 * Checks whether a cached quest bundle is considered stale based on lastSyncedAt timestamp.
 */
export function isCacheStale(
  bundle: Pick<PersistedWalletQuestBundle, "lastSyncedAt"> | null | undefined,
  maxAgeMs: number = DEFAULT_CACHE_TTL_MS,
  now: number = Date.now(),
): boolean {
  if (!bundle || bundle.lastSyncedAt === null || bundle.lastSyncedAt === undefined) {
    return true;
  }
  if (
    typeof bundle.lastSyncedAt !== "number" ||
    isNaN(bundle.lastSyncedAt) ||
    !isFinite(bundle.lastSyncedAt) ||
    bundle.lastSyncedAt <= 0
  ) {
    return true;
  }
  // Clock skew in the future by more than 5 minutes is considered invalid/stale
  if (bundle.lastSyncedAt > now + 5 * 60 * 1000) {
    return true;
  }
  return now - bundle.lastSyncedAt > maxAgeMs;
}

/**
 * Explicitly invalidates and purges the cached quest data for a given wallet address.
 */
export function invalidateWalletQuestCache(
  walletAddress: string,
  storage: StorageBackend = localStorage,
): void {
  try {
    const key = walletQuestStorageKey(walletAddress);
    storage.removeItem(key);
    storage.removeItem(`sy_quest_wallet_v0_${walletAddress}`);
    storage.removeItem(`sy_quest_wallet_${walletAddress}`);
    storage.removeItem(`sy_quests_${walletAddress}`);
  } catch {
    /* ignore storage errors */
  }
}

/**
 * Sanitizes a single quest objective, recovering valid progress and falling back safely on corruptions.
 */
export function sanitizeQuestObjective(
  rawObj: unknown,
  fallbackObj?: QuestObjective,
): QuestObjective {
  const defaultFallback: QuestObjective = fallbackObj ?? {
    id: "obj_default",
    description: "Objective",
    target: 1,
    progress: 0,
    unit: "",
  };

  if (!rawObj || typeof rawObj !== "object") {
    return { ...defaultFallback };
  }

  const obj = rawObj as Record<string, unknown>;
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id : defaultFallback.id;
  const description =
    typeof obj.description === "string" ? obj.description : defaultFallback.description;

  let target = defaultFallback.target;
  if (typeof obj.target === "number" && !isNaN(obj.target) && isFinite(obj.target) && obj.target > 0) {
    target = obj.target;
  } else if (
    typeof obj.target === "string" &&
    !isNaN(Number(obj.target)) &&
    Number(obj.target) > 0
  ) {
    target = Number(obj.target);
  }

  let progress = 0;
  const rawProg = obj.progress ?? obj.currentProgress ?? obj.current ?? obj.value;
  if (typeof rawProg === "number" && !isNaN(rawProg) && isFinite(rawProg)) {
    progress = Math.max(0, rawProg);
  } else if (typeof rawProg === "string" && !isNaN(Number(rawProg))) {
    progress = Math.max(0, Number(rawProg));
  }

  const unit = typeof obj.unit === "string" ? obj.unit : defaultFallback.unit;

  return {
    id,
    description,
    target,
    progress,
    unit,
  };
}

/**
 * Sanitizes a quest object against its template, preserving user progress and repairing invalid fields.
 */
export function sanitizeQuest(
  rawQuest: unknown,
  templateQuest?: Quest,
): Quest | null {
  if (!rawQuest || typeof rawQuest !== "object") {
    return templateQuest ? structuredClone(templateQuest) : null;
  }

  const raw = rawQuest as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : templateQuest?.id;
  if (!id) return null;

  const fallback = templateQuest ?? {
    id,
    title: typeof raw.title === "string" ? raw.title : "Quest",
    description: typeof raw.description === "string" ? raw.description : "",
    points: typeof raw.points === "number" && !isNaN(raw.points) ? raw.points : 50,
    status: "active" as QuestStatus,
    badgeContractId: typeof raw.badgeContractId === "string" ? raw.badgeContractId : "",
    category: "deposit" as const,
    icon: "Landmark",
    objectives: [
      {
        id: `obj_${id}`,
        description: "Complete objective",
        target: 100,
        progress: 0,
        unit: "",
      },
    ],
  };

  const title = typeof raw.title === "string" ? raw.title : fallback.title;
  const description = typeof raw.description === "string" ? raw.description : fallback.description;
  const points = typeof raw.points === "number" && !isNaN(raw.points) ? raw.points : fallback.points;
  const badgeContractId =
    typeof raw.badgeContractId === "string" ? raw.badgeContractId : fallback.badgeContractId;

  const validCategories = ["deposit", "hold", "trade", "governance", "social"] as const;
  const category =
    typeof raw.category === "string" && (validCategories as readonly string[]).includes(raw.category)
      ? (raw.category as Quest["category"])
      : fallback.category;

  const icon = typeof raw.icon === "string" && raw.icon.trim() ? raw.icon : fallback.icon;

  let objectives: QuestObjective[] = [];
  if (Array.isArray(raw.objectives) && raw.objectives.length > 0) {
    objectives = raw.objectives.map((o, idx) =>
      sanitizeQuestObjective(o, fallback.objectives[idx] ?? fallback.objectives[0])
    );
  } else if (raw.objectives && typeof raw.objectives === "object") {
    objectives = [sanitizeQuestObjective(raw.objectives, fallback.objectives[0])];
  } else if (
    raw.progress !== undefined ||
    raw.currentProgress !== undefined ||
    raw.target !== undefined
  ) {
    objectives = [sanitizeQuestObjective(raw, fallback.objectives[0])];
  } else {
    objectives = fallback.objectives.map((o) => ({ ...o }));
  }

  let status: QuestStatus = fallback.status;
  const validStatuses: QuestStatus[] = ["locked", "active", "completed", "claimable"];

  if (typeof raw.status === "string" && (validStatuses as string[]).includes(raw.status)) {
    status = raw.status as QuestStatus;
  } else if (raw.completed === true || raw.isCompleted === true) {
    status = raw.claimed === true || raw.isClaimed === true ? "completed" : "claimable";
  } else if (raw.locked === true || raw.isLocked === true) {
    status = "locked";
  } else {
    const firstObj = objectives[0];
    if (firstObj && firstObj.progress >= firstObj.target) {
      status = "claimable";
    }
  }

  return {
    id,
    title,
    description,
    objectives,
    points,
    status,
    badgeContractId,
    category,
    icon,
  };
}

/**
 * Sanitizes an achievement record, dropping unrecoverable corrupted items.
 */
export function sanitizeAchievement(rawAch: unknown): Achievement | null {
  if (!rawAch || typeof rawAch !== "object") return null;
  const raw = rawAch as Record<string, unknown>;

  const questId = typeof raw.questId === "string" && raw.questId.trim() ? raw.questId : null;
  const title = typeof raw.title === "string" ? raw.title : "Achievement";
  const badgeContractId =
    typeof raw.badgeContractId === "string" ? raw.badgeContractId : "";
  const txHash = typeof raw.txHash === "string" && raw.txHash.trim() ? raw.txHash : "";

  let mintedAt = Date.now();
  if (
    typeof raw.mintedAt === "number" &&
    !isNaN(raw.mintedAt) &&
    isFinite(raw.mintedAt) &&
    raw.mintedAt > 0
  ) {
    mintedAt = raw.mintedAt;
  } else if (typeof raw.mintedAt === "string" && !isNaN(new Date(raw.mintedAt).getTime())) {
    mintedAt = new Date(raw.mintedAt).getTime();
  }

  if (!questId && !txHash) {
    return null;
  }

  return {
    questId: questId ?? "unknown_quest",
    title,
    badgeContractId,
    mintedAt,
    txHash: txHash || `tx_migrated_${Math.random().toString(36).slice(2, 8)}`,
  };
}

/**
 * Migrates and sanitizes an arbitrary cached quest object into a valid PersistedWalletQuestBundle.
 */
export function migrateQuestBundle(
  rawParsed: unknown,
  template: Quest[],
): PersistedWalletQuestBundle {
  if (!rawParsed || typeof rawParsed !== "object") {
    return {
      version: QUEST_STORAGE_VERSION,
      quests: cloneQuests(template),
      achievements: [],
      lastSyncedAt: null,
    };
  }

  // Early legacy format where raw parsed data is an array of quests directly
  if (Array.isArray(rawParsed)) {
    const sanitizedQuests = rawParsed
      .map((q) => sanitizeQuest(q))
      .filter((q): q is Quest => q !== null);
    return {
      version: QUEST_STORAGE_VERSION,
      quests: mergeQuestsWithTemplate(sanitizedQuests, template),
      achievements: [],
      lastSyncedAt: Date.now(),
    };
  }

  const obj = rawParsed as Record<string, unknown>;
  const rawQuests = Array.isArray(obj.quests) ? obj.quests : [];
  const rawAchievements = Array.isArray(obj.achievements) ? obj.achievements : [];

  const templateMap = new Map(template.map((t) => [t.id, t]));

  const sanitizedQuests: Quest[] = [];
  for (const rawQ of rawQuests) {
    if (!rawQ || typeof rawQ !== "object") continue;
    const qId = (rawQ as Record<string, unknown>).id;
    const tpl = typeof qId === "string" ? templateMap.get(qId) : undefined;
    const sanitized = sanitizeQuest(rawQ, tpl);
    if (sanitized) {
      sanitizedQuests.push(sanitized);
    }
  }

  const sanitizedAchievements: Achievement[] = [];
  for (const rawA of rawAchievements) {
    const sanitized = sanitizeAchievement(rawA);
    if (sanitized) {
      sanitizedAchievements.push(sanitized);
    }
  }

  let lastSyncedAt: number | null = null;
  if (
    typeof obj.lastSyncedAt === "number" &&
    !isNaN(obj.lastSyncedAt) &&
    isFinite(obj.lastSyncedAt) &&
    obj.lastSyncedAt > 0
  ) {
    lastSyncedAt = obj.lastSyncedAt;
  } else if (typeof obj.lastSyncedAt === "string" && !isNaN(new Date(obj.lastSyncedAt).getTime())) {
    lastSyncedAt = new Date(obj.lastSyncedAt).getTime();
  }

  return {
    version: QUEST_STORAGE_VERSION,
    quests: mergeQuestsWithTemplate(sanitizedQuests, template),
    achievements: sanitizedAchievements,
    lastSyncedAt,
  };
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

  const validPersisted = persisted.filter(
    (q): q is Quest => Boolean(q && typeof q === "object" && "id" in q),
  );
  const byId = new Map(validPersisted.map((q) => [q.id, q]));
  return base.map((q) => {
    const saved = byId.get(q.id);
    if (!saved) return q;
    return {
      ...q,
      ...saved,
      title: saved.title || q.title,
      description: saved.description || q.description,
      objectives: Array.isArray(saved.objectives) && saved.objectives.length > 0 ? saved.objectives : q.objectives,
    };
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

function readLegacyBundle(storage: StorageBackend): Omit<
  PersistedWalletQuestBundle,
  "version"
> | null {
  try {
    const rawQ = storage.getItem(LEGACY_QUESTS_KEY);
    const rawA = storage.getItem(LEGACY_ACHIEVEMENTS_KEY);
    if (!rawQ) return null;
    const quests = JSON.parse(rawQ) as unknown[];
    if (!Array.isArray(quests)) return null;
    const achievements = rawA ? (JSON.parse(rawA) as unknown[]) : [];
    storage.removeItem(LEGACY_QUESTS_KEY);
    storage.removeItem(LEGACY_ACHIEVEMENTS_KEY);

    const sanitizedQuests = quests
      .map((q) => sanitizeQuest(q))
      .filter((q): q is Quest => q !== null);

    const sanitizedAchievements = Array.isArray(achievements)
      ? achievements
          .map((a) => sanitizeAchievement(a))
          .filter((a): a is Achievement => a !== null)
      : [];

    return {
      quests: sanitizedQuests,
      achievements: sanitizedAchievements,
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
  options?: LoadQuestBundleOptions,
): PersistedWalletQuestBundle {
  try {
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
  } catch {
    /* private browsing mode or storage blocked — return default template */
  }

  const bundle = migrateQuestBundle(parsedJson, template);

  // Check stale cache options
  if (options?.allowStale === false && isCacheStale(bundle, options?.maxAgeMs)) {
    bundle.quests = cloneQuests(template);
    bundle.lastSyncedAt = null;
  }

  // If read from an older key or corrupted format, migrate and persist under current key
  if (sourceKey && sourceKey !== currentKey) {
    try {
      storage.removeItem(sourceKey);
    } catch {
      /* ignore */
    }
    saveWalletQuestBundle(walletAddress, bundle, storage);
  }

  return bundle;
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

// ── Migration & Recovery Fixtures ──────────────────────────────────────────

export const MIGRATION_FIXTURES = {
  v0Global: {
    sy_quests: JSON.stringify([
      {
        id: "q1",
        title: "First Deposit",
        description: "Deposit USDC.",
        points: 50,
        status: "active",
        badgeContractId: "CBADGE_FIRST_DEPOSIT",
        category: "deposit",
        icon: "Landmark",
        objectives: [
          { id: "o1", description: "Deposit 100 USDC", target: 100, progress: 60, unit: "USDC" },
        ],
      },
    ]),
    sy_achievements: JSON.stringify([
      {
        questId: "q1",
        title: "First Deposit",
        badgeContractId: "CBADGE_FIRST_DEPOSIT",
        mintedAt: 1700000000000,
        txHash: "tx_legacy_001",
      },
    ]),
  },
  v0FlatObjectives: {
    quests: [
      {
        id: "q1",
        title: "First Deposit",
        description: "Deposit USDC.",
        points: 50,
        currentProgress: 85,
        target: 100,
        unit: "USDC",
        completed: false,
      },
    ],
    achievements: [],
  },
  v0LegacyStatus: {
    quests: [
      {
        id: "q1",
        title: "First Deposit",
        objectives: [
          { id: "o1", description: "Deposit 100 USDC", target: 100, progress: 100, unit: "USDC" },
        ],
        completed: true,
        claimed: false,
      },
      {
        id: "q2",
        title: "Diamond Hands",
        objectives: [
          { id: "o2", description: "Hold for 30 days", target: 30, progress: 30, unit: "days" },
        ],
        completed: true,
        claimed: true,
      },
    ],
    achievements: [
      {
        questId: "q2",
        title: "Diamond Hands",
        badgeContractId: "CBADGE_DIAMOND_HANDS",
        mintedAt: 1700000000000,
        txHash: "tx_legacy_002",
      },
    ],
  },
  v1StaleBundle: {
    version: 1,
    quests: [
      {
        id: "q1",
        title: "First Deposit",
        description: "Deposit USDC.",
        points: 50,
        status: "active" as const,
        badgeContractId: "CBADGE_FIRST_DEPOSIT",
        category: "deposit" as const,
        icon: "Landmark",
        objectives: [
          { id: "o1", description: "Deposit 100 USDC", target: 100, progress: 90, unit: "USDC" },
        ],
      },
    ],
    achievements: [],
    lastSyncedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
  },
  partiallyCorrupted: {
    version: 1,
    quests: [
      null,
      "invalid-quest",
      {
        id: "q1",
        title: "First Deposit",
        objectives: [
          {
            id: "o1",
            description: "Deposit 100 USDC",
            target: 100,
            progress: 45,
            unit: "USDC",
          },
        ],
      },
      {
        id: "q2",
        objectives: "not an array",
        status: 12345,
      },
    ],
    achievements: [
      null,
      { questId: "q1", txHash: "tx_valid_1", mintedAt: 1700000000000, title: "First Deposit" },
      { questId: null, txHash: null },
    ],
    lastSyncedAt: "invalid-timestamp",
  },
};
