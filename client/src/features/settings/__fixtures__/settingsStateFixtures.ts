import { DEFAULT_TX_SETTINGS } from "../types";

/** Partial legacy state missing deadlineMinutes. */
export const LEGACY_PARTIAL_V0 = {
  slippageMode: "custom" as const,
  customSlippagePct: 2.5,
};

/** Legacy state with renamed or unrelated keys that should be ignored. */
export const LEGACY_WITH_UNKNOWN_KEYS = {
  slippageMode: "custom" as const,
  customSlippagePct: 1.0,
  deadlineMinutes: 15,
  oldSlippageTolerance: 0.5,
  theme: "dark",
};

/** Empty persisted object should upgrade to full defaults. */
export const LEGACY_EMPTY_OBJECT = {};

/** Simulated next-release field absent from older stored blobs. */
export const LEGACY_BEFORE_NEW_FIELD = {
  slippageMode: "auto" as const,
  customSlippagePct: DEFAULT_TX_SETTINGS.customSlippagePct,
};

export const LEGACY_INVALID_JSON = "not-json";
