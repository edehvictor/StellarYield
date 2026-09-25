import { useCallback, useEffect, useState } from "react";

export const TIME_WINDOWS = ["all", "24h", "7d", "30d"] as const;
export const STRATEGY_TYPES = ["all", "blend", "soroswap", "defindex"] as const;

export type TimeWindow = (typeof TIME_WINDOWS)[number];
export type StrategyType = (typeof STRATEGY_TYPES)[number];

export interface LeaderboardFilters {
  timeWindow: TimeWindow;
  strategyType: StrategyType;
}

const STORAGE_KEY = "stellar_yield.leaderboard_filters";
const DEFAULTS: LeaderboardFilters = { timeWindow: "all", strategyType: "all" };

function isValidTimeWindow(v: unknown): v is TimeWindow {
  return TIME_WINDOWS.includes(v as TimeWindow);
}

function isValidStrategyType(v: unknown): v is StrategyType {
  return STRATEGY_TYPES.includes(v as StrategyType);
}

function loadFilters(): LeaderboardFilters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return DEFAULTS;
    const { timeWindow, strategyType } = parsed as Record<string, unknown>;
    return {
      timeWindow: isValidTimeWindow(timeWindow) ? timeWindow : DEFAULTS.timeWindow,
      strategyType: isValidStrategyType(strategyType) ? strategyType : DEFAULTS.strategyType,
    };
  } catch {
    return DEFAULTS;
  }
}

function saveFilters(filters: LeaderboardFilters): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Storage may be unavailable (private browsing quota exceeded, etc.)
  }
}

export interface UseLeaderboardFiltersReturn {
  timeWindow: TimeWindow;
  strategyType: StrategyType;
  setTimeWindow: (v: TimeWindow) => void;
  setStrategyType: (v: StrategyType) => void;
  resetFilters: () => void;
  isDefault: boolean;
}

export function useLeaderboardFilters(): UseLeaderboardFiltersReturn {
  const [filters, setFilters] = useState<LeaderboardFilters>(loadFilters);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  const setTimeWindow = useCallback((v: TimeWindow) => {
    setFilters((prev) => ({ ...prev, timeWindow: v }));
  }, []);

  const setStrategyType = useCallback((v: StrategyType) => {
    setFilters((prev) => ({ ...prev, strategyType: v }));
  }, []);

  const resetFilters = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setFilters(DEFAULTS);
  }, []);

  const isDefault =
    filters.timeWindow === DEFAULTS.timeWindow &&
    filters.strategyType === DEFAULTS.strategyType;

  return {
    timeWindow: filters.timeWindow,
    strategyType: filters.strategyType,
    setTimeWindow,
    setStrategyType,
    resetFilters,
    isDefault,
  };
}
