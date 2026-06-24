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

type TimeRange = "1M" | "3M" | "All";

interface SharePricePoint {
  date: string;
  sharePrice: number;
}

interface ApiSnapshotPoint {
  date?: unknown;
  sharePrice?: unknown;
}

function formatAxisDate(date: string) {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function filterByRange(data: SharePricePoint[], range: TimeRange): SharePricePoint[] {
  if (range === "All") return data;
  const daysBack = range === "1M" ? 30 : 90;
  const latest = new Date(data[data.length - 1]?.date ?? Date.now());
  const threshold = new Date(latest);
  threshold.setDate(latest.getDate() - daysBack);
  return data.filter((p) => new Date(p.date) >= threshold);
}

function normalizePoint(raw: ApiSnapshotPoint): SharePricePoint | null {
  if (typeof raw.date !== "string") return null;
  const parsed = new Date(raw.date);
  if (Number.isNaN(parsed.getTime())) return null;
  const sharePrice =
    typeof raw.sharePrice === "number" ? raw.sharePrice : Number(raw.sharePrice);
  if (!Number.isFinite(sharePrice) || sharePrice <= 0) return null;
  return { date: raw.date, sharePrice };
}

const rangeOptions: TimeRange[] = ["1M", "3M", "All"];

interface SharePriceChartProps {
  vaultId?: string;
}

export default function SharePriceChart({ vaultId = "primary-yield-vault" }: SharePriceChartProps) {
  const [range, setRange] = useState<TimeRange>("3M");
  const [history, setHistory] = useState<SharePricePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const loadHistory = async (showLoader = true) => {
    if (showLoader) setLoading(true);
    try {
      setError(null);
      const response = await fetch(
        apiUrl(`/api/vaults/${encodeURIComponent(vaultId)}/share-price-history?days=365`),
      );
      if (!response.ok) {
        throw new Error(`Share price history unavailable (${response.status})`);
      }
      const raw = await response.json();
      const rows = Array.isArray(raw) ? raw : [];
      const normalized = rows
        .map((row) => normalizePoint(row as ApiSnapshotPoint))
        .filter((p): p is SharePricePoint => p !== null)
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      setHistory(normalized);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to load share price history";
      setError(message);
      setHistory((prev) => (prev.length > 0 ? prev : []));
    } finally {
      setLoading(false);
      setRetrying(false);
    }
  };

  useEffect(() => {
    void loadHistory();
  }, [vaultId]);

  const filteredHistory = useMemo(() => filterByRange(history, range), [history, range]);

  const priceMin = useMemo(
    () =>
      filteredHistory.length > 0
        ? Math.min(...filteredHistory.map((p) => p.sharePrice))
        : 0,
    [filteredHistory],
  );
  const priceMax = useMemo(
    () =>
      filteredHistory.length > 0
        ? Math.max(...filteredHistory.map((p) => p.sharePrice))
        : 0,
    [filteredHistory],
  );
  const priceDelta = filteredHistory.length >= 2
    ? filteredHistory[filteredHistory.length - 1].sharePrice -
      filteredHistory[0].sharePrice
    : null;
  const priceDeltaPct =
    priceDelta !== null && filteredHistory[0].sharePrice > 0
      ? (priceDelta / filteredHistory[0].sharePrice) * 100
      : null;

  return (
    <div className="glass-card mt-8 p-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-xl font-bold text-white">Share Price History</h3>
          <p className="mt-1 text-sm text-gray-400">
            Historical vault share price over time.
          </p>
          {priceDeltaPct !== null && (
            <p
              className={`mt-1 text-sm font-semibold ${
                priceDeltaPct >= 0 ? "text-green-400" : "text-red-400"
              }`}
            >
              {priceDeltaPct >= 0 ? "+" : ""}
              {priceDeltaPct.toFixed(4)}% over period &nbsp;·&nbsp; min{" "}
              {priceMin.toFixed(6)} &nbsp;·&nbsp; max {priceMax.toFixed(6)}
            </p>
          )}
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
              Loading share price history…
            </p>
            <div className="h-full w-full animate-pulse bg-gradient-to-r from-gray-700/30 via-gray-600/30 to-gray-700/30 rounded-lg" />
          </div>
        ) : error && history.length === 0 ? (
          <div className="h-full w-full rounded-lg border border-red-500/30 bg-red-500/10 px-6 py-8 flex flex-col items-center justify-center text-center">
            <AlertTriangle size={24} className="text-red-300 mb-3" />
            <p className="text-red-100 font-semibold">Unable to load share price history</p>
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
            <p className="text-gray-300 font-semibold">No share price snapshots available</p>
            <p className="text-gray-500 text-sm mt-1">
              No recorded snapshots for this period. Snapshots are taken daily.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={filteredHistory}
              margin={{ top: 12, right: 12, left: -4, bottom: 0 }}
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
                domain={["dataMin - 0.0001", "dataMax + 0.0001"]}
                tickFormatter={(v: number) => v.toFixed(4)}
                stroke="#94a3b8"
                tick={{ fill: "#94a3b8", fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={62}
              />
              <Tooltip
                formatter={(value: number) => [value.toFixed(6), "Share Price"]}
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
                cursor={{ stroke: "rgba(52, 211, 153, 0.6)", strokeWidth: 1 }}
              />
              <Line
                type="monotone"
                dataKey="sharePrice"
                stroke="#34D399"
                strokeWidth={3}
                dot={{ r: 0 }}
                activeDot={{
                  r: 5,
                  stroke: "#ffffff",
                  strokeWidth: 2,
                  fill: "#34D399",
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
