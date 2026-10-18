/**
 * StrategyComparisonGrid
 *
 * Renders a sortable grid of StrategyComparisonCards.  Strategies with
 * incomplete risk data are sorted to the bottom of the list (preserving the
 * order of complete rows) so the most useful comparisons are always visible.
 */

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import StrategyComparisonCard from "./StrategyComparisonCard";
import { sortStrategies } from "./strategySort";
import type { StrategyComparison, StrategyComparisonSortKey } from "./types";

export interface StrategyComparisonGridProps {
  strategies: StrategyComparison[];
  onStrategySelect?: (id: string) => void;
  selectedId?: string;
}

interface SortState {
  key: StrategyComparisonSortKey;
  direction: "asc" | "desc";
}

const SORT_OPTIONS: { key: StrategyComparisonSortKey; label: string }[] = [
  { key: "apy", label: "APY" },
  { key: "riskScore", label: "Risk Score" },
  { key: "volatilityPct", label: "Volatility" },
  { key: "liquidityUsd", label: "Liquidity" },
];

export default function StrategyComparisonGrid({
  strategies,
  onStrategySelect,
  selectedId,
}: StrategyComparisonGridProps) {
  const [sort, setSort] = useState<SortState>({ key: "apy", direction: "desc" });

  const sorted = sortStrategies(strategies, sort.key, sort.direction);

  function handleSortClick(key: StrategyComparisonSortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" },
    );
  }

  if (strategies.length === 0) {
    return (
      <div className="glass-panel p-8 text-center text-gray-500 text-sm">
        No strategies available for comparison.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Sort controls */}
      <div className="flex flex-wrap items-center gap-2" aria-label="Sort strategies by">
        <span className="text-xs text-gray-500 mr-1">Sort by:</span>
        {SORT_OPTIONS.map(({ key, label }) => {
          const active = sort.key === key;
          const Icon = sort.direction === "desc" ? ChevronDown : ChevronUp;
          return (
            <button
              key={key}
              type="button"
              onClick={() => handleSortClick(key)}
              aria-pressed={active}
              className={`
                inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border transition-colors
                ${active
                  ? "bg-indigo-500/20 border-indigo-500/40 text-indigo-300"
                  : "bg-white/5 border-white/10 text-gray-400 hover:text-white hover:border-white/20"}
              `}
            >
              {label}
              {active && <Icon size={11} aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      {/* Cards */}
      <div
        className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        aria-label="Strategy comparison grid"
      >
        {sorted.map((strategy) => (
          <StrategyComparisonCard
            key={strategy.id}
            strategy={strategy}
            isSelected={strategy.id === selectedId}
            onClick={onStrategySelect}
          />
        ))}
      </div>
    </div>
  );
}
