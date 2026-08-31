import { describe, it, expect } from "vitest";
import { DEFAULT_TX_SETTINGS } from "./types";
import {
  LEGACY_BEFORE_NEW_FIELD,
  LEGACY_EMPTY_OBJECT,
  LEGACY_INVALID_JSON,
  LEGACY_PARTIAL_V0,
  LEGACY_WITH_UNKNOWN_KEYS,
} from "./__fixtures__/settingsStateFixtures";
import {
  TX_SETTINGS_STORAGE_KEY,
  loadTxSettings,
  parseTxSettings,
  saveTxSettings,
  serializeTxSettings,
} from "./settingsPersistence";

function mockStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    getItem(key: string) {
      return store[key] ?? null;
    },
    setItem(key: string, value: string) {
      store[key] = value;
    },
    snapshot() {
      return { ...store };
    },
  };
}

describe("parseTxSettings", () => {
  it("fills defaults for missing preference keys", () => {
    const settings = parseTxSettings(JSON.stringify(LEGACY_PARTIAL_V0));
    expect(settings.slippageMode).toBe("custom");
    expect(settings.customSlippagePct).toBe(2.5);
    expect(settings.deadlineMinutes).toBe(DEFAULT_TX_SETTINGS.deadlineMinutes);
  });

  it("preserves known values and strips unknown keys", () => {
    const settings = parseTxSettings(JSON.stringify(LEGACY_WITH_UNKNOWN_KEYS));
    expect(settings).toEqual({
      slippageMode: "custom",
      customSlippagePct: 1.0,
      deadlineMinutes: 15,
    });
    expect(settings).not.toHaveProperty("oldSlippageTolerance");
    expect(settings).not.toHaveProperty("theme");
  });

  it("returns defaults for empty persisted object", () => {
    expect(parseTxSettings(JSON.stringify(LEGACY_EMPTY_OBJECT))).toEqual(DEFAULT_TX_SETTINGS);
  });

  it("returns defaults for invalid JSON", () => {
    expect(parseTxSettings(LEGACY_INVALID_JSON)).toEqual(DEFAULT_TX_SETTINGS);
  });

  it("keeps existing choices when a new field is introduced via defaults", () => {
    const settings = parseTxSettings(JSON.stringify(LEGACY_BEFORE_NEW_FIELD));
    expect(settings.slippageMode).toBe("auto");
    expect(settings.deadlineMinutes).toBe(DEFAULT_TX_SETTINGS.deadlineMinutes);
  });
});

describe("serializeTxSettings", () => {
  it("writes only canonical keys to storage", () => {
    const serialized = serializeTxSettings({
      slippageMode: "custom",
      customSlippagePct: 1.5,
      deadlineMinutes: 10,
    });
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "customSlippagePct",
      "deadlineMinutes",
      "slippageMode",
    ]);
  });
});

describe("loadTxSettings / saveTxSettings", () => {
  it("migrates legacy partial state without wiping saved slippage", () => {
    const storage = mockStorage({
      [TX_SETTINGS_STORAGE_KEY]: JSON.stringify(LEGACY_PARTIAL_V0),
    });
    const loaded = loadTxSettings(storage);
    expect(loaded.customSlippagePct).toBe(2.5);
    expect(loaded.deadlineMinutes).toBe(DEFAULT_TX_SETTINGS.deadlineMinutes);
  });

  it("persists canonical shape after save", () => {
    const storage = mockStorage();
    saveTxSettings(
      { slippageMode: "custom", customSlippagePct: 3, deadlineMinutes: 25 },
      storage,
    );
    const raw = storage.snapshot()[TX_SETTINGS_STORAGE_KEY];
    expect(JSON.parse(raw)).toEqual({
      slippageMode: "custom",
      customSlippagePct: 3,
      deadlineMinutes: 25,
    });
  });
});
