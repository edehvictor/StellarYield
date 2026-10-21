import React from "react";
import { Database, HelpCircle, Clock, Percent, Coins, Building2 } from "lucide-react";
import type { ZapQuoteRouteAssumptions } from "../../../../shared/types/routeAssumptions";

export interface RouteAssumptionsPanelProps {
  /** Route assumptions attached to the current quote, when present. */
  assumptions?: ZapQuoteRouteAssumptions | null;
  /** Additional custom class names. */
  className?: string;
}

/** Formats seconds into a compact human-readable age (e.g. "45s", "12m"). */
function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Renders one assumption group with an explicit value or "unavailable"
 * state. Kept tiny and declarative so partial data degrades predictably:
 * null group → dashed "unavailable" chip, never a crash or a fake zero.
 */
function AssumptionRow({
  label,
  icon,
  value,
  isUnavailable,
}: {
  label: string;
  icon: React.ReactNode;
  value: React.ReactNode;
  isUnavailable: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-2 py-1">
      <span className="flex items-center gap-1.5 text-[11px] text-gray-400">
        {icon}
        {label}
      </span>
      {isUnavailable ? (
        <span
          className="rounded border border-dashed border-white/15 px-1.5 py-0.5 text-[10px] text-gray-500"
          title="This assumption could not be resolved for the current quote."
        >
          unavailable
        </span>
      ) : (
        <span className="text-right text-[11px] text-gray-200">{value}</span>
      )}
    </div>
  );
}

/**
 * Quote preview panel showing why a yield route was priced the way it was:
 * provider, asset, APY source, fee schedule, and data freshness. Renders only
 * when the server attached route assumptions to the quote; otherwise renders
 * nothing so older server responses keep the existing UI.
 */
export function RouteAssumptionsPanel({
  assumptions,
  className = "",
}: RouteAssumptionsPanelProps) {
  if (!assumptions) return null;

  const unavailable = new Set(assumptions.unavailableFields);

  return (
    <div
      data-testid="route-assumptions-panel"
      className={`rounded-xl border border-white/10 bg-white/5 p-3.5 backdrop-blur-md ${className}`}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <Database className="h-3.5 w-3.5 text-blue-400" />
        <span className="text-xs font-semibold text-gray-200">Route assumptions</span>
        <span className="text-[10px] text-gray-500">
          inputs behind this quote
        </span>
      </div>

      <div className="divide-y divide-white/5">
        <AssumptionRow
          label="Provider"
          icon={<Building2 className="h-3 w-3" />}
          isUnavailable={assumptions.provider === null || unavailable.has("provider")}
          value={assumptions.provider?.providerName ?? null}
        />
        <AssumptionRow
          label="Asset"
          icon={<Coins className="h-3 w-3" />}
          isUnavailable={assumptions.asset === null || unavailable.has("asset")}
          value={assumptions.asset?.symbol ?? null}
        />
        <AssumptionRow
          label="APY source"
          icon={<Percent className="h-3 w-3" />}
          isUnavailable={assumptions.apySource === null || unavailable.has("apySource")}
          value={
            assumptions.apySource ? (
              <span>
                {assumptions.apySource.source}
                {assumptions.apySource.totalApy !== undefined && (
                  <span className="ml-1 text-gray-400">
                    ({assumptions.apySource.totalApy.toFixed(2)}% APY)
                  </span>
                )}
              </span>
            ) : null
          }
        />
        <AssumptionRow
          label="Fee schedule"
          icon={<HelpCircle className="h-3 w-3" />}
          isUnavailable={assumptions.fee === null || unavailable.has("fee")}
          value={
            assumptions.fee ? (
              <span>
                {assumptions.fee.protocolFeeBps !== undefined &&
                  `${formatBps(assumptions.fee.protocolFeeBps)} protocol`}
                {assumptions.fee.managementFeeBps !== undefined &&
                  assumptions.fee.performanceFeeBps !== undefined && (
                    <span className="ml-1 text-gray-400">
                      ({formatBps(assumptions.fee.managementFeeBps)} mgmt +{" "}
                      {formatBps(assumptions.fee.performanceFeeBps)} perf)
                    </span>
                  )}
              </span>
            ) : null
          }
        />
        <AssumptionRow
          label="Data freshness"
          icon={<Clock className="h-3 w-3" />}
          isUnavailable={assumptions.freshness === null || unavailable.has("freshness")}
          value={
            assumptions.freshness ? (
              <span
                className={
                  assumptions.freshness.isStale ? "text-amber-400" : "text-gray-200"
                }
              >
                {formatAge(assumptions.freshness.ageSeconds)} old
                {assumptions.freshness.isStale && (
                  <span className="ml-1 text-[10px]">(stale)</span>
                )}
              </span>
            ) : null
          }
        />
      </div>

      {assumptions.freshness?.isStale && (
        <p className="mt-1.5 text-[10px] text-amber-300/80">
          Underlying yield data is older than the freshness window — APY and fee
          figures may shift before execution.
        </p>
      )}
    </div>
  );
}

export default RouteAssumptionsPanel;
