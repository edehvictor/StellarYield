import { useState, useEffect, useCallback } from "react";
import { TrendingUp, AlertCircle, Clock, BarChart3 } from "lucide-react";
import { apiUrl } from "../../lib/api";

export interface FragmentationHistorySnapshot {
  timestamp: string;
  fragmentationScore: number;
  effectiveProtocolCount: number;
  hhi: number;
  multiProtocolRoutingPct: number;
  executionQualityScore: number;
}

interface DataFreshness {
  earliestSnapshot: string;
  latestSnapshot: string;
  snapshotCount: number;
}

interface HistoryData {
  snapshots: FragmentationHistorySnapshot[];
  source: "live" | "mock" | "historical";
  dataFreshness: DataFreshness;
  warnings?: string[];
}

interface FragmentationTrendChartProps {
  days?: number;
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateFull(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function FragmentationTrendChart({
  days = 30,
}: FragmentationTrendChartProps) {
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = useState<
    "fragmentationScore" | "effectiveProtocolCount" | "executionQualityScore"
  >("fragmentationScore");

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/liquidity/fragmentation/history?days=${days}`));
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || "Failed to fetch history");
      }

      if (data.success && data.data) {
        setHistory(data.data);
      } else {
        throw new Error("Invalid response format");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const snapshots = history?.snapshots ?? [];

  const metricConfig = {
    fragmentationScore: { label: "Fragmentation Score", unit: "%", color: "#6C5DD3", range: [0, 100] },
    effectiveProtocolCount: { label: "Effective Protocols", unit: "", color: "#10B981", range: [0, 5] },
    executionQualityScore: { label: "Execution Quality", unit: "%", color: "#F59E0B", range: [0, 100] },
  };

  const config = metricConfig[selectedMetric];
  const maxVal = config.range[1];
  const minVal = config.range[0];
  const range = maxVal - minVal;

  const yLabels = [];
  for (let i = 0; i <= 4; i++) {
    yLabels.push(minVal + (range * i) / 4);
  }

  const svgHeight = 200;
  const svgWidth = 600;
  const padding = { top: 20, right: 20, bottom: 30, left: 50 };
  const chartWidth = svgWidth - padding.left - padding.right;
  const chartHeight = svgHeight - padding.top - padding.bottom;

  const points = snapshots.map((s, i) => {
    const x = padding.left + (i / Math.max(snapshots.length - 1, 1)) * chartWidth;
    const val = s[selectedMetric];
    const y = padding.top + chartHeight - ((val - minVal) / range) * chartHeight;
    return { x, y, ...s };
  });

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  return (
    <div className="glass-panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.05)] p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-indigo-500/20 p-2 text-indigo-400">
            <TrendingUp size={20} />
          </div>
          <div>
            <h3 className="text-xl font-bold">Historical Trends</h3>
            <p className="text-xs text-gray-400">
              {history
                ? `${history.dataFreshness.snapshotCount} snapshots over ${days} days`
                : "Loading..."}
            </p>
          </div>
        </div>
        <div className="flex gap-1">
          {(
            Object.entries(metricConfig) as [
              keyof typeof metricConfig,
              typeof config,
            ][]
          ).map(([key, cfg]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedMetric(key)}
              className={`text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors ${
                selectedMetric === key
                  ? "bg-indigo-500/30 text-indigo-300"
                  : "bg-white/5 text-gray-400 hover:bg-white/10"
              }`}
            >
              {cfg.label.split(" ")[0]}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="m-6 flex items-start gap-3 bg-red-950/30 border border-red-500/40 rounded-lg p-4">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-400 mb-1">Error Loading History</p>
            <p className="text-xs text-red-200/80">{error}</p>
          </div>
        </div>
      )}

      {loading && !history && (
        <div className="p-12 text-center">
          <div className="inline-flex items-center gap-2 text-gray-400">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#6C5DD3] border-t-transparent" />
            Loading historical data...
          </div>
        </div>
      )}

      {history?.warnings && history.warnings.length > 0 && (
        <div className="mx-6 mb-2 flex items-start gap-2 bg-amber-950/30 border border-amber-500/40 rounded-lg p-3">
          <AlertCircle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            {history.warnings.map((w, i) => (
              <p key={i} className="text-xs text-amber-200/80">{w}</p>
            ))}
          </div>
        </div>
      )}

      {snapshots.length > 0 && !error && (
        <div className="p-6">
          {/* Trend Chart */}
          <div className="relative overflow-x-auto">
            <svg
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="w-full h-auto"
              style={{ minWidth: `${svgWidth}px` }}
              role="img"
              aria-label={`${config.label} trend chart`}
            >
              {/* Y-axis gridlines and labels */}
              {yLabels.map((val, i) => {
                const y = padding.top + (chartHeight * (4 - i)) / 4;
                return (
                  <g key={i}>
                    <line
                      x1={padding.left}
                      y1={y}
                      x2={svgWidth - padding.right}
                      y2={y}
                      stroke="rgba(255,255,255,0.05)"
                    />
                    <text
                      x={padding.left - 8}
                      y={y + 4}
                      textAnchor="end"
                      className="text-[10px] fill-gray-500"
                    >
                      {selectedMetric === "effectiveProtocolCount"
                        ? val.toFixed(1)
                        : Math.round(val)}
                    </text>
                  </g>
                );
              })}

              {/* Area fill */}
              <defs>
                <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={config.color} stopOpacity="0.2" />
                  <stop offset="100%" stopColor={config.color} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path
                d={`${pathD} L${points[points.length - 1]?.x || padding.left},${padding.top + chartHeight} L${points[0]?.x || padding.left},${padding.top + chartHeight} Z`}
                fill="url(#trendGradient)"
              />

              {/* Line */}
              <path
                d={pathD}
                fill="none"
                stroke={config.color}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />

              {/* Dots */}
              {points.map((p, i) => (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r="3"
                  fill={config.color}
                  stroke="#1A1A24"
                  strokeWidth="1"
                />
              ))}
            </svg>
          </div>

          {/* X-axis labels */}
          <div className="flex justify-between text-[10px] text-gray-500 mt-1 px-[50px]">
            {snapshots.length > 0 && (
              <>
                <span>{formatDate(snapshots[0].timestamp)}</span>
                <span>{formatDate(snapshots[Math.floor(snapshots.length / 2)].timestamp)}</span>
                <span>{formatDate(snapshots[snapshots.length - 1].timestamp)}</span>
              </>
            )}
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-4 mt-6">
            <div className="bg-white/5 rounded-lg p-3">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Latest</p>
              <p className="text-lg font-bold text-white mt-1">
                {selectedMetric === "effectiveProtocolCount"
                  ? snapshots[snapshots.length - 1][selectedMetric].toFixed(2)
                  : Math.round(snapshots[snapshots.length - 1][selectedMetric])}
                {config.unit}
              </p>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Average</p>
              <p className="text-lg font-bold text-white mt-1">
                {selectedMetric === "effectiveProtocolCount"
                  ? (snapshots.reduce((s, v) => s + v[selectedMetric], 0) / snapshots.length).toFixed(2)
                  : Math.round(snapshots.reduce((s, v) => s + v[selectedMetric], 0) / snapshots.length)}
                {config.unit}
              </p>
            </div>
            <div className="bg-white/5 rounded-lg p-3">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Change</p>
              <p className={`text-lg font-bold mt-1 ${
                snapshots.length > 1
                  ? snapshots[snapshots.length - 1][selectedMetric] >= snapshots[0][selectedMetric]
                    ? "text-green-400"
                    : "text-red-400"
                  : "text-white"
              }`}>
                {snapshots.length > 1
                  ? `${(snapshots[snapshots.length - 1][selectedMetric] - snapshots[0][selectedMetric]).toFixed(1)}`
                  : "—"}
                {snapshots.length > 1 && config.unit}
              </p>
            </div>
          </div>

          {/* Data freshness info */}
          <div className="mt-4 flex items-center gap-4 text-[10px] text-gray-500">
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {formatDateFull(history!.dataFreshness.earliestSnapshot)} –{" "}
              {formatDateFull(history!.dataFreshness.latestSnapshot)}
            </span>
            <span className="flex items-center gap-1">
              <BarChart3 size={10} />
              Source: {history!.source}
            </span>
          </div>
        </div>
      )}

      {!loading && !error && snapshots.length === 0 && (
        <div className="p-12 text-center text-gray-500">
          <TrendingUp size={32} className="mx-auto mb-2 opacity-30" />
          <p className="text-sm">No historical data available</p>
          <p className="text-xs mt-1">Historical snapshots will appear once fragmentation tracking begins.</p>
        </div>
      )}
    </div>
  );
}
