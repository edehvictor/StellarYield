import React, { useState } from "react";
import { FlaskConical, AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";
import { apiUrl } from "../../lib/api";

type ProposalType = "fee_change" | "allocation_limit" | "strategy_param";

interface ForecastResult {
  proposalType: ProposalType;
  parameters: Record<string, number>;
  baseline: {
    yieldPct: number;
    exposurePct: number;
    feeRatePct: number;
    tvlUsd: number;
  };
  forecast: {
    yieldDeltaPct: number;
    exposureDeltaPct: number;
    feeRevenueDeltaUsd: number;
    projectedYieldPct: number;
    projectedExposurePct: number;
    projectedFeeRatePct: number;
  };
  warnings: string[];
  disclaimer: string;
}

const PROPOSAL_TYPES: { value: ProposalType; label: string }[] = [
  { value: "fee_change", label: "Fee Change" },
  { value: "allocation_limit", label: "Allocation Limit" },
  { value: "strategy_param", label: "Strategy Parameter" },
];

const GovernanceForecast: React.FC = () => {
  const [proposalType, setProposalType] = useState<ProposalType>("fee_change");
  const [paramKey, setParamKey] = useState("feeRatePct");
  const [paramValue, setParamValue] = useState("3");
  const [baseYield, setBaseYield] = useState("8");
  const [baseExposure, setBaseExposure] = useState("40");
  const [baseFeeRate, setBaseFeeRate] = useState("2");
  const [baseTvl, setBaseTvl] = useState("10000000");
  const [result, setResult] = useState<ForecastResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const PARAM_HINTS: Record<ProposalType, string> = {
    fee_change: "feeRatePct",
    allocation_limit: "maxConcentrationPct",
    strategy_param: "apyMultiplier",
  };

  function handleTypeChange(t: ProposalType) {
    setProposalType(t);
    setParamKey(PARAM_HINTS[t]);
    setResult(null);
  }

  async function handleForecast() {
    setError("");
    const pv = parseFloat(paramValue);
    if (!Number.isFinite(pv)) {
      setError("Parameter value must be a number");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/governance/forecast"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalType,
          parameters: { [paramKey]: pv },
          baseline: {
            yieldPct: parseFloat(baseYield) || 0,
            exposurePct: parseFloat(baseExposure) || 0,
            feeRatePct: parseFloat(baseFeeRate) || 0,
            tvlUsd: parseFloat(baseTvl) || 0,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "Forecast failed");
      } else {
        setResult(await res.json());
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  const delta = result?.forecast;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FlaskConical size={28} className="text-purple-400" />
        <div>
          <h3 className="text-2xl font-bold">Proposal Impact Forecast</h3>
          <p className="text-gray-400 text-sm">
            Model expected changes to yield, exposure, and fees before voting.
          </p>
        </div>
      </div>

      {/* Proposal type selector */}
      <div className="glass-card p-5 space-y-4">
        <div className="flex gap-2 flex-wrap">
          {PROPOSAL_TYPES.map((pt) => (
            <button
              key={pt.value}
              onClick={() => handleTypeChange(pt.value)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                proposalType === pt.value
                  ? "bg-purple-500 text-white"
                  : "bg-white/5 text-gray-400 hover:bg-white/10"
              }`}
            >
              {pt.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1 uppercase tracking-widest">
              Parameter Key
            </label>
            <input
              value={paramKey}
              onChange={(e) => setParamKey(e.target.value)}
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1 uppercase tracking-widest">
              Proposed Value
            </label>
            <input
              type="number"
              value={paramValue}
              onChange={(e) => setParamValue(e.target.value)}
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
        </div>

        <details className="text-sm">
          <summary className="text-gray-400 cursor-pointer hover:text-white transition-colors">
            Baseline Parameters
          </summary>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
            {[
              { label: "Yield %", value: baseYield, set: setBaseYield },
              { label: "Exposure %", value: baseExposure, set: setBaseExposure },
              { label: "Fee Rate %", value: baseFeeRate, set: setBaseFeeRate },
              { label: "TVL (USD)", value: baseTvl, set: setBaseTvl },
            ].map((f) => (
              <div key={f.label}>
                <label className="block text-xs text-gray-500 mb-1">{f.label}</label>
                <input
                  type="number"
                  value={f.value}
                  onChange={(e) => f.set(e.target.value)}
                  className="w-full bg-black/50 border border-gray-700 rounded px-2 py-1 text-white text-sm"
                />
              </div>
            ))}
          </div>
        </details>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <AlertTriangle size={16} className="text-red-400" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      <button
        onClick={handleForecast}
        disabled={loading}
        className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg flex items-center justify-center gap-2"
      >
        <FlaskConical size={18} />
        {loading ? "Forecasting…" : "Run Impact Forecast"}
      </button>

      {result && delta && (
        <div className="glass-card p-6 space-y-5 border border-purple-500/20">
          <h4 className="text-lg font-bold text-white">Forecast Results</h4>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <MetricCard
              label="Yield Delta"
              value={`${delta.yieldDeltaPct >= 0 ? "+" : ""}${delta.yieldDeltaPct.toFixed(4)}%`}
              positive={delta.yieldDeltaPct >= 0}
            />
            <MetricCard
              label="Projected Yield"
              value={`${delta.projectedYieldPct.toFixed(4)}%`}
              neutral
            />
            <MetricCard
              label="Exposure Delta"
              value={`${delta.exposureDeltaPct >= 0 ? "+" : ""}${delta.exposureDeltaPct.toFixed(2)}%`}
              positive={delta.exposureDeltaPct <= 0}
            />
            <MetricCard
              label="Projected Exposure"
              value={`${delta.projectedExposurePct.toFixed(2)}%`}
              neutral
            />
            <MetricCard
              label="Fee Revenue Δ"
              value={`$${delta.feeRevenueDeltaUsd.toLocaleString()}`}
              positive={delta.feeRevenueDeltaUsd >= 0}
            />
            <MetricCard
              label="Projected Fee Rate"
              value={`${delta.projectedFeeRatePct.toFixed(2)}%`}
              neutral
            />
          </div>

          {result.warnings.length > 0 && (
            <div className="space-y-2">
              {result.warnings.map((w, i) => (
                <div key={i} className="flex items-center gap-2 p-2 bg-yellow-500/10 border border-yellow-500/20 rounded">
                  <AlertTriangle size={13} className="text-yellow-400 shrink-0" />
                  <span className="text-xs text-yellow-300">{w}</span>
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-gray-500 italic">{result.disclaimer}</p>
        </div>
      )}
    </div>
  );
};

interface MetricCardProps {
  label: string;
  value: string;
  positive?: boolean;
  neutral?: boolean;
}

function MetricCard({ label, value, positive, neutral }: MetricCardProps) {
  const color = neutral ? "text-white" : positive ? "text-green-400" : "text-red-400";
  const Icon = neutral ? null : positive ? TrendingUp : TrendingDown;
  return (
    <div className="bg-white/5 rounded-lg p-3">
      <p className="text-xs text-gray-400 uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-lg font-bold flex items-center gap-1 ${color}`}>
        {Icon && <Icon size={14} />}
        {value}
      </p>
    </div>
  );
}

export default GovernanceForecast;
