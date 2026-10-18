import { useState, useEffect } from "react";
import { Loader2, Flag, CheckCircle2, XCircle } from "lucide-react";
import { getApiBaseUrl } from "../../lib/api";

const getApiBase = () => {
  try {
    return getApiBaseUrl();
  } catch {
    return "";
  }
};

interface FeatureFlagStatus {
  key: string;
  envVar: string;
  description: string;
  state: "enabled" | "disabled";
  source: "env" | "default";
}

export default function FeatureFlagDiagnosticsPanel() {
  const [flags, setFlags] = useState<FeatureFlagStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchFlags() {
      try {
        const res = await fetch(`${getApiBase()}/api/feature-flags`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data: { flags: FeatureFlagStatus[] } = await res.json();
        if (!cancelled) {
          setFlags(data.flags);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Unable to load feature flags.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchFlags();
    const interval = setInterval(fetchFlags, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <Loader2 size={40} className="text-indigo-400 animate-spin mb-4" />
        <p className="text-gray-400">Loading feature flags…</p>
      </div>
    );
  }

  if (error || !flags) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Flag size={48} className="text-gray-500 mb-4" />
        <h2 className="text-2xl font-bold mb-2">Unable to load feature flags</h2>
        <p className="text-gray-400">{error ?? "Unknown error"}</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <header>
        <h2 className="text-3xl font-extrabold tracking-tight flex items-center gap-3">
          <Flag size={28} className="text-indigo-400" />
          Feature Flag Diagnostics
        </h2>
        <p className="text-gray-400 mt-1">
          Live view of every registered feature flag, its resolved state, and
          whether it comes from an environment override or the built-in
          default.
        </p>
      </header>

      <div className="glass-panel rounded-2xl p-6">
        {flags.length === 0 ? (
          <p className="text-sm text-gray-400">No feature flags are registered.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-700/50">
                  <th className="text-left py-2 pr-4">Flag</th>
                  <th className="text-left py-2 pr-4">State</th>
                  <th className="text-left py-2 pr-4">Source</th>
                  <th className="text-left py-2 pr-4">Env Var</th>
                  <th className="text-left py-2">Description</th>
                </tr>
              </thead>
              <tbody>
                {flags.map((flag) => (
                  <tr
                    key={flag.key}
                    className="border-b border-gray-800/50 hover:bg-gray-800/30"
                  >
                    <td className="py-2 pr-4 text-white font-mono text-xs">
                      {flag.key}
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          flag.state === "enabled"
                            ? "bg-green-500/20 text-green-400"
                            : "bg-red-500/20 text-red-400"
                        }`}
                      >
                        {flag.state === "enabled" ? (
                          <CheckCircle2 size={12} />
                        ) : (
                          <XCircle size={12} />
                        )}
                        {flag.state}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-300 text-xs">
                      {flag.source === "env" ? "env override" : "default"}
                    </td>
                    <td className="py-2 pr-4 text-gray-400 font-mono text-xs">
                      {flag.envVar}
                    </td>
                    <td className="py-2 text-gray-300 text-xs">
                      {flag.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
