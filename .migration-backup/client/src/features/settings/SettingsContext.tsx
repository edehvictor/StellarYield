/**
 * Global transaction settings context.
 * Persists to localStorage and provides settings to all transaction flows.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { TxSettings } from "./types";
import { DEFAULT_TX_SETTINGS, SLIPPAGE_MAX, SLIPPAGE_MIN, DEADLINE_MAX, DEADLINE_MIN } from "./types";
import { loadTxSettings, saveTxSettings } from "./settingsPersistence";

interface SettingsContextValue {
  settings: TxSettings;
  updateSettings: (patch: Partial<TxSettings>) => void;
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<TxSettings>(loadTxSettings);

  useEffect(() => {
    saveTxSettings(settings);
  }, [settings]);

  const updateSettings = useCallback((patch: Partial<TxSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      // Enforce hard limits
      next.customSlippagePct = Math.min(
        Math.max(next.customSlippagePct, SLIPPAGE_MIN),
        SLIPPAGE_MAX,
      );
      next.deadlineMinutes = Math.min(
        Math.max(next.deadlineMinutes, DEADLINE_MIN),
        DEADLINE_MAX,
      );
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_TX_SETTINGS);
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, updateSettings, resetSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

/** Access global transaction settings. Must be used inside <SettingsProvider>. */
export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within <SettingsProvider>");
  return ctx;
}
