/**
 * Transaction settings persisted to localStorage and shared via React Context.
 */

/** Hard limits enforced in the UI to prevent accidental misconfiguration. */
export const SLIPPAGE_MIN = 0.01; // 0.01%
export const SLIPPAGE_MAX = 5.0;  // 5% hard cap
export const DEADLINE_MIN = 1;    // 1 minute
export const DEADLINE_MAX = 60;   // 60 minutes

export type SlippageMode = "auto" | "custom";

export interface TxSettings {
  /** "auto" uses the app default; "custom" uses `customSlippagePct`. */
  slippageMode: SlippageMode;
  /** Active when slippageMode === "custom". Clamped to [SLIPPAGE_MIN, SLIPPAGE_MAX]. */
  customSlippagePct: number;
  /** Transaction deadline in minutes. Clamped to [DEADLINE_MIN, DEADLINE_MAX]. */
  deadlineMinutes: number;
}

export const DEFAULT_TX_SETTINGS: TxSettings = {
  slippageMode: "auto",
  customSlippagePct: 0.5,
  deadlineMinutes: 20,
};

/** Auto-mode preset values shown as quick-select buttons. */
export const AUTO_SLIPPAGE_PRESETS = [0.1, 0.5, 1.0] as const;

/**
 * Resolve the effective slippage percentage from settings.
 * Auto mode returns 0.5% (balanced default).
 */
export function resolveSlippage(settings: TxSettings): number {
  if (settings.slippageMode === "auto") return 0.5;
  return Math.min(Math.max(settings.customSlippagePct, SLIPPAGE_MIN), SLIPPAGE_MAX);
}

/**
 * Resolve the effective deadline in seconds from settings.
 */
export function resolveDeadlineSeconds(settings: TxSettings): number {
  const minutes = Math.min(Math.max(settings.deadlineMinutes, DEADLINE_MIN), DEADLINE_MAX);
  return minutes * 60;
}
