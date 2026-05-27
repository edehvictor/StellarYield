/**
 * Yield Data Source Registry & Health Dashboard
 *
 * Read-only analytics panel that lists every yield data source with its
 * status, latest fetch time, uptime, latency, and failure reason.
 */

import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw, AlertTriangle } from "lucide-react";
import StatusBadge from "../../components/StatusBadge";
import { apiUrl } from "../../lib/api";
import {
  getSourceStatusDisplay,
  formatLatency,
  formatAge,
  hasUnhealthySources,
  type SourceHealthRegistry,
} from "./sourceHealthStatus";

export default function SourceHealthPanel() {
  const [registry, setRegistry] = useState<SourceHealthRegistry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRegistry = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await fetch(apiUrl("/api/analytics/sources/health"));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = await res.json();
      setRegistry(body.data as SourceHealthRegistry);
    } catch (err) {
      console.error("Failed to fetch source health registry:", err);
      setError(
        err instanceof Error ? err.message : "Failed to fetch source health",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRegistry();
  }, [fetchRegistry]);

  return (
    <div className="glass-panel p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={20} className="text-indigo-400" />
          <h2 className="text-xl font-semibold">Yield Data Source Health</h2>
        </div>
        <button
          type="button"
          onClick={fetchRegistry}
          disabled={isLoading}
          aria-label="Refresh source health"
          className="flex items-center gap-2 text-sm text-gray-300 hover:text-white disabled:opacity-50"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      {!error && isLoading && !registry && (
        <p className="text-sm text-gray-400">Loading source health…</p>
      )}

      {registry && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-400">
              {registry.totalSources} sources ·
            </span>
            <StatusBadge
              variant="success"
              compact
              label={`${registry.counts.healthy} healthy`}
            />
            <StatusBadge
              variant="warning"
              compact
              label={`${registry.counts.degraded} degraded`}
            />
            <StatusBadge
              variant="warning"
              compact
              label={`${registry.counts.stale} stale`}
            />
            <StatusBadge
              variant="danger"
              compact
              label={`${registry.counts.unavailable} unavailable`}
            />
          </div>

          {hasUnhealthySources(registry) && (
            <div className="flex items-center gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-yellow-500" />
              <span className="text-sm text-yellow-400">
                One or more data sources need attention.
              </span>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-white/10">
                  <th className="py-2 pr-4 font-medium">Source</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Uptime</th>
                  <th className="py-2 pr-4 font-medium">Latency</th>
                  <th className="py-2 pr-4 font-medium">Last fetch</th>
                  <th className="py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {registry.sources.map((source) => {
                  const display = getSourceStatusDisplay(source.status);
                  return (
                    <tr
                      key={source.providerId}
                      className="border-b border-white/5"
                    >
                      <td className="py-2 pr-4">
                        <div className="font-medium">{source.providerName}</div>
                        <div className="text-xs text-gray-500">
                          {source.dataSource}
                        </div>
                      </td>
                      <td className="py-2 pr-4">
                        <StatusBadge
                          variant={display.variant}
                          compact
                          label={display.label}
                        />
                      </td>
                      <td className="py-2 pr-4">
                        {source.uptimePct.toFixed(1)}%
                      </td>
                      <td className="py-2 pr-4">
                        {formatLatency(source.latencyMs)}
                      </td>
                      <td className="py-2 pr-4 text-gray-400">
                        {formatAge(source.ageSeconds)}
                      </td>
                      <td className="py-2 text-gray-400">
                        {source.failureReason ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-gray-500">
            Generated {new Date(registry.generatedAt).toLocaleString()} ·
            read-only
          </p>
        </>
      )}
    </div>
  );
}
