import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { WatchlistClientService } from "../services/watchlistClientService";
import {
  loadWalletWatchlistBundle,
  saveWalletWatchlistBundle,
  WATCHLIST_STORAGE_VERSION,
} from "../services/watchlistPersistence";
import type { WatchlistItem } from "../../../shared/types/watchlist";

/**
 * Wallet-scoped watchlist store (#1173). Mirrors the reconnect/switch idiom
 * in client/src/pages/quests/useQuestStore.ts: a null wallet clears local
 * state (no bleed-through), a wallet change restores that wallet's last
 * local snapshot instantly, then refetches from the server (source of
 * truth) and discards the response if the wallet has since changed again.
 */
export function useWatchlistStore(walletAddress: string | null) {
  const walletRef = useRef(walletAddress);
  walletRef.current = walletAddress;

  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [totalUnacknowledgedAlerts, setTotalUnacknowledgedAlerts] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!walletAddress) {
      setItems([]);
      setTotalUnacknowledgedAlerts(0);
      setError(null);
      setLastSyncedAt(null);
      return;
    }

    const bundle = loadWalletWatchlistBundle(walletAddress);
    setItems(bundle.items);
    setLastSyncedAt(bundle.lastSyncedAt);
    setError(null);
  }, [walletAddress]);

  const refresh = useCallback(async (address: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await WatchlistClientService.getWatchlist(address);
      if (walletRef.current !== address) return;
      setItems(result.items);
      setTotalUnacknowledgedAlerts(result.totalUnacknowledgedAlerts);
      setLastSyncedAt(Date.now());
    } catch (e) {
      if (walletRef.current !== address) return;
      setError(e instanceof Error ? e.message : "Failed to load watchlist");
    } finally {
      if (walletRef.current === address) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!walletAddress) return;
    void refresh(walletAddress);
  }, [walletAddress, refresh]);

  useEffect(() => {
    if (!walletAddress) return;
    saveWalletWatchlistBundle(walletAddress, {
      version: WATCHLIST_STORAGE_VERSION,
      items,
      lastSyncedAt,
    });
  }, [walletAddress, items, lastSyncedAt]);

  const removeItem = useCallback(
    async (itemId: string) => {
      if (!walletAddress) return;
      try {
        await WatchlistClientService.removeFromWatchlist(walletAddress, itemId);
        setItems((prev) => prev.filter((item) => item.id !== itemId));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to remove from watchlist");
      }
    },
    [walletAddress]
  );

  const addThresholdRule = useCallback(
    async (
      itemId: string,
      ruleType: "apy_above" | "apy_below" | "tvl_above" | "tvl_below" | "spread_change_above",
      value: number,
      triggerOnce: boolean
    ) => {
      if (!walletAddress) return;
      try {
        await WatchlistClientService.addThresholdRule(walletAddress, itemId, ruleType, value, triggerOnce);
        await refresh(walletAddress);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to add rule");
      }
    },
    [walletAddress, refresh]
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    items,
    totalUnacknowledgedAlerts,
    loading,
    error,
    removeItem,
    addThresholdRule,
    clearError,
  };
}
