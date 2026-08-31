import { useEffect, useState } from "react";
import { getApiBaseUrl } from "../../lib/api";

export interface RiskScoreBreakdownSnapshot {
  regime: "calm" | "balanced" | "stressed" | "extreme";
  portfolioRiskScore: number;
  label: "Low" | "Medium" | "High";
  breakdown: {
    tvl: number;
    volatility: number;
    age: number;
  };
  weights: {
    tvl: number;
    volatility: number;
    age: number;
  };
}

const REGIME_LABELS: Record<RiskScoreBreakdownSnapshot["regime"], string> = {
  calm: "Calm",
  balanced: "Balanced",
  stressed: "Stressed",
  extreme: "Extreme",
};

const SCORE_COLOR: Record<RiskScoreBreakdownSnapshot["label"], string> = {
  Low: "text-green-400",
  Medium: "text-yellow-400",
  High: "text-red-400",
};

function getApiBase(): string {
  try {
    return getApiBaseUrl();
  } catch {
    return "";
  }
}

function dominantComponent(snapshot: RiskScoreBreakdownSnapshot): string {
  const weighted = [
    { key: "TVL", value: snapshot.breakdown.tvl * snapshot.weights.tvl },
    { key: "Volatility", value: snapshot.breakdown.volatility * snapshot.weights.volatility },
    { key: "Age", value: snapshot.breakdown.age * snapshot.weights.age },
  ];
  return weighted.sort((a, b) => b.value - a.value)[0].key;
}

export default function RiskScoreBreakdownPanel() {
  const [snapshots, setSnapshots] = useState<RiskScoreBreakdownSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${getApiBase()}/api/risk/breakdown-snapshots`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const json = (await res.json()) as { snapshots: RiskScoreBreakdownSnapshot[] };
        setSnapshots(json.snapshots ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load risk breakdown");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  if (loading) {
    return (
      <div className="glass-panel p-6">
        <p className="text-sm text-gray-400">Loading risk score breakdown…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-panel p-6">
        <p className="text-sm text-red-300">{error}</p>
      </div>
    );
  }

  return (
    <div className="glass-panel p-6">
      <h3 className="text-lg font-bold mb-1">Risk Score Breakdown</h3>
      <p className="text-xs text-gray-400 mb-4">
        Deterministic reference snapshots showing which component drives each portfolio regime.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {snapshots.map((snapshot) => (
          <div key={snapshot.regime} className="rounded-xl border border-white/10 p-4 bg-white/5">
            <div className="flex items-center justify-between mb-3">
              <p className="font-semibold text-white">{REGIME_LABELS[snapshot.regime]}</p>
              <p className={`text-sm font-bold ${SCORE_COLOR[snapshot.label]}`}>
                {snapshot.portfolioRiskScore.toFixed(1)}/10 · {snapshot.label}
              </p>
            </div>
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <dt className="text-gray-400">TVL</dt>
                <dd className="text-white font-medium">{snapshot.breakdown.tvl.toFixed(2)}</dd>
              </div>
              <div>
                <dt className="text-gray-400">Volatility</dt>
                <dd className="text-white font-medium">{snapshot.breakdown.volatility.toFixed(2)}</dd>
              </div>
              <div>
                <dt className="text-gray-400">Age</dt>
                <dd className="text-white font-medium">{snapshot.breakdown.age.toFixed(2)}</dd>
              </div>
            </dl>
            <p className="text-xs text-gray-500 mt-3">
              Primary driver: <span className="text-gray-300">{dominantComponent(snapshot)}</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
