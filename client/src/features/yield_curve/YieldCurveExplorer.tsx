/**
 * Interactive Yield Curve Explorer
 *
 * Lets users explore projected yield curves across configurable horizons,
 * compounding cadences, fee assumptions, and protocol allocations, with
 * best-/base-/stress-case views rendered side-by-side.
 *
 * IMPORTANT: outputs are illustrative scenario projections, NOT guaranteed
 * returns. The component surfaces this distinction explicitly via copy and
 * a clearly labelled disclaimer.
 */

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, Info, TrendingUp } from "lucide-react";
import {
  HORIZON_DAYS,
  projectYieldCurve,
  totalWeight,
  validateAssumptions,
} from "./yieldProjection";
import type {
  AllocationLeg,
  CompoundFrequency,
  Horizon,
  ScenarioName,
} from "./types";

const HORIZON_OPTIONS: Horizon[] = ["7d", "30d", "90d", "365d"];

const COMPOUNDING_OPTIONS: CompoundFrequency[] = [
  "daily",
  "weekly",
  "monthly",
  "continuous",
];

const SCENARIO_LABELS: Record<ScenarioName, string> = {
  best: "Best case",
  base: "Base case",
  stress: "Stress case",
};

const SCENARIO_COLORS: Record<ScenarioName, string> = {
  best: "#22c55e",
  base: "#3b82f6",
  stress: "#ef4444",
};

const DEFAULT_ALLOCATIONS: AllocationLeg[] = [
  { id: "blend", label: "Blend", apyPct: 6.5, weightPct: 40 },
  { id: "soroswap", label: "Soroswap", apyPct: 12.2, weightPct: 30 },
  { id: "defindex", label: "DeFindex", apyPct: 8.9, weightPct: 30 },
];

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPct(value: number, decimals = 2): string {
  return `${value.toFixed(decimals)}%`;
}

export interface YieldCurveExplorerProps {
  /** Optional preset legs; defaults to a Blend/Soroswap/DeFindex blend. */
  initialAllocations?: AllocationLeg[];
}

export default function YieldCurveExplorer({
  initialAllocations,
}: YieldCurveExplorerProps = {}) {
  const [horizon, setHorizon] = useState<Horizon>("90d");
  const [compounding, setCompounding] = useState<CompoundFrequency>("daily");
  const [principal, setPrincipal] = useState<number>(10_000);
  const [feeDrag, setFeeDrag] = useState<number>(1.0);
  const [allocations, setAllocations] = useState<AllocationLeg[]>(
    initialAllocations ?? DEFAULT_ALLOCATIONS,
  );

  const assumptions = useMemo(
    () => ({
      principalUsd: principal,
      compounding,
      feeDragPct: feeDrag,
      allocations,
    }),
    [principal, compounding, feeDrag, allocations],
  );

  const validationErrors = useMemo(
    () => validateAssumptions(assumptions),
    [assumptions],
  );

  const result = useMemo(() => {
    if (validationErrors.length) return null;
    return projectYieldCurve(horizon, assumptions);
  }, [horizon, assumptions, validationErrors]);

  const chartData = useMemo(() => {
    if (!result) return [];
    const days = HORIZON_DAYS[horizon];
    const rows: Array<Record<string, number>> = [];
    for (let day = 0; day <= days; day += 1) {
      rows.push({
        day,
        best: result.scenarios.best.points[day].valueUsd,
        base: result.scenarios.base.points[day].valueUsd,
        stress: result.scenarios.stress.points[day].valueUsd,
      });
    }
    return rows;
  }, [result, horizon]);

  const updateAllocation = (id: string, patch: Partial<AllocationLeg>) => {
    setAllocations((prev) =>
      prev.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)),
    );
  };

  const totalAllocationWeight = totalWeight(allocations);

  return (
    <div
      className="glass-panel p-6 space-y-6"
      data-testid="yield-curve-explorer"
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-white flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-blue-400" />
            Yield Curve Explorer
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            Explore projected returns across horizons and scenarios. Adjust
            compounding, fees, and allocation assumptions in real time.
          </p>
        </div>
      </header>

      <div
        role="note"
        className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md p-3"
      >
        <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span>
          Projections are illustrative scenarios based on the inputs below and
          do not represent guaranteed returns. Past performance does not
          guarantee future results.
        </span>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs uppercase text-gray-400 mb-1">
            Horizon
          </label>
          <div role="radiogroup" aria-label="Projection horizon" className="flex gap-2">
            {HORIZON_OPTIONS.map((h) => (
              <button
                key={h}
                type="button"
                role="radio"
                aria-checked={horizon === h}
                onClick={() => setHorizon(h)}
                className={`px-3 py-1.5 rounded text-sm border transition ${
                  horizon === h
                    ? "bg-blue-500/30 border-blue-400 text-white"
                    : "bg-slate-800 border-slate-700 text-gray-300"
                }`}
              >
                {h}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label
            htmlFor="compounding"
            className="block text-xs uppercase text-gray-400 mb-1"
          >
            Compounding
          </label>
          <select
            id="compounding"
            value={compounding}
            onChange={(e) =>
              setCompounding(e.target.value as CompoundFrequency)
            }
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-white"
          >
            {COMPOUNDING_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="principal"
            className="block text-xs uppercase text-gray-400 mb-1"
          >
            Principal (USD)
          </label>
          <input
            id="principal"
            type="number"
            min={0}
            step={100}
            value={principal}
            onChange={(e) => setPrincipal(Number(e.target.value))}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-white"
          />
        </div>

        <div>
          <label
            htmlFor="fee-drag"
            className="block text-xs uppercase text-gray-400 mb-1"
          >
            Fee drag (% / yr): {formatPct(feeDrag)}
          </label>
          <input
            id="fee-drag"
            type="range"
            min={0}
            max={10}
            step={0.1}
            value={feeDrag}
            onChange={(e) => setFeeDrag(Number(e.target.value))}
            className="w-full"
          />
        </div>
      </section>

      <section>
        <header className="flex items-center justify-between mb-2">
          <h3 className="text-sm uppercase text-gray-400">Allocations</h3>
          <span
            className={`text-xs ${
              Math.abs(totalAllocationWeight - 100) <= 0.01
                ? "text-green-400"
                : "text-amber-400"
            }`}
            data-testid="allocation-total"
          >
            Total: {formatPct(totalAllocationWeight, 1)}
          </span>
        </header>
        <div className="space-y-3">
          {allocations.map((leg) => (
            <div
              key={leg.id}
              className="grid grid-cols-12 gap-3 items-center"
              data-testid={`allocation-row-${leg.id}`}
            >
              <span className="col-span-3 text-sm text-white">{leg.label}</span>
              <div className="col-span-3">
                <label className="text-xs text-gray-400 block">APY %</label>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={leg.apyPct}
                  aria-label={`${leg.label} APY`}
                  onChange={(e) =>
                    updateAllocation(leg.id, { apyPct: Number(e.target.value) })
                  }
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-white"
                />
              </div>
              <div className="col-span-6">
                <label className="text-xs text-gray-400 block">
                  Weight: {formatPct(leg.weightPct, 1)}
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={leg.weightPct}
                  aria-label={`${leg.label} weight`}
                  onChange={(e) =>
                    updateAllocation(leg.id, {
                      weightPct: Number(e.target.value),
                    })
                  }
                  className="w-full"
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      {validationErrors.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-md p-3"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <ul className="space-y-1">
            {validationErrors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {result && (
        <>
          <section
            className="grid grid-cols-1 md:grid-cols-3 gap-3"
            data-testid="scenario-summary"
          >
            {(["best", "base", "stress"] as ScenarioName[]).map((name) => {
              const s = result.scenarios[name];
              return (
                <div
                  key={name}
                  data-testid={`scenario-card-${name}`}
                  className="rounded-lg border border-slate-700 bg-slate-900/60 p-3"
                  style={{ borderColor: SCENARIO_COLORS[name] }}
                >
                  <div
                    className="text-xs uppercase tracking-wide"
                    style={{ color: SCENARIO_COLORS[name] }}
                  >
                    {SCENARIO_LABELS[name]}
                  </div>
                  <div className="text-lg font-semibold text-white">
                    {formatUsd(s.finalValueUsd)}
                  </div>
                  <div className="text-xs text-gray-400">
                    {formatPct(s.totalReturnPct)} over {result.horizon}
                  </div>
                  <div className="text-xs text-gray-500">
                    Effective APY: {formatPct(s.effectiveApyPct)}
                  </div>
                </div>
              );
            })}
          </section>

          <section className="h-72" data-testid="yield-curve-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="day" stroke="#64748b" />
                <YAxis
                  stroke="#64748b"
                  tickFormatter={(v: number) => formatUsd(v)}
                />
                <Tooltip
                  formatter={(v: number | string) =>
                    typeof v === "number" ? formatUsd(v) : v
                  }
                  labelFormatter={(label: number | string) => `Day ${label}`}
                  contentStyle={{
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                  }}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="best"
                  name="Best case"
                  stroke={SCENARIO_COLORS.best}
                  fill={SCENARIO_COLORS.best}
                  fillOpacity={0.15}
                />
                <Area
                  type="monotone"
                  dataKey="base"
                  name="Base case"
                  stroke={SCENARIO_COLORS.base}
                  fill={SCENARIO_COLORS.base}
                  fillOpacity={0.15}
                />
                <Area
                  type="monotone"
                  dataKey="stress"
                  name="Stress case"
                  stroke={SCENARIO_COLORS.stress}
                  fill={SCENARIO_COLORS.stress}
                  fillOpacity={0.15}
                />
              </AreaChart>
            </ResponsiveContainer>
          </section>

          <footer className="text-xs text-gray-500" data-testid="explorer-footnotes">
            Blended APY: {formatPct(result.blendedApyPct)} · Net of fees:{" "}
            {formatPct(result.netApyPct)} · Compounding: {compounding}
          </footer>
        </>
      )}
    </div>
  );
}
