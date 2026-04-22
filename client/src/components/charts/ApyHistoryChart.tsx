import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type TimeRange = "1W" | "1M" | "All";

interface HistoricalApyPoint {
  date: string;
  apy: number;
}

const mockHistory: HistoricalApyPoint[] = [
  { date: "2026-02-20", apy: 8.12 },
  { date: "2026-02-24", apy: 8.34 },
  { date: "2026-02-28", apy: 8.2 },
  { date: "2026-03-03", apy: 8.56 },
  { date: "2026-03-06", apy: 8.75 },
  { date: "2026-03-09", apy: 8.63 },
  { date: "2026-03-12", apy: 8.91 },
  { date: "2026-03-15", apy: 9.08 },
  { date: "2026-03-18", apy: 8.84 },
  { date: "2026-03-20", apy: 9.16 },
  { date: "2026-03-22", apy: 9.28 },
  { date: "2026-03-25", apy: 9.41 },
];

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

export default function ApyHistoryChart() {
  const [range, setRange] = useState<TimeRange>("1M");
  const [history, setHistory] = useState<HistoricalApyPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadHistory() {
      try {
        const response = await fetch(
          "http://localhost:3001/api/yields/history",
        );

        if (!response.ok) {
          throw new Error("History endpoint unavailable");
        }

        const data = (await response.json()) as HistoricalApyPoint[];
        setHistory(data.length > 0 ? data : mockHistory);
      } catch (error) {
        console.warn("Using mock APY history data", error);
        setHistory(mockHistory);
      } finally {
        setLoading(false);
      }
    }

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
          <div className="flex h-full items-center justify-center text-gray-400">
            Loading APY history...
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
