/**
 * Settings persistence and migration for transaction preferences.
 */
import type { TxSettings } from "./types";
import {
  DEFAULT_TX_SETTINGS,
  DEADLINE_MAX,
  DEADLINE_MIN,
  SLIPPAGE_MAX,
  SLIPPAGE_MIN,
} from "./types";

export const TX_SETTINGS_STORAGE_KEY = "stellar_yield_tx_settings";

const KNOWN_KEYS = ["slippageMode", "customSlippagePct", "deadlineMinutes"] as const;

type KnownKey = (typeof KNOWN_KEYS)[number];

function clampSlippage(value: number): number {
  return Math.min(Math.max(value, SLIPPAGE_MIN), SLIPPAGE_MAX);
}

function clampDeadline(value: number): number {
  return Math.min(Math.max(value, DEADLINE_MIN), DEADLINE_MAX);
}

function pickKnownFields(raw: Record<string, unknown>): Partial<TxSettings> {
  const picked: Partial<TxSettings> = {};
  for (const key of KNOWN_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (key === "slippageMode" && (value === "auto" || value === "custom")) {
      picked.slippageMode = value;
    } else if (key === "customSlippagePct" && typeof value === "number" && Number.isFinite(value)) {
      picked.customSlippagePct = clampSlippage(value);
    } else if (key === "deadlineMinutes" && typeof value === "number" && Number.isFinite(value)) {
      picked.deadlineMinutes = clampDeadline(value);
    }
  }
  return picked;
}

/** Parse and migrate stored settings, filling defaults and dropping unknown keys. */
export function parseTxSettings(raw: string | null): TxSettings {
  if (!raw) return { ...DEFAULT_TX_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_TX_SETTINGS };
    }
    return { ...DEFAULT_TX_SETTINGS, ...pickKnownFields(parsed) };
  } catch {
    return { ...DEFAULT_TX_SETTINGS };
  }
}

/** Serialize canonical settings (known keys only). */
export function serializeTxSettings(settings: TxSettings): string {
  const canonical: Pick<TxSettings, KnownKey> = {
    slippageMode: settings.slippageMode,
    customSlippagePct: settings.customSlippagePct,
    deadlineMinutes: settings.deadlineMinutes,
  };
  return JSON.stringify(canonical);
}

export function loadTxSettings(storage: Pick<Storage, "getItem"> = localStorage): TxSettings {
  return parseTxSettings(storage.getItem(TX_SETTINGS_STORAGE_KEY));
}

export function saveTxSettings(
  settings: TxSettings,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(TX_SETTINGS_STORAGE_KEY, serializeTxSettings(settings));
}
