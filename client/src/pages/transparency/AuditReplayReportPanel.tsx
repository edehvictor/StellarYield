import { useEffect, useState } from "react";
import { getApiBaseUrl } from "../../lib/api";

type ReplayItem = {
  recordId: string;
  strategyId: string;
  executedAt: string;
  recommendedAction: string;
  replayedAction: string;
  isDeterministic: boolean;
  discrepancies: Array<{
    code: string;
    field: string;
    original: string | number;
    replayed: string | number;
    message: string;
  }>;
};

type ReplayReportResponse = {
  success: boolean;
  data?: {
    summary: {
      total: number;
      deterministicCount: number;
      discrepancyCount: number;
      mismatchRate: number;
    };
    items: ReplayItem[];
  };
  error?: string;
};

const getApiBase = () => {
  try {
    return getApiBaseUrl();
  } catch {
    return "";
  }
};

export default function AuditReplayReportPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReplayReportResponse["data"] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${getApiBase()}/api/audit-replay/summary?strategyId=default-strategy&limit=25`,
        );
        const json = (await res.json()) as ReplayReportResponse;
        if (!res.ok || !json.success || !json.data) {
          throw new Error(json.error || `Failed with status ${res.status}`);
        }
        if (!cancelled) setReport(json.data);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load audit replay report.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="glass-panel rounded-2xl p-6">
      <h3 className="font-semibold text-white mb-2">Audit Replay Report</h3>
      {loading && <p className="text-sm text-gray-400">Loading replay summary...</p>}
      {!loading && error && <p className="text-sm text-red-300">{error}</p>}
      {!loading && !error && report && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-4">
            <div className="bg-white/5 rounded-lg p-3">
              <p className="text-gray-400">Total</p>
              <p className="text-white font-semibold">{report.summary.total}</p>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <p className="text-gray-400">Deterministic</p>
              <p className="text-green-300 font-semibold">{report.summary.deterministicCount}</p>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <p className="text-gray-400">Discrepancies</p>
              <p className="text-amber-300 font-semibold">{report.summary.discrepancyCount}</p>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <p className="text-gray-400">Mismatch rate</p>
              <p className="text-white font-semibold">
                {(report.summary.mismatchRate * 100).toFixed(2)}%
              </p>
            </div>
          </div>

          <div className="space-y-2">
            {report.items.slice(0, 6).map((item) => (
              <div key={item.recordId} className="rounded-lg border border-white/10 p-3">
                <p className="text-xs text-gray-400">
                  {item.strategyId} - {new Date(item.executedAt).toLocaleString()}
                </p>
                <p className="text-sm text-white mt-1">
                  Original: <span className="font-mono">{item.recommendedAction}</span> / Replay:{" "}
                  <span className="font-mono">{item.replayedAction}</span>
                </p>
                {!item.isDeterministic && item.discrepancies.length > 0 && (
                  <ul className="mt-1 text-xs text-amber-200 space-y-1">
                    {item.discrepancies.slice(0, 3).map((d) => (
                      <li key={`${item.recordId}-${d.code}-${d.field}`}>
                        {d.code}: {d.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {report.items.length === 0 && (
              <p className="text-sm text-gray-400">No replay records available yet.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
