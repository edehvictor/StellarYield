import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { apiUrl } from "../../lib/api";

interface OutageWindow {
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number;
}

interface ProviderUptimeReport {
  providerId: string;
  providerName: string;
  uptimePct: number;
  downtimePct: number;
  unknownPct: number;
  sampleCount: number;
  outageWindowCount: number;
  totalOutageMinutes: number;
  recentOutages: OutageWindow[];
  generatedAt: string;
}

interface UptimeResponse {
  success: boolean;
  data: ProviderUptimeReport[];
  generatedAt: string;
}

function UptimeBar({ pct }: { pct: number }) {
  const color = pct >= 99 ? "bg-green-500" : pct >= 95 ? "bg-amber-400" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span
        className={`text-xs font-mono w-12 text-right ${
          pct >= 99 ? "text-green-400" : pct >= 95 ? "text-amber-400" : "text-red-400"
        }`}
      >
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

function OutageList({ outages }: { outages: OutageWindow[] }) {
  if (outages.length === 0) {
    return <span className="text-xs text-gray-500">No recent outages</span>;
  }
  return (
    <ul className="space-y-1">
      {outages.map((o, i) => (
        <li key={i} className="text-xs text-gray-400">
          {new Date(o.startedAt).toLocaleDateString()} —{" "}
          {o.endedAt ? new Date(o.endedAt).toLocaleDateString() : "ongoing"},{" "}
          {o.durationMinutes}m
          {o.endedAt === null && (
            <span className="ml-1 text-red-400 font-medium">(ongoing)</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function ProviderUptimeReport() {
  const [reports, setReports] = useState<ProviderUptimeReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await fetch(apiUrl("/api/analytics/providers/uptime"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as UptimeResponse;
      setReports(body.data);
      setGeneratedAt(body.generatedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load uptime report");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchReports();
  }, [fetchReports]);

  const hasOutages = reports.some((r) => r.outageWindowCount > 0);

  return (
    <div className="glass-panel p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={20} className="text-indigo-400" />
          <h2 className="text-xl font-semibold">Provider Uptime Report</h2>
        </div>
        <button
          type="button"
          onClick={() => void fetchReports()}
          disabled={isLoading}
          aria-label="Refresh uptime report"
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

      {!error && isLoading && reports.length === 0 && (
        <p className="text-sm text-gray-400">Loading uptime data…</p>
      )}

      {hasOutages && (
        <div className="flex items-center gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-yellow-500" />
          <span className="text-sm text-yellow-400">
            One or more providers have recent outage windows.
          </span>
        </div>
      )}

      {reports.length > 0 && (
        <div className="space-y-2">
          {reports.map((r) => (
            <div
              key={r.providerId}
              className="bg-white/5 rounded-xl p-4 space-y-2"
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-white">{r.providerName}</p>
                  <p className="text-xs text-gray-500">{r.providerId}</p>
                </div>
                <div className="flex-1 max-w-xs">
                  <UptimeBar pct={r.uptimePct} />
                </div>
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === r.providerId ? null : r.providerId)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 whitespace-nowrap"
                >
                  {expanded === r.providerId ? "Hide" : "Details"}
                </button>
              </div>

              {expanded === r.providerId && (
                <div className="pt-2 border-t border-white/10 space-y-3">
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div>
                      <p className="text-gray-500">Downtime</p>
                      <p className="text-white font-mono">{r.downtimePct.toFixed(1)}%</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Samples</p>
                      <p className="text-white font-mono">{r.sampleCount}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Total outage</p>
                      <p className="text-white font-mono">{r.totalOutageMinutes}m</p>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">
                      Recent outages ({r.outageWindowCount} total, showing last 5)
                    </p>
                    <OutageList outages={r.recentOutages} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {reports.length === 0 && !isLoading && !error && (
        <p className="text-sm text-gray-500">No provider uptime data available yet.</p>
      )}

      {generatedAt && (
        <p className="text-xs text-gray-500">
          Generated {new Date(generatedAt).toLocaleString()} · read-only
        </p>
      )}
    </div>
  );
}
