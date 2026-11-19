/**
 * Hook for portfolio notification preferences by alert category (issue #1398).
 *
 * Provides typed read/update access to per-category notification settings
 * (enabled, channel, cooldownMinutes) for the connected wallet.
 */

import { useState, useCallback, useEffect } from "react";

export type AlertCategory =
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "ANNOUNCEMENT"
  | "HARVEST";

export interface CategoryPreference {
  category: AlertCategory;
  enabled: boolean;
  channel: "email" | "in_app" | "both";
  cooldownMinutes: number;
}

export interface CategoryPreferenceUpdate {
  enabled?: boolean;
  channel?: "email" | "in_app" | "both";
  cooldownMinutes?: number;
}

export interface CategoryPreferencesState {
  preferences: CategoryPreference[];
  isLoading: boolean;
  error: string | null;
}

export interface CategoryPreferencesActions {
  refresh: () => Promise<void>;
  update: (category: AlertCategory, patch: CategoryPreferenceUpdate) => Promise<void>;
  reset: () => Promise<void>;
}

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001/api";

function prefsUrl(walletAddress: string, category?: AlertCategory): string {
  const base = `${API_BASE}/notifications/category-preferences/${walletAddress}`;
  return category ? `${base}/${category}` : base;
}

export function useNotificationCategoryPreferences(
  walletAddress: string | null | undefined,
): [CategoryPreferencesState, CategoryPreferencesActions] {
  const [preferences, setPreferences] = useState<CategoryPreference[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!walletAddress) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(prefsUrl(walletAddress));
      if (!res.ok) throw new Error(`Failed to load preferences (${res.status})`);
      const data = await res.json();
      setPreferences(data.preferences ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, [walletAddress]);

  const update = useCallback(
    async (category: AlertCategory, patch: CategoryPreferenceUpdate) => {
      if (!walletAddress) return;

      // Optimistic update
      setPreferences((prev) =>
        prev.map((p) => (p.category === category ? { ...p, ...patch } : p)),
      );

      try {
        const res = await fetch(prefsUrl(walletAddress, category), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`Failed to update preference (${res.status})`);
        const updated: CategoryPreference = await res.json();
        setPreferences((prev) =>
          prev.map((p) => (p.category === category ? updated : p)),
        );
      } catch (err) {
        // Revert: re-fetch authoritative state
        await refresh();
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    },
    [walletAddress, refresh],
  );

  const reset = useCallback(async () => {
    if (!walletAddress) return;
    try {
      const res = await fetch(prefsUrl(walletAddress), { method: "DELETE" });
      if (!res.ok) throw new Error(`Failed to reset preferences (${res.status})`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [walletAddress, refresh]);

  useEffect(() => {
    if (walletAddress) {
      void refresh();
    } else {
      setPreferences([]);
      setError(null);
    }
  }, [walletAddress, refresh]);

  return [
    { preferences, isLoading, error },
    { refresh, update, reset },
  ];
}
