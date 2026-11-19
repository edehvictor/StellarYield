import React, { useState, useEffect, useCallback } from "react";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  RefreshCw,
  Copy,
  Check,
  Server,
  Wallet,
  Globe,
  FileCode2,
  ExternalLink,
} from "lucide-react";
import {
  getSystemDiagnostics,
  type SystemDiagnostics,
  type DependencyStatus,
} from "../../lib/config";
import { useWallet } from "../../context/useWallet";

export interface DiagnosticsPanelProps {
  /** Optional custom title */
  title?: string;
  /** If provided, renders a close button calling this */
  onClose?: () => void;
  /** Compact mode removes outer card padding for dense embeddings */
  compact?: boolean;
}

const STATUS_CONFIG: Record<
  DependencyStatus,
  { label: string; bg: string; text: string; border: string; icon: React.ReactNode }
> = {
  healthy: {
    label: "Healthy",
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
    border: "border-emerald-500/30",
    icon: <CheckCircle2 size={16} className="text-emerald-400" />,
  },
  warning: {
    label: "Warning / Degraded",
    bg: "bg-amber-500/10",
    text: "text-amber-400",
    border: "border-amber-500/30",
    icon: <AlertTriangle size={16} className="text-amber-400" />,
  },
  error: {
    label: "Error / Misconfigured",
    bg: "bg-rose-500/10",
    text: "text-rose-400",
    border: "border-rose-500/30",
    icon: <XCircle size={16} className="text-rose-400" />,
  },
  unconfigured: {
    label: "Unconfigured",
    bg: "bg-slate-500/10",
    text: "text-slate-400",
    border: "border-slate-500/30",
    icon: <HelpCircle size={16} className="text-slate-400" />,
  },
};

export default function DiagnosticsPanel({
  title = "System & Environment Diagnostics",
  onClose,
  compact = false,
}: DiagnosticsPanelProps) {
  const { isConnected, walletAddress } = useWallet();
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics>(() =>
    getSystemDiagnostics(import.meta.env, { isConnected, address: walletAddress })
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);
  const [copiedContract, setCopiedContract] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setIsRefreshing(true);
    setTimeout(() => {
      setDiagnostics(
        getSystemDiagnostics(import.meta.env, { isConnected, address: walletAddress })
      );
      setIsRefreshing(false);
    }, 300);
  }, [isConnected, walletAddress]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCopyReport = () => {
    try {
      const sanitizedReport = JSON.stringify(diagnostics, null, 2);
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(sanitizedReport);
      }
      setCopiedReport(true);
      setTimeout(() => setCopiedReport(false), 2000);
    } catch {
      /* ignore clipboard errors */
    }
  };

  const handleCopyContract = (id: string, name: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(id);
      }
      setCopiedContract(name);
      setTimeout(() => setCopiedContract(null), 1500);
    } catch {
      /* ignore */
    }
  };

  const overallCfg = STATUS_CONFIG[diagnostics.overallStatus];

  return (
    <div className={`flex flex-col gap-6 text-slate-100 ${compact ? "" : "p-6"}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/20 text-indigo-400">
              <Activity size={22} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">{title}</h2>
              <p className="text-xs text-slate-400">
                Inspect deployment dependencies, API configuration, wallet connection, and contract registry.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition-colors border border-slate-700"
            title="Refresh system diagnostics"
          >
            <RefreshCw size={13} className={isRefreshing ? "animate-spin" : ""} />
            <span>{isRefreshing ? "Checking..." : "Recheck"}</span>
          </button>

          <button
            type="button"
            onClick={handleCopyReport}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-xs font-medium text-indigo-300 transition-colors border border-indigo-500/30"
            title="Copy sanitized diagnostics JSON for troubleshooting"
          >
            {copiedReport ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            <span>{copiedReport ? "Report Copied" : "Copy Report"}</span>
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
              aria-label="Close diagnostics"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Overall Health Status Banner */}
      <div
        className={`p-4 rounded-xl border flex items-center justify-between gap-4 ${overallCfg.bg} ${overallCfg.border}`}
      >
        <div className="flex items-center gap-3">
          {overallCfg.icon}
          <div>
            <div className="flex items-center gap-2">
              <span className={`text-sm font-semibold ${overallCfg.text}`}>
                System Status: {overallCfg.label}
              </span>
            </div>
            <p className="text-xs text-slate-300 mt-0.5">
              {diagnostics.overallStatus === "healthy"
                ? "All critical dependencies, environment configuration, and contract registry entries are verified."
                : diagnostics.overallStatus === "error"
                ? "One or more critical dependencies are misconfigured. Review the cards below for remediation instructions."
                : "Some optional or local fallback configurations are active. Review below to ensure expected behavior."}
            </p>
          </div>
        </div>
        <span className="text-[11px] text-slate-400 shrink-0 font-mono hidden sm:inline">
          {new Date(diagnostics.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {/* 4 Diagnostic Area Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 1. API Backend */}
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-sm text-white">
              <Server size={16} className="text-indigo-400" />
              <span>Backend API</span>
            </div>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium border ${
                STATUS_CONFIG[diagnostics.api.status].bg
              } ${STATUS_CONFIG[diagnostics.api.status].text} ${
                STATUS_CONFIG[diagnostics.api.status].border
              }`}
            >
              {STATUS_CONFIG[diagnostics.api.status].label}
            </span>
          </div>

          <div className="space-y-1.5 text-xs text-slate-300">
            <div className="flex justify-between items-center py-1 border-b border-slate-800/80">
              <span className="text-slate-400">Base URL</span>
              <span className="font-mono truncate max-w-[220px]" title={diagnostics.api.baseUrl || "None"}>
                {diagnostics.api.maskedUrl || (
                  <span className="text-slate-500 italic">Not set</span>
                )}
              </span>
            </div>

            <div className="flex justify-between items-center py-1 border-b border-slate-800/80">
              <span className="text-slate-400">Mode</span>
              <span className="font-medium text-slate-200">
                {diagnostics.api.isConfigured
                  ? "Environment (VITE_API_BASE_URL)"
                  : diagnostics.api.isLocalFallback
                  ? "Local Dev Fallback"
                  : "Unset / Same-Origin"}
              </span>
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-xs text-slate-300 mt-auto">
            <p className="leading-relaxed">{diagnostics.api.hint}</p>
          </div>
        </div>

        {/* 2. Wallet & Extensions */}
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-sm text-white">
              <Wallet size={16} className="text-purple-400" />
              <span>Wallet Provider</span>
            </div>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium border ${
                STATUS_CONFIG[diagnostics.wallet.status].bg
              } ${STATUS_CONFIG[diagnostics.wallet.status].text} ${
                STATUS_CONFIG[diagnostics.wallet.status].border
              }`}
            >
              {diagnostics.wallet.isConnected ? "Connected" : STATUS_CONFIG[diagnostics.wallet.status].label}
            </span>
          </div>

          <div className="space-y-1.5 text-xs text-slate-300">
            <div className="flex justify-between items-center py-1 border-b border-slate-800/80">
              <span className="text-slate-400">Available Extensions</span>
              <div className="flex items-center gap-2 font-medium">
                <span
                  className={
                    diagnostics.wallet.isFreighterAvailable ? "text-emerald-400 font-bold" : "text-slate-500"
                  }
                >
                  Freighter {diagnostics.wallet.isFreighterAvailable ? "✓" : "✗"}
                </span>
                <span
                  className={
                    diagnostics.wallet.isAlbedoAvailable ? "text-emerald-400 font-bold" : "text-slate-500"
                  }
                >
                  Albedo {diagnostics.wallet.isAlbedoAvailable ? "✓" : "✗"}
                </span>
                <span
                  className={
                    diagnostics.wallet.isXBullAvailable ? "text-emerald-400 font-bold" : "text-slate-500"
                  }
                >
                  xBull {diagnostics.wallet.isXBullAvailable ? "✓" : "✗"}
                </span>
              </div>
            </div>

            <div className="flex justify-between items-center py-1 border-b border-slate-800/80">
              <span className="text-slate-400">Account</span>
              <span className="font-mono text-slate-200">
                {diagnostics.wallet.maskedAddress || <span className="text-slate-500 italic">Disconnected</span>}
              </span>
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-xs text-slate-300 mt-auto">
            <p className="leading-relaxed">{diagnostics.wallet.hint}</p>
          </div>
        </div>

        {/* 3. Stellar Network */}
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-sm text-white">
              <Globe size={16} className="text-cyan-400" />
              <span>Stellar Network</span>
            </div>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium uppercase font-mono border ${
                diagnostics.network.activeNetwork === "mainnet"
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : "bg-cyan-500/10 text-cyan-400 border-cyan-500/30"
              }`}
            >
              {diagnostics.network.activeNetwork}
            </span>
          </div>

          <div className="space-y-1.5 text-xs text-slate-300">
            <div className="flex justify-between items-center py-1 border-b border-slate-800/80">
              <span className="text-slate-400">Network Passphrase</span>
              <span className="font-mono text-[11px] truncate max-w-[200px]" title={diagnostics.network.passphrase}>
                {diagnostics.network.passphrase}
              </span>
            </div>

            <div className="flex justify-between items-center py-1 border-b border-slate-800/80">
              <span className="text-slate-400">Soroban RPC</span>
              <span className="font-mono text-[11px] truncate max-w-[200px]" title={diagnostics.network.rpcUrl || "Default"}>
                {diagnostics.network.rpcUrl || <span className="text-slate-500 italic">Default</span>}
              </span>
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-xs text-slate-300 mt-auto">
            <p className="leading-relaxed">{diagnostics.network.hint}</p>
          </div>
        </div>

        {/* 4. Contract Registry */}
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-sm text-white">
              <FileCode2 size={16} className="text-amber-400" />
              <span>Contract Registry</span>
            </div>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium border ${
                STATUS_CONFIG[diagnostics.registry.status].bg
              } ${STATUS_CONFIG[diagnostics.registry.status].text} ${
                STATUS_CONFIG[diagnostics.registry.status].border
              }`}
            >
              {diagnostics.registry.configuredContracts} / {diagnostics.registry.totalContracts} Loaded
            </span>
          </div>

          <div className="space-y-1.5 text-xs text-slate-300">
            <div className="flex justify-between items-center py-1 border-b border-slate-800/80">
              <span className="text-slate-400">Missing Contracts</span>
              <span className="font-medium text-slate-200">
                {diagnostics.registry.missingContracts.length === 0 ? (
                  <span className="text-emerald-400 font-semibold">None (100% loaded)</span>
                ) : (
                  <span className="text-rose-400 font-semibold">
                    {diagnostics.registry.missingContracts.join(", ")}
                  </span>
                )}
              </span>
            </div>

            <div className="flex justify-between items-center py-1 border-b border-slate-800/80">
              <span className="text-slate-400">Vault Contract</span>
              <span className="font-mono text-[11px] text-slate-200">
                {diagnostics.registry.contracts.find((c) => c.name === "vault")?.maskedId || "Missing"}
              </span>
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-xs text-slate-300 mt-auto">
            <p className="leading-relaxed">{diagnostics.registry.hint}</p>
          </div>
        </div>
      </div>

      {/* Contract Registry Detailed Table */}
      <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm text-white">Registered Contracts Breakdown</h3>
          <span className="text-xs text-slate-400">
            Network: <span className="font-mono uppercase font-bold text-slate-300">{diagnostics.network.activeNetwork}</span>
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2 px-2 font-medium">Contract</th>
                <th className="py-2 px-2 font-medium">Status</th>
                <th className="py-2 px-2 font-medium">Source</th>
                <th className="py-2 px-2 font-medium">Contract Address</th>
                <th className="py-2 px-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {diagnostics.registry.contracts.map((c) => (
                <tr key={c.name} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-2 px-2 font-semibold text-slate-200">{c.name}</td>
                  <td className="py-2 px-2">
                    {c.source === "missing" ? (
                      <span className="inline-flex items-center gap-1 text-rose-400 font-medium">
                        <XCircle size={12} /> Missing
                      </span>
                    ) : c.isValidFormat ? (
                      <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                        <CheckCircle2 size={12} /> Valid
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                        <AlertTriangle size={12} /> Invalid Format
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-2">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-mono uppercase ${
                        c.source === "env"
                          ? "bg-indigo-500/20 text-indigo-300"
                          : c.source === "registry"
                          ? "bg-slate-700 text-slate-300"
                          : "bg-rose-500/20 text-rose-300"
                      }`}
                    >
                      {c.source}
                    </span>
                  </td>
                  <td className="py-2 px-2 font-mono text-slate-300">
                    {c.contractId ? (
                      <span title={c.contractId}>{c.maskedId}</span>
                    ) : (
                      <span className="text-slate-500 italic">Not specified</span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right">
                    {c.contractId ? (
                      <button
                        type="button"
                        onClick={() => handleCopyContract(c.contractId, c.name)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors text-[11px]"
                        title="Copy full address"
                      >
                        {copiedContract === c.name ? (
                          <Check size={11} className="text-emerald-400" />
                        ) : (
                          <Copy size={11} />
                        )}
                        <span>{copiedContract === c.name ? "Copied" : "Copy"}</span>
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
