import { useState, useCallback } from "react";
import type {
  WatchlistRule,
  CreateWatchlistRulePayload,
  UpdateWatchlistRulePayload,
} from "./types";

const API_BASE = "/api/watchlist";

export function useWatchlist(walletAddress: string) {
  const [rules, setRules] = useState<WatchlistRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRules = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}?userId=${encodeURIComponent(walletAddress)}`);
      if (!res.ok) throw new Error("Failed to fetch watchlist");
      const data = await res.json();
      setRules(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  const addRule = useCallback(async (payload: CreateWatchlistRulePayload) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(API_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": walletAddress,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to create rule");
      const rule = await res.json();
      setRules((prev) => [rule, ...prev]);
      return rule;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      return null;
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  const updateRule = useCallback(async (
    ruleId: string,
    payload: UpdateWatchlistRulePayload,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/${ruleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to update rule");
      const updated = await res.json();
      setRules((prev) => prev.map((r) => r.id === ruleId ? updated : r));
      return updated;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const removeRule = useCallback(async (ruleId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/${ruleId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete rule");
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const evaluateRules = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/evaluate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": walletAddress,
        },
        body: JSON.stringify({ userId: walletAddress }),
      });
      if (!res.ok) throw new Error("Failed to evaluate rules");
      return await res.json();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      return [];
    }
  }, [walletAddress]);

  return {
    rules,
    loading,
    error,
    fetchRules,
    addRule,
    updateRule,
    removeRule,
    evaluateRules,
  };
}