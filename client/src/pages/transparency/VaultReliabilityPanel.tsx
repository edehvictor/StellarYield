import { useState, useEffect } from "react";
import { Loader2, ShieldCheck, AlertTriangle, ShieldX, Activity } from "lucide-react";
import { getApiBaseUrl } from "../../lib/api";

const getApiBase = () => {
  try {
    return getApiBaseUrl();
  } catch {
    return "";
  }
};

// ── Types ─────────────────────────────────────────────────────────────────

interface DataSourceMetrics {
  freshness: number;
  consistency: number;
  historicalUptime: number;
  anomalyRate: number;
  latency: number;
  errorRate: number;
  coverage: number;
  accuracy: number;
}

interface DataSourceReliability {
  providerId: string;
  providerName: string;
  dataSource: string;
  reliabilityScore: number;
  metrics: DataSourceMetrics;
  status: "high" | "medium" | "low" | "unreliable";
  lastUpdated: string;
  trend: "improving" | "stable" | "declining";
  recommendations: string[];
  failoverPriority: number;
  weightInRecommendations: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  DataSourceReliability["status"],
  { label: string; color: string; bg: string; icon: React.ReactNode }
> = {
  high: {
    label: "High",
    color: "text-green-400",
    bg: "bg-green-500/20",
    icon: <ShieldCheck size={16} className="text-green-400" />,
  },
  medium: {
    label: "Medium",
    color: "text-yellow-400",
    bg: "bg-yellow-500/20",
    icon: <AlertTriangle size={16} className="text-yellow-400" />,
  },
  low: {
    label: "Low",
    color: "text-orange-400",
    bg: "bg-orange-500/20",
    icon: <AlertTriangle size={16} className="text-orange-400" />,
  },
  unreliable: {
    label: "Unreliable",
    color: "text-red-400",
    bg: "bg-red-500/20",
    icon: <ShieldX size={16} className="text-red-400" />,
  },
};

const TREND_ARROWS: Record<DataSourceReliability["trend"], string> = {
  improving: "↑",
  stable: "→",
  declining: "↓",
};

function ScoreBar({ score }: { score: number }) {
  const color =
    score >= 85
      ? "bg-green-500"
      : score >= 70
        ? "bg-yellow-500"
        : score >= 50
          ? "bg-orange-500"
          : "bg-red-500";

  return (
    <div className="w-full h-2 rounded-full bg-gray-700 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
      />
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────

export default function VaultReliabilityPanel() {
  const [providers, setProviders] = useState<DataSourceReliability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchReliability() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${getApiBase()}/api/reliability`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data: DataSourceReliability[] = await res.json();
        if (!cancelled) setProviders(data);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Unable to load reliability data.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchReliability();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="glass-panel rounded-2xl p-6 flex items-center justify-center py-12">
        <Loader2 size={28} className="text-indigo-400 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-panel rounded-2xl p-6">
        <h3 className="font-semibold text-white mb-2 flex items-center gap-2">
          <Activity size={18} /> Data Source Reliability
        </h3>
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="glass-panel rounded-2xl p-6">
      <h3 className="font-semibold text-white mb-1 flex items-center gap-2">
        <Activity size={18} /> Data Source Reliability
      </h3>
      <p className="text-xs text-gray-400 mb-4">
        Reliability scores for each data provider feeding yield calculations.
      </p>

      <div className="space-y-4">
        {providers.map((p) => {
          const cfg = STATUS_CONFIG[p.status];
          return (
            <div
              key={p.providerId}
              className="rounded-xl bg-gray-800/50 border border-gray-700/50 p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.bg} ${cfg.color}`}
                  >
                    {cfg.icon}
                    {cfg.label}
                  </span>
                  <span className="text-sm font-medium text-white">
                    {p.providerName}
                  </span>
                  <span className="text-xs text-gray-500">({p.dataSource})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-white">
                    {p.reliabilityScore}
                  </span>
                  <span
                    className={`text-sm ${
                      p.trend === "improving"
                        ? "text-green-400"
                        : p.trend === "declining"
                          ? "text-red-400"
                          : "text-gray-400"
                    }`}
                  >
                    {TREND_ARROWS[p.trend]}
                  </span>
                </div>
              </div>

              <ScoreBar score={p.reliabilityScore} />

              <div className="grid grid-cols-4 gap-2 mt-3 text-xs text-gray-400">
                <div>
                  <span className="block text-gray-500">Uptime</span>
                  {(p.metrics.historicalUptime * 100).toFixed(1)}%
                </div>
                <div>
                  <span className="block text-gray-500">Freshness</span>
                  {(p.metrics.freshness * 100).toFixed(0)}%
                </div>
                <div>
                  <span className="block text-gray-500">Error Rate</span>
                  {(p.metrics.errorRate * 100).toFixed(2)}%
                </div>
                <div>
                  <span className="block text-gray-500">Latency</span>
                  {p.metrics.latency}ms
                </div>
              </div>

              {p.recommendations.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-yellow-300/80">
                  {p.recommendations.slice(0, 2).map((rec, i) => (
                    <li key={i}>&bull; {rec}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
