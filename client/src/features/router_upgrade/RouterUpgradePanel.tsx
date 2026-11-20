import React, { useState, useEffect } from "react";
import {
  Shield,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Cpu,
  Layers,
  ArrowRight,
  Info,
} from "lucide-react";
import type {
  RouterUpgradeDryRunResult,
  RouterStatusResponse,
} from "./types";
import {
  performRouterUpgradeDryRun,
  fetchRouterStatus,
} from "./routerUpgradeService";

interface RouterUpgradePanelProps {
  onUpgradeApproved?: (result: RouterUpgradeDryRunResult) => void;
  defaultCandidateAddress?: string;
}

export const RouterUpgradePanel: React.FC<RouterUpgradePanelProps> = ({
  onUpgradeApproved,
  defaultCandidateAddress = "",
}) => {
  const [candidateAddress, setCandidateAddress] = useState<string>(
    defaultCandidateAddress
  );
  const [statusInfo, setStatusInfo] = useState<RouterStatusResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<RouterUpgradeDryRunResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    fetchRouterStatus()
      .then((data) => setStatusInfo(data))
      .catch(() => {
        // Silently keep default null if status fails to load
      });
  }, []);

  const handleSimulate = async (e: React.FormEvent) => {
    e.preventDefault();
    setRequestError(null);
    setLoading(true);

    try {
      const dryRunRes = await performRouterUpgradeDryRun({
        candidateRouterAddress: candidateAddress,
        currentRouterAddress: statusInfo?.activeRouterAddress || undefined,
        mockSimulate: process.env.NODE_ENV === "test",
      });
      setResult(dryRunRes);
    } catch (err) {
      setRequestError(
        err instanceof Error
          ? err.message
          : "An unexpected error occurred during dry-run simulation."
      );
    } finally {
      setLoading(false);
    }
  };

  const isFormEmpty = !candidateAddress.trim();

  return (
    <div className="glass-card p-6 space-y-6 max-w-4xl mx-auto rounded-xl border border-slate-800 bg-slate-900/60 shadow-xl text-slate-100">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
            <Shield size={24} />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight">
              Router Upgrade Verification & Dry-Run
            </h2>
            <p className="text-sm text-slate-400">
              Perform simulated contract invocations before authorizing router migrations.
            </p>
          </div>
        </div>
        {statusInfo && (
          <div className="text-right text-xs text-slate-400">
            <span className="block font-medium text-slate-300">
              Network: <span className="text-indigo-400 uppercase">{statusInfo.network}</span>
            </span>
            <span className="block truncate max-w-[200px]" title={statusInfo.activeRouterAddress || "None"}>
              Active: {statusInfo.activeRouterAddress ? `${statusInfo.activeRouterAddress.slice(0, 8)}...` : "Unset"}
            </span>
          </div>
        )}
      </div>

      {/* Input form */}
      <form onSubmit={handleSimulate} className="space-y-4">
        <div>
          <label
            htmlFor="candidate-router-address"
            className="block text-sm font-medium text-slate-300 mb-1"
          >
            Candidate DEX Router Contract ID
          </label>
          <div className="relative">
            <input
              id="candidate-router-address"
              data-testid="candidate-router-input"
              type="text"
              value={candidateAddress}
              onChange={(e) => setCandidateAddress(e.target.value)}
              placeholder="e.g. CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"
              className="w-full px-4 py-2.5 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-sm"
              disabled={loading}
            />
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <button
            type="submit"
            data-testid="dry-run-submit-btn"
            disabled={loading}
            className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm flex items-center gap-2 transition-colors shadow-lg shadow-indigo-600/20"
          >
            {loading ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                <span>Simulating Contract Invocation...</span>
              </>
            ) : (
              <>
                <span>Run Invocation Dry-Run</span>
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </div>
      </form>

      {/* Loading state indicator */}
      {loading && (
        <div
          data-testid="dry-run-loading-state"
          className="p-6 rounded-lg bg-slate-800/40 border border-slate-700/60 flex items-center justify-center space-x-3 text-slate-300"
        >
          <RefreshCw size={20} className="animate-spin text-indigo-400" />
          <span className="text-sm font-medium">
            Contacting Soroban RPC node and dry-running candidate contract invocation...
          </span>
        </div>
      )}

      {/* Request transport error */}
      {requestError && (
        <div
          data-testid="dry-run-transport-error"
          className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm flex items-start space-x-3"
        >
          <XCircle size={18} className="mt-0.5 text-rose-400 shrink-0" />
          <div>
            <p className="font-semibold">Transport Failure</p>
            <p className="text-xs text-rose-200 mt-0.5">{requestError}</p>
          </div>
        </div>
      )}

      {/* Empty State when no candidate address is entered */}
      {isFormEmpty && !result && !loading && (
        <div
          data-testid="dry-run-empty-state"
          className="p-6 rounded-lg bg-slate-800/30 border border-slate-700/50 space-y-3"
        >
          <div className="flex items-center space-x-2 text-indigo-400">
            <Info size={18} />
            <span className="text-sm font-semibold">Dry-Run Protocol Safety</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Enter a candidate DEX router contract address above to run automated invocation
            dry-runs. The simulation checks:
          </p>
          <ul className="text-xs text-slate-400 space-y-1.5 list-disc pl-5">
            <li>Soroban contract address format and syntax.</li>
            <li>Differentiation from currently active router.</li>
            <li>On-chain deployment presence on the active network.</li>
            <li>
              Interface conformance for <code className="text-indigo-300">swap(from, to, amount_in, min_out) -&gt; i128</code>.
            </li>
            <li>Non-zero simulated swap outputs and gas consumption profiles.</li>
          </ul>
        </div>
      )}

      {/* Results view (Normal & Failure states) */}
      {result && !loading && (
        <div
          data-testid="dry-run-results-container"
          className={`p-6 rounded-xl border ${
            result.status === "READY"
              ? "bg-emerald-950/20 border-emerald-500/40"
              : "bg-rose-950/20 border-rose-500/40"
          } space-y-5`}
        >
          {/* Header Status */}
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {result.status === "READY" ? (
                <div className="p-2 rounded-full bg-emerald-500/20 text-emerald-400">
                  <CheckCircle size={22} />
                </div>
              ) : (
                <div className="p-2 rounded-full bg-rose-500/20 text-rose-400">
                  <XCircle size={22} />
                </div>
              )}
              <div>
                <span
                  data-testid="dry-run-status-badge"
                  className={`inline-block px-2.5 py-0.5 rounded text-xs font-bold tracking-wider uppercase ${
                    result.status === "READY"
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                      : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                  }`}
                >
                  {result.status}
                </span>
                <p
                  data-testid="dry-run-summary-text"
                  className="text-sm font-medium text-slate-200 mt-1"
                >
                  {result.summary}
                </p>
              </div>
            </div>
          </div>

          {/* Stable Typed Error Card in Failure State */}
          {result.error && (
            <div
              data-testid="dry-run-error-card"
              className="p-4 rounded-lg bg-rose-900/30 border border-rose-500/40 text-slate-200 space-y-2"
            >
              <div className="flex items-center space-x-2 text-rose-400">
                <AlertTriangle size={18} />
                <span data-testid="dry-run-error-code" className="font-bold text-xs uppercase tracking-wider">
                  Error Code: {result.error.code}
                </span>
              </div>
              <p data-testid="dry-run-error-message" className="text-sm font-medium text-rose-200">
                {result.error.message}
              </p>
              <p
                data-testid="dry-run-error-remediation"
                className="text-xs text-slate-300 border-t border-rose-800/40 pt-2"
              >
                <span className="font-semibold text-rose-300">Remediation: </span>
                {result.error.remediation}
              </p>
            </div>
          )}

          {/* Verification Checks Checklist */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-300 tracking-wider uppercase">
              Verification Matrix
            </p>
            <div className="grid grid-cols-1 gap-2">
              {result.checks.map((check) => (
                <div
                  key={check.id}
                  data-testid={`check-item-${check.id}`}
                  className="flex items-center justify-between p-3 rounded-lg bg-slate-800/60 border border-slate-700/50 text-xs"
                >
                  <div className="flex items-center space-x-2.5">
                    {check.passed ? (
                      <CheckCircle size={15} className="text-emerald-400 shrink-0" />
                    ) : (
                      <XCircle size={15} className="text-rose-400 shrink-0" />
                    )}
                    <span className="font-medium text-slate-200">{check.label}</span>
                  </div>
                  <span className="text-slate-400 text-right">{check.message}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Simulation Output Metrics (Normal / Success state) */}
          {result.simulation && (
            <div
              data-testid="dry-run-simulation-metrics"
              className="p-4 rounded-lg bg-slate-800/40 border border-slate-700/60 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs"
            >
              <div>
                <span className="text-slate-400 block">Expected Swap Return</span>
                <span data-testid="metric-expected-out" className="text-base font-bold text-emerald-400 font-mono">
                  {result.simulation.expectedAmountOutStroops} stroops
                </span>
              </div>
              {result.simulation.simulatedCpuInstructions !== undefined && (
                <div>
                  <span className="text-slate-400 block flex items-center gap-1">
                    <Cpu size={12} /> CPU Instructions
                  </span>
                  <span data-testid="metric-cpu-instructions" className="text-sm font-semibold text-slate-200 font-mono">
                    {result.simulation.simulatedCpuInstructions.toLocaleString()}
                  </span>
                </div>
              )}
              {result.simulation.simulatedMemoryBytes !== undefined && (
                <div>
                  <span className="text-slate-400 block flex items-center gap-1">
                    <Layers size={12} /> Memory Footprint
                  </span>
                  <span data-testid="metric-memory-bytes" className="text-sm font-semibold text-slate-200 font-mono">
                    {result.simulation.simulatedMemoryBytes.toLocaleString()} bytes
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Action button if simulation succeeded */}
          {result.status === "READY" && onUpgradeApproved && (
            <div className="pt-2 flex justify-end">
              <button
                type="button"
                data-testid="approve-upgrade-btn"
                onClick={() => onUpgradeApproved(result)}
                className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-medium text-sm text-white transition-colors shadow-lg shadow-emerald-600/20"
              >
                Approve Router Upgrade
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default RouterUpgradePanel;
