/**
 * Portfolio notification preferences by alert category (issue #1398).
 *
 * Stores per-wallet, per-category notification preferences. Backed by an
 * in-memory map so no schema migration is required; the interface is designed
 * to be drop-in replaceable with a Prisma-backed store later.
 */

/** Alert categories that map to Notification.type values. */
export type AlertCategory =
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "ANNOUNCEMENT"
  | "HARVEST";

export const ALERT_CATEGORIES: readonly AlertCategory[] = [
  "DEPOSIT",
  "WITHDRAWAL",
  "ANNOUNCEMENT",
  "HARVEST",
];

export interface CategoryPreference {
  category: AlertCategory;
  enabled: boolean;
  channel: "email" | "in_app" | "both";
  cooldownMinutes: number;
}

export interface WalletCategoryPreferences {
  walletAddress: string;
  preferences: CategoryPreference[];
  updatedAt: string;
}

const DEFAULT_PREFERENCE: Omit<CategoryPreference, "category"> = {
  enabled: true,
  channel: "in_app",
  cooldownMinutes: 60,
};

const VALID_CHANNELS = new Set<string>(["email", "in_app", "both"]);

// ── In-memory store ───────────────────────────────────────────────────────────

const store = new Map<string, Map<AlertCategory, CategoryPreference>>();

function ensureWallet(walletAddress: string): Map<AlertCategory, CategoryPreference> {
  if (!store.has(walletAddress)) {
    const prefs = new Map<AlertCategory, CategoryPreference>();
    for (const category of ALERT_CATEGORIES) {
      prefs.set(category, { category, ...DEFAULT_PREFERENCE });
    }
    store.set(walletAddress, prefs);
  }
  return store.get(walletAddress)!;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getAllCategoryPreferences(
  walletAddress: string,
): WalletCategoryPreferences {
  const prefs = ensureWallet(walletAddress);
  return {
    walletAddress,
    preferences: ALERT_CATEGORIES.map((c) => prefs.get(c)!),
    updatedAt: new Date().toISOString(),
  };
}

export function getCategoryPreference(
  walletAddress: string,
  category: AlertCategory,
): CategoryPreference {
  const prefs = ensureWallet(walletAddress);
  return prefs.get(category)!;
}

export interface CategoryPreferenceUpdate {
  enabled?: boolean;
  channel?: "email" | "in_app" | "both";
  cooldownMinutes?: number;
}

export interface ValidationError {
  field: string;
  message: string;
}

export function validateCategoryPreferenceUpdate(
  update: unknown,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (typeof update !== "object" || update === null) {
    errors.push({ field: "body", message: "Request body must be an object." });
    return errors;
  }
  const u = update as Record<string, unknown>;

  if ("enabled" in u && typeof u.enabled !== "boolean") {
    errors.push({ field: "enabled", message: "enabled must be a boolean." });
  }
  if ("channel" in u && !VALID_CHANNELS.has(String(u.channel))) {
    errors.push({
      field: "channel",
      message: "channel must be email, in_app, or both.",
    });
  }
  if ("cooldownMinutes" in u) {
    const v = u.cooldownMinutes;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1440) {
      errors.push({
        field: "cooldownMinutes",
        message: "cooldownMinutes must be a number between 0 and 1440.",
      });
    }
  }
  return errors;
}

export function updateCategoryPreference(
  walletAddress: string,
  category: AlertCategory,
  update: CategoryPreferenceUpdate,
): CategoryPreference {
  const prefs = ensureWallet(walletAddress);
  const current = prefs.get(category)!;
  const updated: CategoryPreference = {
    ...current,
    ...(update.enabled !== undefined && { enabled: update.enabled }),
    ...(update.channel !== undefined && { channel: update.channel }),
    ...(update.cooldownMinutes !== undefined && {
      cooldownMinutes: update.cooldownMinutes,
    }),
  };
  prefs.set(category, updated);
  return updated;
}

/** Resets all preferences for a wallet to defaults. */
export function resetCategoryPreferences(walletAddress: string): void {
  store.delete(walletAddress);
}
