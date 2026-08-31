import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, RefreshCw } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiUrl } from "../../lib/api";
import { computeDecayedFreshnessConfidence } from "../dashboard/freshnessDecay";
import { formatApy } from "../../lib/apyFormat";

type TimeRange = "1W" | "1M" | "All";

/** Threshold (ms) beyond which an APY sample is considered stale. Matches ApyDashboard convention. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

interface HistoricalApyPoint {
  date: string;
  apy: number;
  /** ISO-8601 timestamp when this data point was fetched from the source. */
  fetchedAt?: string;
  /** Computed freshness confidence [0, 1]; populated during normalisation. */
  freshnessConfidence?: number;
  /** True when the point is considered unusable due to age. */
  stale?: boolean;
}

interface ApiHistoryPoint {
  date?: unknown;
  apy?: unknown;
  fetchedAt?: unknown;
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

function normalizeFetchedAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : value;
}

function normalizeHistoryPoint(point: ApiHistoryPoint, now = Date.now()): HistoricalApyPoint | null {
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

  const fetchedAt = normalizeFetchedAt(point.fetchedAt);
  const fetchedTime = fetchedAt ? new Date(fetchedAt).getTime() : now;
  const ageMs = now - fetchedTime;
  const { confidence, unusable } = computeDecayedFreshnessConfidence(ageMs);

  return {
    date: point.date,
    apy,
    fetchedAt,
    freshnessConfidence: confidence,
    stale: unusable || ageMs > STALE_THRESHOLD_MS,
  };
}

// ── Source health summary for tooltip (#1005) ─────────────────────────────────

interface SourceHealthSummary {
  /** Number of data points in the visible range. */
  total: number;
  /** Number of stale points. */
  staleCount: number;
  /** Average freshness confidence across all points (0–1). */
  avgConfidence: number;
  /** True when every visible point is stale beyond the threshold. */
  allStale: boolean;
}

function computeSourceHealth(points: HistoricalApyPoint[]): SourceHealthSummary {
  if (points.length === 0) {
    return { total: 0, staleCount: 0, avgConfidence: 0, allStale: false };
  }
  const staleCount = points.filter((p) => p.stale).length;
  const avgConfidence =
    points.reduce((sum, p) => sum + (p.freshnessConfidence ?? 1), 0) / points.length;
  return {
    total: points.length,
    staleCount,
    avgConfidence,
    allStale: staleCount === points.length,
  };
}

// ── Custom Tooltip with source health metadata (#1005) ────────────────────────

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; payload: HistoricalApyPoint }>;
  label?: string;
  sourceHealth: SourceHealthSummary;
}

function CustomTooltip({ active, payload, label, sourceHealth }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;

  const point = payload[0].payload;
  const apy = payload[0].value;
  const confidence = point.freshnessConfidence ?? 1;
  const isStale = point.stale ?? false;

  const fetchedAgo = point.fetchedAt
    ? Math.max(0, Math.round((Date.now() - new Date(point.fetchedAt).getTime()) / 60_000))
    : null;

  const dateLabel = label
    ? new Date(label).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

  return (
    <div
      style={{
        backgroundColor: "rgba(15, 23, 42, 0.94)",
        border: "1px solid rgba(148, 163, 184, 0.2)",
        borderRadius: "16px",
        boxShadow: "0 12px 30px rgba(0, 0, 0, 0.35)",
        padding: "12px 16px",
        minWidth: 200,
      }}
    >
      <p style={{ color: "#94a3b8", fontSize: 12, marginBottom: 6 }}>{dateLabel}</p>
      <p style={{ color: "#6C5DD3", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
        {formatApy(apy)} APY
      </p>

      {/* Per-point freshness */}
      {isStale ? (
        <p style={{ color: "#f87171", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
          ⚠ Stale sample
          {fetchedAgo !== null && ` · fetched ${fetchedAgo}m ago`}
        </p>
      ) : (
        <p style={{ color: "#86efac", fontSize: 11 }}>
          ✓ Fresh · {Math.round(confidence * 100)}% confidence
          {fetchedAgo !== null && ` · ${fetchedAgo}m ago`}
        </p>
      )}

      {/* Source health summary */}
      <div style={{ borderTop: "1px solid rgba(148,163,184,0.15)", marginTop: 8, paddingTop: 8 }}>
        <p style={{ color: "#94a3b8", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>
          Series health
        </p>
        <p style={{ color: "#94a3b8", fontSize: 11 }}>
          {sourceHealth.staleCount}/{sourceHealth.total} stale points
        </p>
        <p style={{ color: "#94a3b8", fontSize: 11 }}>
          Avg confidence: {Math.round(sourceHealth.avgConfidence * 100)}%
        </p>
        {sourceHealth.allStale && (
          <p style={{ color: "#f87171", fontSize: 11, marginTop: 2 }}>All series data is stale</p>
        )}
      </div>
    </div>
  );
}

interface PredictionPoint {
  date: string;
  predictedApy: number;
  lowerApy: number;
  upperApy: number;
  confidence?: number;
}

export default function ApyHistoryChart() {
  const [range, setRange] = useState<TimeRange>("1M");
  const [history, setHistory] = useState<HistoricalApyPoint[]>([]);
  const [predictions, setPredictions] = useState<PredictionPoint[]>([]);
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
      const rows = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.historical)
          ? raw.historical
          : [];
      const predRows = Array.isArray(raw?.predictions)
        ? (raw.predictions as PredictionPoint[])
        : [];
      const now = Date.now();
      const normalized = (rows as unknown[])
        .map((row: unknown) => normalizeHistoryPoint(row as ApiHistoryPoint, now))
        .filter((point: HistoricalApyPoint | null): point is HistoricalApyPoint => point !== null)
        .sort((a: HistoricalApyPoint, b: HistoricalApyPoint) => new Date(a.date).getTime() - new Date(b.date).getTime());
      setHistory(normalized);
      setPredictions(predRows);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to load APY history";
      setError(message);
      setHistory((prev) => (prev.length > 0 ? prev : []));
      setPredictions([]);
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

  const sourceHealth = useMemo(
    () => computeSourceHealth(filteredHistory),
    [filteredHistory],
  );

  // Indices of stale points — used to render ReferenceLine stale markers
  const stalePointDates = useMemo(
    () => filteredHistory.filter((p) => p.stale).map((p) => p.date),
    [filteredHistory],
  );

  const combinedData = useMemo(() => {
    if (predictions.length === 0) return filteredHistory;
    return [...filteredHistory, ...predictions];
  }, [filteredHistory, predictions]);

  return (
    <div className="glass-card mt-8 p-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-xl font-bold text-white">
            {predictions.length > 0 ? "APY Forecast" : "APY History"}
          </h3>
          <p className="mt-1 text-sm text-gray-400">
            {predictions.length > 0
              ? "Review historical yields alongside forecast confidence bands reflecting market uncertainty."
              : "Review recent yield changes before committing to a vault."}
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

      {/* Stale series banner — shown when every visible point is stale (#1005) */}
      {!loading && !error && sourceHealth.allStale && filteredHistory.length > 0 && (
        <div
          className="mb-4 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300"
          role="status"
          aria-label="All APY history data is stale"
          data-testid="apy-history-all-stale-banner"
        >
          <AlertTriangle size={16} aria-hidden="true" />
          <span>All visible data is stale. Chart may not reflect current market conditions.</span>
        </div>
      )}

      {/* Partial stale banner — some but not all points are stale */}
      {!loading && !error && !sourceHealth.allStale && sourceHealth.staleCount > 0 && filteredHistory.length > 0 && (
        <div
          className="mb-4 flex items-center gap-2 rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-2.5 text-xs text-yellow-300"
          role="status"
          aria-label={`${sourceHealth.staleCount} of ${sourceHealth.total} APY history points are stale`}
          data-testid="apy-history-partial-stale-banner"
        >
          <Clock size={14} aria-hidden="true" />
          <span>
            {sourceHealth.staleCount} of {sourceHealth.total} data points are stale ·{" "}
            avg. confidence {Math.round(sourceHealth.avgConfidence * 100)}%
          </span>
        </div>
      )}

      <div className="h-[320px] w-full sm:h-[360px]">
        {loading ? (
          <div className="h-full w-full rounded-lg border border-white/10 bg-white/[0.02] p-5">
            <p className="text-sm text-gray-400 mb-3" role="status">
              Loading APY history / Loading APY forecast...
            </p>
            <div className="h-full w-full animate-pulse bg-gradient-to-r from-gray-700/30 via-gray-600/30 to-gray-700/30 rounded-lg" />
          </div>
        ) : error && history.length === 0 && predictions.length === 0 ? (
          <div className="h-full w-full rounded-lg border border-red-500/30 bg-red-500/10 px-6 py-8 flex flex-col items-center justify-center text-center">
            <AlertTriangle size={24} className="text-red-300 mb-3" />
            <p className="text-red-100 font-semibold">Unable to load APY history / Unable to load APY forecast</p>
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
        ) : sourceHealth.allStale && filteredHistory.length > 0 && predictions.length === 0 ? (
          /* All-stale empty state (#1005) */
          <div
            className="h-full w-full rounded-lg border border-amber-500/30 bg-amber-500/10 px-6 py-8 flex flex-col items-center justify-center text-center"
            data-testid="apy-history-all-stale-empty"
          >
            <AlertTriangle size={24} className="text-amber-300 mb-3" />
            <p className="text-amber-200 font-semibold">All APY history is stale</p>
            <p className="text-amber-300/80 text-sm mt-1 max-w-sm">
              Source data has not been refreshed within the expected window. Chart may not reflect current market conditions.
            </p>
          </div>
        ) : filteredHistory.length === 0 && predictions.length === 0 ? (
          <div className="h-full w-full rounded-lg border border-white/10 bg-white/[0.02] px-6 py-8 flex flex-col items-center justify-center text-center">
            <p className="text-gray-300 font-semibold">No APY history points available</p>
            <p className="text-gray-500 text-sm mt-1">
              The API returned no valid entries for this range.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={combinedData}
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
                tickFormatter={(value) => formatApy(value)}
                stroke="#94a3b8"
                tick={{ fill: "#94a3b8", fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={54}
              />

              {/* Stale sample markers — vertical reference lines at each stale date (#1005) */}
              {stalePointDates.map((date) => (
                <ReferenceLine
                  key={date}
                  x={date}
                  stroke="rgba(251, 191, 36, 0.35)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  aria-label={`Stale data point at ${date}`}
                />
              ))}

              <Tooltip
                content={<CustomTooltip sourceHealth={sourceHealth} />}
                cursor={{ stroke: "rgba(108, 93, 211, 0.6)", strokeWidth: 1 }}
              />
              <Line
                type="monotone"
                dataKey="apy"
                stroke="#6C5DD3"
                strokeWidth={3}
                dot={(props) => {
                  const { cx, cy, payload } = props as {
                    cx: number;
                    cy: number;
                    payload: HistoricalApyPoint;
                  };
                  if (payload.stale) {
                    return (
                      <circle
                        key={`stale-dot-${payload.date}`}
                        cx={cx}
                        cy={cy}
                        r={4}
                        fill="rgba(251, 191, 36, 0.7)"
                        stroke="rgba(251, 191, 36, 0.9)"
                        strokeWidth={1.5}
                        aria-label={`Stale APY sample on ${payload.date}`}
                      />
                    );
                  }
                  return <circle key={`dot-${payload.date}`} cx={cx} cy={cy} r={0} fill="none" />;
                }}
                activeDot={{
                  r: 5,
                  stroke: "#ffffff",
                  strokeWidth: 2,
                  fill: "#6C5DD3",
                }}
              />
              {predictions.length > 0 && (
                <>
                  <Line
                    type="monotone"
                    dataKey="predictedApy"
                    stroke="#A78BFA"
                    strokeWidth={2}
                    strokeDasharray="3 3"
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="lowerApy"
                    stroke="rgba(167, 139, 250, 0.4)"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="upperApy"
                    stroke="rgba(167, 139, 250, 0.4)"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                    dot={false}
                  />
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
