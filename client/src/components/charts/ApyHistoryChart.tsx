import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiUrl } from "../../lib/api";

type TimeRange = "1W" | "1M" | "All";

interface HistoricalApyPoint {
  date: string;
  apy: number;
}

interface ApiHistoryPoint {
  date?: unknown;
  apy?: unknown;
}

function formatAxisDate(date: string) {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function filterHistory(history: HistoricalApyPoint[], range: TimeRange) {
  if (range === "All") {
    return history;
  }

  const daysBack = range === "1W" ? 7 : 30;
  const latest = new Date(history[history.length - 1]?.date ?? Date.now());
  const threshold = new Date(latest);
  threshold.setDate(latest.getDate() - daysBack);

  return history.filter((point) => new Date(point.date) >= threshold);
}

const rangeOptions: TimeRange[] = ["1W", "1M", "All"];

function normalizeHistoryPoint(point: ApiHistoryPoint): HistoricalApyPoint | null {
  if (typeof point.date !== "string") {
    return null;
  }

  const parsedDate = new Date(point.date);
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  const apy = typeof point.apy === "number" ? point.apy : Number(point.apy);
  if (!Number.isFinite(apy)) {
    return null;
  }

  return { date: point.date, apy };
}

export default function ApyHistoryChart() {
  const [range, setRange] = useState<TimeRange>("1M");
  const [history, setHistory] = useState<HistoricalApyPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const loadHistory = async (showLoader = true) => {
    if (showLoader) {
      setLoading(true);
    }

    try {
      setError(null);
      const response = await fetch(apiUrl("/api/yields/history"));

      if (!response.ok) {
        throw new Error(`History endpoint unavailable (${response.status})`);
      }

      const raw = await response.json();
      const rows = Array.isArray(raw) ? raw : [];
      const normalized = rows
        .map((row) => normalizeHistoryPoint(row as ApiHistoryPoint))
        .filter((point): point is HistoricalApyPoint => point !== null)
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      setHistory(normalized);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to load APY history";
      setError(message);
      setHistory((prev) => (prev.length > 0 ? prev : []));
    } finally {
      setLoading(false);
      setRetrying(false);
    }
  };

  useEffect(() => {
    void loadHistory();
  }, []);

  const filteredHistory = useMemo(
    () => filterHistory(history, range),
    [history, range],
  );

  return (
    <div className="glass-card mt-8 p-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-xl font-bold text-white">APY History</h3>
          <p className="mt-1 text-sm text-gray-400">
            Review recent yield changes before committing to a vault.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {rangeOptions.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRange(option)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                range === option
                  ? "bg-[#6C5DD3] text-white shadow-lg shadow-[#6C5DD3]/30"
                  : "bg-white/5 text-gray-300 hover:bg-white/10"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="h-[320px] w-full sm:h-[360px]">
        {loading ? (
          <div className="h-full w-full rounded-lg border border-white/10 bg-white/[0.02] p-5">
            <p className="text-sm text-gray-400 mb-3" role="status">
              Loading APY history...
            </p>
            <div className="h-full w-full animate-pulse bg-gradient-to-r from-gray-700/30 via-gray-600/30 to-gray-700/30 rounded-lg" />
          </div>
        ) : error && history.length === 0 ? (
          <div className="h-full w-full rounded-lg border border-red-500/30 bg-red-500/10 px-6 py-8 flex flex-col items-center justify-center text-center">
            <AlertTriangle size={24} className="text-red-300 mb-3" />
            <p className="text-red-100 font-semibold">Unable to load APY history</p>
            <p className="text-red-200/90 text-sm mt-1 max-w-sm">{error}</p>
            <button
              type="button"
              onClick={() => {
                setRetrying(true);
                void loadHistory(false);
              }}
              className="btn-secondary mt-4 inline-flex items-center gap-2"
            >
              <RefreshCw size={14} className={retrying ? "animate-spin" : ""} />
              Retry
            </button>
          </div>
        ) : filteredHistory.length === 0 ? (
          <div className="h-full w-full rounded-lg border border-white/10 bg-white/[0.02] px-6 py-8 flex flex-col items-center justify-center text-center">
            <p className="text-gray-300 font-semibold">No APY history points available</p>
            <p className="text-gray-500 text-sm mt-1">
              The API returned no valid entries for this range.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={filteredHistory}
              margin={{ top: 12, right: 12, left: -16, bottom: 0 }}
            >
              <CartesianGrid
                stroke="rgba(255,255,255,0.08)"
                strokeDasharray="4 4"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tickFormatter={formatAxisDate}
                stroke="#94a3b8"
                tick={{ fill: "#94a3b8", fontSize: 12 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={["dataMin - 0.4", "dataMax + 0.4"]}
                tickFormatter={(value) => `${value.toFixed(1)}%`}
                stroke="#94a3b8"
                tick={{ fill: "#94a3b8", fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={54}
              />
              <Tooltip
                formatter={(value: number) => [`${value.toFixed(2)}%`, "APY"]}
                labelFormatter={(label) =>
                  new Date(label).toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                }
                contentStyle={{
                  backgroundColor: "rgba(15, 23, 42, 0.94)",
                  border: "1px solid rgba(148, 163, 184, 0.2)",
                  borderRadius: "16px",
                  boxShadow: "0 12px 30px rgba(0, 0, 0, 0.35)",
                }}
                cursor={{ stroke: "rgba(108, 93, 211, 0.6)", strokeWidth: 1 }}
              />
              <Line
                type="monotone"
                dataKey="apy"
                stroke="#6C5DD3"
                strokeWidth={3}
                dot={{ r: 0 }}
                activeDot={{
                  r: 5,
                  stroke: "#ffffff",
                  strokeWidth: 2,
                  fill: "#6C5DD3",
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
