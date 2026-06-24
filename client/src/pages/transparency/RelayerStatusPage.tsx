import { useState, useEffect } from "react";
import {
  Loader2,
  Radio,
  CheckCircle2,
  XCircle,
  Clock,
  ShieldCheck,
  Activity,
  AlertTriangle,
} from "lucide-react";
import { getApiBaseUrl } from "../../lib/api";

const getApiBase = () => {
  try {
    return getApiBaseUrl();
  } catch {
    return "";
  }
};

// ── Types ─────────────────────────────────────────────────────────────────

interface RelayEvent {
  id: string;
  timestamp: string;
  status: "success" | "failed" | "pending";
  innerTxHash?: string;
  feeBumpHash?: string;
  error?: string;
  durationMs: number;
}

interface ReplayProtectionStatus {
  enabled: boolean;
  trackedHashes: number;
  oldestHashAge: string | null;
  deduplicationWindow: string;
}

interface RelayerStatus {
  isOnline: boolean;
  network: string;
  queueDepth: number;
  totalRelayed: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  lastRelayAt: string | null;
  recentEvents: RelayEvent[];
  replayProtection: ReplayProtectionStatus;
  uptime: string;
  checkedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

// ── Sub-components ────────────────────────────────────────────────────────

function MetricCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className={`rounded-xl bg-gray-800/50 border border-gray-700/50 p-4 flex items-center gap-3`}>
      <span className={`w-10 h-10 rounded-full bg-${accent}-500/20 flex items-center justify-center flex-shrink-0`}>
        {icon}
      </span>
      <div>
        <p className="text-xs text-gray-400">{label}</p>
        <p className="text-lg font-bold text-white">{value}</p>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function RelayerStatusPage() {
  const [status, setStatus] = useState<RelayerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchStatus() {
      try {
        const res = await fetch(`${getApiBase()}/api/relayer/status`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data: RelayerStatus = await res.json();
        if (!cancelled) {
          setStatus(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Unable to load relayer status.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchStatus();
    const interval = setInterval(fetchStatus, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <Loader2 size={40} className="text-indigo-400 animate-spin mb-4" />
        <p className="text-gray-400">Loading relayer status…</p>
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Radio size={48} className="text-gray-500 mb-4" />
        <h2 className="text-2xl font-bold mb-2">Unable to load relayer status</h2>
        <p className="text-gray-400">{error ?? "Unknown error"}</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* Header */}
      <header>
        <h2 className="text-3xl font-extrabold tracking-tight flex items-center gap-3">
          <Radio size={28} className="text-indigo-400" />
          Bridge Relayer Status
        </h2>
        <p className="text-gray-400 mt-1">
          Real-time monitoring of the Stellar fee-bump relay service.
        </p>
      </header>

      {/* Status badge */}
      <div className="flex items-center gap-3">
        <span
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${
            status.isOnline
              ? "bg-green-500/20 text-green-400"
              : "bg-red-500/20 text-red-400"
          }`}
        >
          {status.isOnline ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          {status.isOnline ? "Online" : "Offline"}
        </span>
        <span className="text-xs text-gray-500">
          Network: {status.network} &middot; Uptime: {status.uptime} &middot; Checked:{" "}
          {formatTime(status.checkedAt)}
        </span>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          icon={<Activity size={18} className="text-indigo-400" />}
          label="Queue Depth"
          value={String(status.queueDepth)}
          accent="indigo"
        />
        <MetricCard
          icon={<CheckCircle2 size={18} className="text-green-400" />}
          label="Success Rate"
          value={`${status.successRate}%`}
          accent="green"
        />
        <MetricCard
          icon={<Clock size={18} className="text-yellow-400" />}
          label="Avg Duration"
          value={formatDuration(status.avgDurationMs)}
          accent="yellow"
        />
        <MetricCard
          icon={<ShieldCheck size={18} className="text-purple-400" />}
          label="Replay Hashes"
          value={String(status.replayProtection.trackedHashes)}
          accent="purple"
        />
      </div>

      {/* Replay Protection */}
      <div className="glass-panel rounded-2xl p-6">
        <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
          <ShieldCheck size={18} /> Replay Protection
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs">Status</p>
            <p className={status.replayProtection.enabled ? "text-green-400" : "text-red-400"}>
              {status.replayProtection.enabled ? "Active" : "Disabled"}
            </p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Tracked Hashes</p>
            <p className="text-white">{status.replayProtection.trackedHashes}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Oldest Hash Age</p>
            <p className="text-white">{status.replayProtection.oldestHashAge ?? "N/A"}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Dedup Window</p>
            <p className="text-white">{status.replayProtection.deduplicationWindow}</p>
          </div>
        </div>
      </div>

      {/* Recent Events */}
      <div className="glass-panel rounded-2xl p-6">
        <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
          <Activity size={18} /> Recent Relay Events
        </h3>
        {status.recentEvents.length === 0 ? (
          <p className="text-sm text-gray-400">No relay events recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-700/50">
                  <th className="text-left py-2 pr-4">Time</th>
                  <th className="text-left py-2 pr-4">Status</th>
                  <th className="text-left py-2 pr-4">Duration</th>
                  <th className="text-left py-2 pr-4">Tx Hash</th>
                  <th className="text-left py-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {status.recentEvents.map((event) => (
                  <tr
                    key={event.id}
                    className="border-b border-gray-800/50 hover:bg-gray-800/30"
                  >
                    <td className="py-2 pr-4 text-gray-300 font-mono text-xs">
                      {formatTime(event.timestamp)}
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          event.status === "success"
                            ? "bg-green-500/20 text-green-400"
                            : event.status === "failed"
                              ? "bg-red-500/20 text-red-400"
                              : "bg-yellow-500/20 text-yellow-400"
                        }`}
                      >
                        {event.status === "success" ? (
                          <CheckCircle2 size={12} />
                        ) : event.status === "failed" ? (
                          <XCircle size={12} />
                        ) : (
                          <Clock size={12} />
                        )}
                        {event.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-300 font-mono text-xs">
                      {formatDuration(event.durationMs)}
                    </td>
                    <td className="py-2 pr-4 text-gray-300 font-mono text-xs">
                      {event.feeBumpHash ? formatHash(event.feeBumpHash) : "-"}
                    </td>
                    <td className="py-2 text-red-400 text-xs">
                      {event.error ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Summary */}
      <div className="glass-panel rounded-2xl p-6">
        <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
          <AlertTriangle size={18} /> Relay Summary
        </h3>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs">Total Relayed</p>
            <p className="text-2xl font-bold text-white">{status.totalRelayed}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Successful</p>
            <p className="text-2xl font-bold text-green-400">{status.successCount}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Failed</p>
            <p className="text-2xl font-bold text-red-400">{status.failureCount}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
