/**
 * StrategyComparisonCard
 *
 * Renders a single strategy's comparison details. Each risk field (score,
 * volatility, liquidity, freshness) has an explicit missing-data state so
 * incomplete strategies degrade gracefully without collapsing the card or
 * confusing the user with blank cells.
 *
 * Cards with complete risk data show full comparison details.
 * Cards with partial or missing data show labelled "—" placeholders and a
 * prominent notice so users understand why some numbers are absent.
 */

import { AlertTriangle, Clock, Activity, Droplets, ShieldCheck, ShieldAlert, HelpCircle } from "lucide-react";
import type { StrategyComparison, StrategyRiskData, RiskLabel, DataFreshness } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────

const RISK_LABEL_STYLE: Record<RiskLabel, string> = {
  Low: "bg-green-500/20 text-green-400 border-green-500/30",
  Medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  High: "bg-red-500/20 text-red-400 border-red-500/30",
};

const FRESHNESS_STYLE: Record<DataFreshness, { cls: string; label: string }> = {
  fresh: { cls: "text-green-400", label: "Fresh" },
  stale: { cls: "text-yellow-400", label: "Stale" },
  unavailable: { cls: "text-gray-500", label: "Unavailable" },
};

function formatLiquidity(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${usd.toFixed(0)}`;
}

// ── Sub-components ────────────────────────────────────────────────────────

/** Single metric cell with an optional missing-data state. */
function MetricCell({
  label,
  value,
  icon: Icon,
  missing = false,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ElementType;
  missing?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <div className="flex items-center gap-1 text-xs text-gray-500">
        <Icon size={11} aria-hidden="true" />
        {label}
      </div>
      {missing ? (
        <span
          className="text-sm text-gray-600 font-medium"
          aria-label={`${label} data unavailable`}
        >
          —
        </span>
      ) : (
        <span className="text-sm font-medium text-gray-200">{value}</span>
      )}
    </div>
  );
}

/** Risk score badge — full pill when data available, muted placeholder when not. */
function RiskScoreBadge({ risk }: { risk: StrategyRiskData | null }) {
  if (!risk || risk.riskScore === null || risk.riskLabel === null) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-700/50 text-gray-500 border border-gray-600/30"
        aria-label="Risk score unavailable"
      >
        <HelpCircle size={11} aria-hidden="true" />
        No score
      </span>
    );
  }

  const RiskIcon = risk.riskLabel === "Low" ? ShieldCheck : ShieldAlert;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${RISK_LABEL_STYLE[risk.riskLabel]}`}
      aria-label={`Risk: ${risk.riskLabel} (${risk.riskScore}/10)`}
    >
      <RiskIcon size={11} aria-hidden="true" />
      {risk.riskLabel} · {risk.riskScore}/10
    </span>
  );
}

/** Inline notice shown when one or more risk fields are missing. */
function MissingDataNotice({ risk }: { risk: StrategyRiskData | null }) {
  if (!risk) {
    return (
      <div
        role="note"
        className="flex items-start gap-2 p-2.5 rounded-lg bg-gray-700/30 border border-gray-600/20 text-xs text-gray-400"
      >
        <AlertTriangle size={13} className="shrink-0 text-yellow-500 mt-0.5" aria-hidden="true" />
        Risk data is not available for this strategy. Comparison metrics will
        appear once data is received.
      </div>
    );
  }

  const missingFields: string[] = [];
  if (risk.riskScore === null) missingFields.push("risk score");
  if (risk.volatilityPct === null) missingFields.push("volatility");
  if (risk.liquidityUsd === null) missingFields.push("liquidity");
  if (risk.freshness === "unavailable") missingFields.push("data feed");

  if (missingFields.length === 0) return null;

  return (
    <div
      role="note"
      className="flex items-start gap-2 p-2.5 rounded-lg bg-yellow-500/5 border border-yellow-500/20 text-xs text-yellow-300"
    >
      <AlertTriangle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
      <span>
        Missing:{" "}
        <span className="font-medium">
          {missingFields.join(", ")}
        </span>
        . These fields will update when the data feed is restored.
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export interface StrategyComparisonCardProps {
  strategy: StrategyComparison;
  /** Highlight this card as selected/active. */
  isSelected?: boolean;
  onClick?: (id: string) => void;
}

export default function StrategyComparisonCard({
  strategy,
  isSelected = false,
  onClick,
}: StrategyComparisonCardProps) {
  const { id, name, strategyType, apy, risk } = strategy;

  const freshnessCfg = risk
    ? FRESHNESS_STYLE[risk.freshness]
    : FRESHNESS_STYLE.unavailable;

  const hasAnyMissingData =
    !risk ||
    risk.riskScore === null ||
    risk.volatilityPct === null ||
    risk.liquidityUsd === null ||
    risk.freshness === "unavailable";

  return (
    <article
      aria-selected={isSelected}
      aria-label={`Strategy: ${name}`}
      onClick={() => onClick?.(id)}
      className={`
        glass-panel p-4 space-y-3 transition-all cursor-pointer
        hover:ring-1 hover:ring-indigo-500/40
        ${isSelected ? "ring-2 ring-indigo-500/60 bg-indigo-500/5" : ""}
        ${onClick ? "cursor-pointer" : "cursor-default"}
      `}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-semibold text-sm text-white truncate">{name}</h4>
          <p className="text-xs text-gray-500 mt-0.5 capitalize">{strategyType}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-bold text-green-400 tabular-nums">
            {apy.toFixed(2)}%
          </p>
          <p className="text-xs text-gray-500">APY</p>
        </div>
      </div>

      {/* Risk score badge */}
      <div>
        <RiskScoreBadge risk={risk} />
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-3 gap-3 pt-1">
        <MetricCell
          label="Volatility"
          icon={Activity}
          missing={!risk || risk.volatilityPct === null}
          value={`${risk?.volatilityPct?.toFixed(1)}%`}
        />
        <MetricCell
          label="Liquidity"
          icon={Droplets}
          missing={!risk || risk.liquidityUsd === null}
          value={risk?.liquidityUsd !== null && risk?.liquidityUsd !== undefined
            ? formatLiquidity(risk.liquidityUsd)
            : null}
        />
        <MetricCell
          label="Freshness"
          icon={Clock}
          missing={!risk || risk.freshness === "unavailable"}
          value={
            <span className={freshnessCfg.cls}>{freshnessCfg.label}</span>
          }
        />
      </div>

      {/* Missing-data notice */}
      {hasAnyMissingData && <MissingDataNotice risk={risk} />}
    </article>
  );
}
