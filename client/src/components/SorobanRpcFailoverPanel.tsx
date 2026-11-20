import React, { useState, useEffect, useCallback } from "react";
import {
  Server,
  AlertTriangle,
  CheckCircle,
  Clock,
  RefreshCw,
  Activity,
  ShieldAlert,
  ArrowRight,
  Radio,
} from "lucide-react";
import {
  fetchSorobanRpcStatus,
  triggerProbeRecovery,
  type SorobanRpcStatusSnapshot,
} from "../services/sorobanRpcFailoverService";

export const SorobanRpcFailoverPanel: React.FC = () => {
  const [snapshot, setSnapshot] = useState<SorobanRpcStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [activeTab, setActiveTab] = useState<"endpoints" | "incidents" | "alerts">("endpoints");

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchSorobanRpcStatus();
      setSnapshot(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load Soroban RPC metrics.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    const interval = setInterval(loadData, 15_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleProbe = async () => {
    setRecovering(true);
    try {
      await triggerProbeRecovery();
      await loadData();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Probe and recovery request failed.",
      );
    } finally {
      setRecovering(false);
    }
  };

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading && !snapshot) {
    return (
      <div className="glass-panel rounded-2xl p-6 border border-white/10 animate-pulse">
        <div className="flex items-center justify-between mb-4">
          <div className="h-6 w-56 bg-white/10 rounded-lg" />
          <div className="h-6 w-24 bg-white/10 rounded-full" />
        </div>
        <p className="text-sm text-gray-400 mb-6">
          Connecting to Soroban RPC nodes & querying failover telemetry...
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="h-20 bg-white/5 rounded-xl" />
          <div className="h-20 bg-white/5 rounded-xl" />
          <div className="h-20 bg-white/5 rounded-xl" />
        </div>
      </div>
    );
  }

  // ── Failure state ─────────────────────────────────────────────────────────
  if (error && !snapshot) {
    return (
      <div className="glass-panel rounded-2xl p-6 border border-red-500/30 bg-red-500/5">
        <div className="flex items-center gap-2 mb-2 text-red-400">
          <ShieldAlert size={20} />
          <h3 className="font-semibold text-lg">Soroban RPC Telemetry Unavailable</h3>
        </div>
        <p className="text-sm text-gray-300 mb-4">{error}</p>
        <button
          onClick={() => {
            setLoading(true);
            void loadData();
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors"
        >
          <RefreshCw size={14} />
          Retry Connection
        </button>
      </div>
    );
  }

  if (!snapshot) return null;

  const isAllDown = snapshot.status === "all_down";
  const isFailover = snapshot.status === "failover_active";
  const isHealthy = snapshot.status === "healthy";

  return (
    <div className="glass-panel rounded-2xl p-6 border border-white/10 space-y-6">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
            <Server size={22} />
          </div>
          <div>
            <h3 className="font-semibold text-lg text-white">
              Soroban RPC Failover & Node Health
            </h3>
            <p className="text-xs text-gray-400">
              Multi-node RPC pool with automatic failover and live alert hooks
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Status Badge */}
          {isHealthy && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Primary Node Active
            </span>
          )}
          {isFailover && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
              <AlertTriangle size={12} />
              Failover Active (Backup Node)
            </span>
          )}
          {isAllDown && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/30">
              <ShieldAlert size={12} />
              All Endpoints Down
            </span>
          )}

          <button
            onClick={handleProbe}
            disabled={recovering}
            title="Probe higher-priority nodes and trigger failback if recovered"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-medium text-gray-300 border border-white/10 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={recovering ? "animate-spin" : ""} />
            {recovering ? "Probing..." : "Probe & Recover"}
          </button>
        </div>
      </div>

      {/* ── Status Alert Banner if degraded or all down ──────────────────── */}
      {isFailover && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="text-amber-400 shrink-0 mt-0.5" size={18} />
          <div className="text-sm">
            <p className="font-semibold text-amber-300">
              Notice: Automatic RPC Failover in Effect
            </p>
            <p className="text-amber-200/80 text-xs mt-0.5">
              Traffic has safely failed over to a backup RPC provider (Priority {snapshot.activePriority}).
              Contract reads and transactions continue without interruption.
            </p>
          </div>
        </div>
      )}

      {isAllDown && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 flex items-start gap-3">
          <ShieldAlert className="text-red-400 shrink-0 mt-0.5" size={18} />
          <div className="text-sm">
            <p className="font-semibold text-red-300">
              Critical: All Soroban RPC Endpoints Are Currently Unreachable
            </p>
            <p className="text-red-200/80 text-xs mt-0.5">
              All configured Soroban RPC endpoints are failing connectivity checks. Alert hooks have been triggered.
            </p>
          </div>
        </div>
      )}

      {/* ── Metric Summary Cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl bg-white/5 border border-white/5 p-3.5">
          <span className="text-xs text-gray-400">Active Node</span>
          <p className="text-sm font-semibold text-white truncate mt-1" title={snapshot.activeEndpoint}>
            {snapshot.activeEndpoint.replace(/^https?:\/\//, "")}
          </p>
          <span className="text-[11px] text-gray-500 mt-0.5 block">
            Priority {snapshot.activePriority} {snapshot.activePriority === 0 ? "(Primary)" : "(Fallback)"}
          </span>
        </div>

        <div className="rounded-xl bg-white/5 border border-white/5 p-3.5">
          <span className="text-xs text-gray-400">Total Failovers</span>
          <p className="text-xl font-bold text-white mt-0.5">
            {snapshot.totalFailovers}
          </p>
          <span className="text-[11px] text-gray-500 block">
            Lifetime transitions
          </span>
        </div>

        <div className="rounded-xl bg-white/5 border border-white/5 p-3.5">
          <span className="text-xs text-gray-400">Configured Nodes</span>
          <p className="text-xl font-bold text-white mt-0.5">
            {snapshot.configuredEndpointsCount}
          </p>
          <span className="text-[11px] text-gray-500 block">
            In failover pool
          </span>
        </div>

        <div className="rounded-xl bg-white/5 border border-white/5 p-3.5">
          <span className="text-xs text-gray-400">Active Latency</span>
          <p className="text-xl font-bold text-emerald-400 mt-0.5">
            {snapshot.endpoints.find((e) => e.url === snapshot.activeEndpoint)?.latencyMs ?? 0} ms
          </p>
          <span className="text-[11px] text-gray-500 block">
            Observed ping
          </span>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="border-b border-white/10 flex gap-4 text-xs font-medium">
        <button
          onClick={() => setActiveTab("endpoints")}
          className={`pb-2 transition-colors border-b-2 ${
            activeTab === "endpoints"
              ? "border-indigo-400 text-indigo-400 font-semibold"
              : "border-transparent text-gray-400 hover:text-white"
          }`}
        >
          RPC Endpoints ({snapshot.endpoints.length})
        </button>
        <button
          onClick={() => setActiveTab("incidents")}
          className={`pb-2 transition-colors border-b-2 ${
            activeTab === "incidents"
              ? "border-indigo-400 text-indigo-400 font-semibold"
              : "border-transparent text-gray-400 hover:text-white"
          }`}
        >
          Recent Failovers ({snapshot.recentFailovers.length})
        </button>
        <button
          onClick={() => setActiveTab("alerts")}
          className={`pb-2 transition-colors border-b-2 ${
            activeTab === "alerts"
              ? "border-indigo-400 text-indigo-400 font-semibold"
              : "border-transparent text-gray-400 hover:text-white"
          }`}
        >
          Alert Hooks ({snapshot.recentAlerts.length})
        </button>
      </div>

      {/* ── Tab Content: Endpoints ───────────────────────────────────────── */}
      {activeTab === "endpoints" && (
        <div className="space-y-2.5">
          {snapshot.endpoints.map((ep) => {
            const isActive = ep.url === snapshot.activeEndpoint;
            return (
              <div
                key={ep.url}
                className={`rounded-xl border p-3.5 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                  isActive
                    ? "border-indigo-500/30 bg-indigo-500/5 shadow-sm"
                    : "border-white/5 bg-white/[0.02]"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                      ep.status === "healthy"
                        ? "bg-emerald-400"
                        : ep.status === "degraded"
                        ? "bg-amber-400"
                        : "bg-red-400"
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white truncate">
                        {ep.url}
                      </span>
                      {isActive && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                          ACTIVE
                        </span>
                      )}
                      <span className="text-[11px] text-gray-400">
                        P{ep.priority} {ep.priority === 0 ? "Primary" : "Backup"}
                      </span>
                    </div>
                    {ep.lastFailureReason && (
                      <p className="text-xs text-red-400 truncate mt-0.5">
                        Last failure: {ep.lastFailureReason}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs text-gray-300 shrink-0">
                  <div>
                    <span className="text-gray-500 block text-[10px]">Latency</span>
                    <span className="font-medium text-emerald-400">{ep.latencyMs} ms</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block text-[10px]">Requests</span>
                    <span className="font-medium">{ep.totalRequests}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block text-[10px]">Errors</span>
                    <span className={`font-medium ${ep.totalFailures > 0 ? "text-amber-400" : "text-gray-400"}`}>
                      {ep.totalFailures}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500 block text-[10px]">Status</span>
                    <span
                      className={`capitalize font-medium ${
                        ep.status === "healthy"
                          ? "text-emerald-400"
                          : ep.status === "degraded"
                          ? "text-amber-400"
                          : "text-red-400"
                      }`}
                    >
                      {ep.status}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Tab Content: Incidents ───────────────────────────────────────── */}
      {activeTab === "incidents" && (
        <div>
          {snapshot.recentFailovers.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-xs">
              <CheckCircle size={28} className="mx-auto mb-2 text-emerald-400/60" />
              <p>No failover incidents recorded.</p>
              <p className="text-gray-500 mt-0.5">All RPC requests processed through primary node without interruption.</p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {snapshot.recentFailovers.map((inc) => (
                <li
                  key={inc.id}
                  className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3.5 text-xs text-gray-300"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-white flex items-center gap-1.5">
                      <Clock size={13} className="text-amber-400" />
                      {new Date(inc.timestamp).toLocaleString()}
                    </span>
                    <span className="text-amber-400 font-medium">
                      Priority {inc.activePriority} Active
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-gray-400 mt-1">
                    <span className="truncate max-w-[180px] sm:max-w-xs">{inc.fromEndpoint}</span>
                    <ArrowRight size={12} className="text-amber-400 shrink-0" />
                    <span className="text-white font-medium truncate max-w-[180px] sm:max-w-xs">{inc.toEndpoint}</span>
                  </div>
                  <p className="text-gray-400 mt-1 truncate">
                    <strong className="text-gray-300">Reason:</strong> {inc.reason}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Tab Content: Alert Hooks ─────────────────────────────────────── */}
      {activeTab === "alerts" && (
        <div>
          {snapshot.recentAlerts.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-xs">
              <Radio size={28} className="mx-auto mb-2 text-indigo-400/60" />
              <p>No alert hooks triggered.</p>
              <p className="text-gray-500 mt-0.5">Alert hooks dispatch automatically when nodes degrade or failover occurs.</p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {snapshot.recentAlerts.map((alt) => (
                <li
                  key={alt.id}
                  className={`rounded-xl border p-3.5 text-xs ${
                    alt.severity === "CRITICAL"
                      ? "border-red-500/30 bg-red-500/5 text-red-200"
                      : alt.severity === "HIGH"
                      ? "border-amber-500/30 bg-amber-500/5 text-amber-200"
                      : "border-indigo-500/30 bg-indigo-500/5 text-indigo-200"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-white flex items-center gap-1.5">
                      <Activity size={13} />
                      {alt.eventType.replace(/_/g, " ")}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        alt.severity === "CRITICAL"
                          ? "bg-red-500/20 text-red-300"
                          : alt.severity === "HIGH"
                          ? "bg-amber-500/20 text-amber-300"
                          : "bg-indigo-500/20 text-indigo-300"
                      }`}
                    >
                      {alt.severity}
                    </span>
                  </div>
                  <p className="text-white/90 mt-1">{alt.message}</p>
                  <div className="flex items-center justify-between text-[11px] text-gray-400 mt-1.5">
                    <span>Reason: {alt.reason}</span>
                    <span>{new Date(alt.timestamp).toLocaleTimeString()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default SorobanRpcFailoverPanel;
