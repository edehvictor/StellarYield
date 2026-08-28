import { useState, useCallback } from "react";
import React from "react";
import { BarChart2, Plus, Trash2, Loader2, AlertCircle, AlertTriangle, Info, TrendingUp, TrendingDown } from "lucide-react";
import {
  fetchRebalanceBacktest,
  type RebalanceAllocationRule,
  type RebalanceBacktestParams,
  type RebalanceBacktestResult,
  type SimulationWarning,
} from "./rebalanceBacktestService";

interface AllocationRow extends RebalanceAllocationRule {
  id: number;
}

let nextId = 1;

function mkRow(label = "", targetWeight = 0, apy = 0): AllocationRow {
  return { id: nextId++, label, targetWeight, apy };
}

const DEFAULT_ROWS: AllocationRow[] = [
  mkRow("Pool A", 50, 8),
  mkRow("Pool B", 50, 12),
];

function weightTotal(rows: AllocationRow[]) {
  return rows.reduce((s, r) => s + r.targetWeight, 0);
}

function returnColor(pct: number) {
  return pct >= 0 ? "text-green-400" : "text-red-400";
}

function fmt2(n: number) {
  return n.toFixed(2);
}

const SEVERITY_ICON: Record<SimulationWarning["severity"], React.ReactElement> = {
  info: <Info size={14} className="text-blue-400 shrink-0" />,
  warning: <AlertTriangle size={14} className="text-yellow-400 shrink-0" />,
  critical: <AlertCircle size={14} className="text-red-400 shrink-0" />,
};

const SEVERITY_CLASSES: Record<
  SimulationWarning["severity"],
  { container: string; message: string }
> = {
  info: { container: "bg-blue-500/10 border border-blue-500/20", message: "text-blue-300" },
  warning: { container: "bg-yellow-500/10 border border-yellow-500/20", message: "text-yellow-300" },
  critical: { container: "bg-red-500/10 border border-red-500/20", message: "text-red-300" },
};

function BacktestWarningCard({ warning }: { warning: SimulationWarning }) {
  const cls = SEVERITY_CLASSES[warning.severity];
  return (
    <div className={`flex gap-2 p-3 rounded-lg ${cls.container}`} role="alert">
      <div className="mt-0.5">{SEVERITY_ICON[warning.severity]}</div>
      <div className="text-sm space-y-0.5">
        <p className={`font-medium ${cls.message}`}>{warning.message}</p>
        <p className="text-gray-400 text-xs">
          <span className="font-semibold text-gray-300">Suggestion: </span>
          {warning.remediation}
        </p>
        {warning.affectedField && (
          <p className="text-gray-500 text-xs font-mono">Field: {warning.affectedField}</p>
        )}
      </div>
    </div>
  );
}

export default function RebalanceBacktestPanel() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [initialValue, setInitialValue] = useState("100000");
  const [strategy, setStrategy] = useState<"schedule" | "threshold">("schedule");
  const [intervalDays, setIntervalDays] = useState("30");
  const [driftThreshold, setDriftThreshold] = useState("5");
  const [feeBps, setFeeBps] = useState("20");
  const [rows, setRows] = useState<AllocationRow[]>(DEFAULT_ROWS);
  const [result, setResult] = useState<RebalanceBacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const updateRow = useCallback(
    (id: number, field: keyof RebalanceAllocationRule, value: string | number) => {
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
      );
    },
    [],
  );

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, mkRow()]);
  }, []);

  const removeRow = useCallback((id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const handleRun = useCallback(async () => {
    setError("");
    if (!startDate || !endDate) {
      setError("Start and end dates are required");
      return;
    }
    if (new Date(startDate) >= new Date(endDate)) {
      setError("Start date must be before end date");
      return;
    }
    if (rows.length === 0) {
      setError("Add at least one allocation");
      return;
    }
    const total = weightTotal(rows);
    if (Math.abs(total - 100) > 0.01) {
      setError(`Allocation weights must sum to 100% (currently ${fmt2(total)}%)`);
      return;
    }
    if (rows.some((r) => !r.label.trim())) {
      setError("All allocation rows need a label");
      return;
    }

    const params: RebalanceBacktestParams = {
      initialValueUsd: parseFloat(initialValue) || 100_000,
      startDate,
      endDate,
      allocations: rows.map(({ label, targetWeight, apy }) => ({ label, targetWeight, apy })),
      strategy,
      ...(strategy === "schedule"
        ? { rebalanceIntervalDays: parseInt(intervalDays, 10) || 30 }
        : { driftThresholdPct: parseFloat(driftThreshold) || 5 }),
      feeBps: parseInt(feeBps, 10) || 20,
    };

    setLoading(true);
    try {
      setResult(await fetchRebalanceBacktest(params));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backtest failed");
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, initialValue, strategy, intervalDays, driftThreshold, feeBps, rows]);

  const total = weightTotal(rows);
  const weightOk = Math.abs(total - 100) <= 0.01;

  return (
    <div className="space-y-6">
      <div className="glass-panel p-6 space-y-5">
        <div className="flex items-center gap-2">
          <BarChart2 size={20} className="text-indigo-400" />
          <h2 className="text-xl font-semibold">Rebalance Strategy Backtest</h2>
        </div>

        {/* Date range + initial value */}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Initial Value (USD)</label>
            <input
              type="number"
              value={initialValue}
              onChange={(e) => setInitialValue(e.target.value)}
              min={1}
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
        </div>

        {/* Strategy */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Strategy</label>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as "schedule" | "threshold")}
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            >
              <option value="schedule">Scheduled (fixed interval)</option>
              <option value="threshold">Threshold (drift-based)</option>
            </select>
          </div>
          <div>
            {strategy === "schedule" ? (
              <>
                <label className="block text-sm text-gray-400 mb-1.5">Rebalance Interval (days)</label>
                <input
                  type="number"
                  value={intervalDays}
                  onChange={(e) => setIntervalDays(e.target.value)}
                  min={1}
                  className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
                />
              </>
            ) : (
              <>
                <label className="block text-sm text-gray-400 mb-1.5">Drift Threshold (%)</label>
                <input
                  type="number"
                  value={driftThreshold}
                  onChange={(e) => setDriftThreshold(e.target.value)}
                  min={0.1}
                  step={0.1}
                  className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
                />
              </>
            )}
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Fee (bps)</label>
            <input
              type="number"
              value={feeBps}
              onChange={(e) => setFeeBps(e.target.value)}
              min={0}
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
        </div>

        {/* Allocations */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-400">
              Allocations{" "}
              <span className={`font-mono text-xs ${weightOk ? "text-green-400" : "text-amber-400"}`}>
                ({fmt2(total)}% total)
              </span>
            </span>
            <button
              type="button"
              onClick={addRow}
              className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300"
            >
              <Plus size={12} />
              Add pool
            </button>
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 px-1">
              <span className="col-span-5">Label</span>
              <span className="col-span-3 text-right">Weight %</span>
              <span className="col-span-3 text-right">APY %</span>
              <span className="col-span-1" />
            </div>
            {rows.map((row) => (
              <div key={row.id} className="grid grid-cols-12 gap-2 items-center">
                <input
                  className="col-span-5 bg-black/50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
                  placeholder="Pool label"
                  value={row.label}
                  onChange={(e) => updateRow(row.id, "label", e.target.value)}
                />
                <input
                  type="number"
                  className="col-span-3 bg-black/50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white text-right"
                  placeholder="50"
                  value={row.targetWeight || ""}
                  min={0}
                  max={100}
                  step={0.1}
                  onChange={(e) => updateRow(row.id, "targetWeight", parseFloat(e.target.value) || 0)}
                />
                <input
                  type="number"
                  className="col-span-3 bg-black/50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white text-right"
                  placeholder="8"
                  value={row.apy || ""}
                  min={0}
                  step={0.01}
                  onChange={(e) => updateRow(row.id, "apy", parseFloat(e.target.value) || 0)}
                />
                <button
                  type="button"
                  onClick={() => removeRow(row.id)}
                  disabled={rows.length === 1}
                  className="col-span-1 flex justify-center text-gray-600 hover:text-red-400 disabled:opacity-30"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
            <span className="text-sm text-red-400">{error}</span>
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleRun()}
          disabled={loading}
          className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Running…
            </>
          ) : (
            <>
              <BarChart2 className="w-4 h-4" />
              Run Backtest
            </>
          )}
        </button>
      </div>

      {result && (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="glass-panel p-4">
              <p className="text-xs text-gray-500">Portfolio return</p>
              <p className={`text-2xl font-bold ${returnColor(result.portfolioReturnPct)}`}>
                {result.portfolioReturnPct >= 0 ? "+" : ""}
                {fmt2(result.portfolioReturnPct)}%
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                ${result.finalPortfolioValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </p>
            </div>
            <div className="glass-panel p-4">
              <p className="text-xs text-gray-500">Passive (no rebalance)</p>
              <p className={`text-2xl font-bold ${returnColor(result.passiveReturnPct)}`}>
                {result.passiveReturnPct >= 0 ? "+" : ""}
                {fmt2(result.passiveReturnPct)}%
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                ${result.finalPassiveValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </p>
            </div>
            <div className="glass-panel p-4">
              <p className="text-xs text-gray-500">Outperformance</p>
              <div className="flex items-center gap-1">
                {result.outperformancePct >= 0 ? (
                  <TrendingUp size={18} className="text-green-400" />
                ) : (
                  <TrendingDown size={18} className="text-red-400" />
                )}
                <p className={`text-2xl font-bold ${returnColor(result.outperformancePct)}`}>
                  {result.outperformancePct >= 0 ? "+" : ""}
                  {fmt2(result.outperformancePct)}%
                </p>
              </div>
            </div>
            <div className="glass-panel p-4">
              <p className="text-xs text-gray-500">Rebalances / Fees</p>
              <p className="text-2xl font-bold text-white">{result.rebalanceCount}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                ${fmt2(result.totalFeesUsd)} total fees
              </p>
            </div>
          </div>

          {/* Simulation note */}
          <div className="text-xs text-gray-500 text-right">
            Simulation only · {result.startDate} → {result.endDate}
          </div>

          {/* Structured warnings */}
          {result.warnings && result.warnings.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-widest">
                Backtest Warnings ({result.warnings.length})
              </h3>
              {result.warnings.map((w, i) => (
                <BacktestWarningCard key={i} warning={w} />
              ))}
            </div>
          )}

          {/* Equity snapshots (last 20) */}
          <div className="glass-panel p-6">
            <h3 className="text-base font-semibold mb-3">Equity Curve (last 20 days)</h3>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              <div className="grid grid-cols-4 gap-2 text-xs text-gray-500 pb-1 border-b border-white/10">
                <span>Date</span>
                <span className="text-right">Portfolio</span>
                <span className="text-right">Passive</span>
                <span className="text-right">Blended APY</span>
              </div>
              {result.snapshots.slice(-20).map((s) => (
                <div
                  key={s.date}
                  className={`grid grid-cols-4 gap-2 text-xs py-0.5 rounded px-1 ${
                    s.rebalanced ? "bg-indigo-500/10 text-indigo-200" : "text-gray-300"
                  }`}
                >
                  <span className="font-mono">{s.date}{s.rebalanced ? " ↻" : ""}</span>
                  <span className="text-right font-mono">
                    ${s.portfolioValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  <span className="text-right font-mono">
                    ${s.passiveValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  <span className="text-right font-mono">{fmt2(s.blendedApyPct)}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Rebalance events */}
          {result.rebalanceEvents.length > 0 && (
            <div className="glass-panel p-6">
              <h3 className="text-base font-semibold mb-3">
                Rebalance Events ({result.rebalanceEvents.length})
              </h3>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                <div className="grid grid-cols-4 gap-2 text-xs text-gray-500 pb-1 border-b border-white/10">
                  <span>Date</span>
                  <span>Reason</span>
                  <span className="text-right">Max drift</span>
                  <span className="text-right">Fee</span>
                </div>
                {result.rebalanceEvents.map((ev, i) => (
                  <div key={i} className="grid grid-cols-4 gap-2 text-xs text-gray-300 py-0.5">
                    <span className="font-mono">{ev.date}</span>
                    <span className="text-gray-400 truncate">{ev.reason}</span>
                    <span className="text-right font-mono">{fmt2(ev.maxDriftPct)}%</span>
                    <span className="text-right font-mono">${fmt2(ev.feeUsd)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
