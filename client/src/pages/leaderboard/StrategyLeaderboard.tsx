import React, { useEffect, useState } from "react";
import { Trophy, Medal, TrendingUp, Filter } from "lucide-react";
import { apiUrl } from "../../lib/api";
import { ConfidenceBadge } from "../../components/AIAdvisor/ConfidenceBadge";

interface RankedStrategy {
  rank: number;
  id: string;
  name: string;
  strategyType: string;
  apy: number;
  tvlUsd: number;
  riskScore: number;
  riskAdjustedYield: number;
  drawdownProxy: number;
}

interface LeaderboardResponse {
  items: RankedStrategy[];
  filters: { timeWindow: string; strategyType: string };
  total: number;
  scoringMethodology: string;
}

const TIME_WINDOWS = ["all", "24h", "7d", "30d"] as const;
const STRATEGY_TYPES = ["all", "blend", "soroswap", "defindex"] as const;

const StrategyLeaderboard: React.FC = () => {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeWindow, setTimeWindow] = useState<string>("all");
  const [strategyType, setStrategyType] = useState<string>("all");

  // #375 Rotation Confidence Explorer
  const [rotationData, setRotationData] = useState<{
    current: { id: string | null; score: number | null; lastRotatedAt: string | null };
    decisions: Array<{
      action: string;
      reason: string;
      fromId: string | null;
      toId: string | null;
      scoreDelta: number | null;
      detail: string;
      evaluatedAt: string;
      confidenceBreakdown?: any;
      confidenceStrength?: "borderline" | "strongly_favored";
      confidenceWhy?: string[];
    }>;
  } | null>(null);
  const [rotationLoading, setRotationLoading] = useState(true);
  const [rotationError, setRotationError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ timeWindow, strategyType });
    fetch(apiUrl(`/api/strategies/leaderboard?${params}`))
      .then((res) => res.json())
      .then((d: LeaderboardResponse) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch strategy leaderboard", err);
        setLoading(false);
      });
  }, [timeWindow, strategyType]);

  useEffect(() => {
    setRotationLoading(true);
    setRotationError(null);
    fetch(apiUrl("/api/strategies/rotation?limit=10"))
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as {
          current: { id: string | null; score: number | null; lastRotatedAt: string | null };
          decisions: any[];
        };
      })
      .then((d) => setRotationData(d))
      .catch((err) => setRotationError(err instanceof Error ? err.message : "Failed to load rotation data"))
      .finally(() => setRotationLoading(false));
  }, []);

  const latestDecision =
    rotationData?.decisions?.find((d) => d.action === "rotate") ??
    rotationData?.decisions?.[0];

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div className="text-center space-y-2">
        <h2 className="text-4xl font-black tracking-tight text-white flex items-center justify-center gap-3">
          <Trophy className="text-yellow-500" size={40} />
          RISK-ADJUSTED YIELD LEADERBOARD
        </h2>
        <p className="text-gray-400 max-w-2xl mx-auto italic">
          Strategies ranked by risk-adjusted yield (RAY): higher APY with lower risk scores higher.
        </p>
        {data?.scoringMethodology && (
          <p className="text-xs text-gray-500 max-w-xl mx-auto">
            {data.scoringMethodology}
          </p>
        )}
      </div>

      {/* Filters */}
      <div className="glass-panel p-4 flex flex-wrap gap-4 items-center">
        <Filter size={16} className="text-gray-400" />
        <div className="flex gap-2 items-center">
          <label className="text-xs text-gray-400 uppercase tracking-widest">Time</label>
          {TIME_WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setTimeWindow(w)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors ${
                timeWindow === w
                  ? "bg-indigo-500 text-white"
                  : "bg-white/5 text-gray-400 hover:bg-white/10"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-xs text-gray-400 uppercase tracking-widest">Type</label>
          {STRATEGY_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setStrategyType(t)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors ${
                strategyType === t
                  ? "bg-purple-500 text-white"
                  : "bg-white/5 text-gray-400 hover:bg-white/10"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-48">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500" />
        </div>
      ) : (
        <div className="glass-panel overflow-hidden border border-white/10 shadow-2xl">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-white/5 text-gray-400 text-xs uppercase tracking-widest font-bold">
                <th className="px-6 py-4">Rank</th>
                <th className="px-6 py-4">Strategy</th>
                <th className="px-6 py-4">Type</th>
                <th className="px-6 py-4">APY</th>
                <th className="px-6 py-4">Risk Score</th>
                <th className="px-6 py-4">
                  <span className="flex items-center gap-1">
                    <TrendingUp size={12} /> RAY
                  </span>
                </th>
                <th className="px-6 py-4">TVL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(data?.items ?? []).map((s) => (
                <tr
                  key={s.id}
                  className={`hover:bg-white/5 transition-colors ${s.rank <= 3 ? "bg-indigo-500/5" : ""}`}
                >
                  <td className="px-6 py-4 font-mono text-lg flex items-center gap-2">
                    {s.rank === 1 && <Medal className="text-yellow-400" size={18} />}
                    {s.rank === 2 && <Medal className="text-gray-300" size={18} />}
                    {s.rank === 3 && <Medal className="text-orange-400" size={18} />}
                    #{s.rank}
                  </td>
                  <td className="px-6 py-4 font-semibold text-white">{s.name}</td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-0.5 rounded bg-white/10 text-gray-300 text-xs uppercase">
                      {s.strategyType}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-green-400 font-bold">{s.apy.toFixed(2)}%</td>
                  <td className="px-6 py-4">
                    <span
                      className={`font-semibold ${
                        s.riskScore >= 7
                          ? "text-green-400"
                          : s.riskScore >= 4
                          ? "text-yellow-400"
                          : "text-red-400"
                      }`}
                    >
                      {s.riskScore.toFixed(1)}/10
                    </span>
                  </td>
                  <td className="px-6 py-4 text-indigo-300 font-bold">
                    {s.riskAdjustedYield.toFixed(3)}
                  </td>
                  <td className="px-6 py-4 text-gray-300">
                    ${s.tvlUsd.toLocaleString()}
                  </td>
                </tr>
              ))}
              {(data?.items ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                    No strategies found for the selected filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* #375 Rotation Confidence Explorer */}
      <div className="glass-panel p-6 border border-white/10 shadow-2xl mt-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-xl font-bold text-white">Rotation Confidence Explorer</h3>
            <p className="text-xs text-gray-400 mt-1">
              Confidence decomposition for the most recent rotation evaluation.
            </p>
          </div>
        </div>

        {rotationLoading ? (
          <div className="flex justify-center items-center py-10">
            <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-indigo-500" />
          </div>
        ) : rotationError ? (
          <div className="py-6 text-center text-red-400 text-sm">{rotationError}</div>
        ) : !latestDecision ? (
          <div className="py-6 text-center text-gray-400 text-sm">No rotation decisions available.</div>
        ) : (
          <div className="space-y-4 mt-4">
            <div className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-xs text-gray-400 uppercase tracking-widest">Decision</p>
                  <p className="text-lg font-bold text-white">
                    {latestDecision.action === "rotate"
                      ? `Rotate → ${latestDecision.toId}`
                      : `Hold (${latestDecision.reason})`}
                  </p>
                  <p className="text-xs text-gray-400">
                    {latestDecision.detail}
                  </p>
                </div>
                {latestDecision.confidenceBreakdown ? (
                  <span className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-gray-300">
                    {(latestDecision.confidenceStrength === "borderline")
                      ? "Borderline"
                      : "Strongly favored"}
                  </span>
                ) : null}
              </div>
            </div>

            {latestDecision.confidenceBreakdown ? (
              <>
                <ConfidenceBadge confidence={latestDecision.confidenceBreakdown} compact />
                {latestDecision.confidenceWhy?.length ? (
                  <ul className="text-xs text-gray-300 space-y-0.5">
                    {latestDecision.confidenceWhy.slice(0, 3).map((w: string, i: number) => (
                      <li key={i}>• {w}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-gray-400">
                Confidence decomposition is only shown when a rotation candidate is selected.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default StrategyLeaderboard;
