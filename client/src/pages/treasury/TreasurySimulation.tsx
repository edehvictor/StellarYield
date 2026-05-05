import React, { useState } from "react";
import { Vault, TrendingUp, AlertTriangle, Save, RotateCcw } from "lucide-react";
import { apiUrl } from "../../lib/api";

interface AllocationRow {
  vaultId: string;
  vaultName: string;
  allocationPct: number;
  apy: number;
  tvlUsd: number;
  riskScore: number;
  rotationCostPct: number;
}

interface SimResult {
  scenarioId: string;
  scenarioName: string;
  projectedYieldPct: number;
  projectedYieldUsd: number;
  totalRotationCostUsd: number;
  liquidityRiskScore: number;
  concentrationWarnings: string[];
  allocationBreakdown: Array<{
    vaultId: string;
    vaultName: string;
    allocationPct: number;
    capitalUsd: number;
    projectedYieldUsd: number;
  }>;
}

const DEFAULT_ALLOCATIONS: AllocationRow[] = [
  { vaultId: "blend", vaultName: "Blend", allocationPct: 60, apy: 6.5, tvlUsd: 12_000_000, riskScore: 8, rotationCostPct: 0.1 },
  { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 40, apy: 11.2, tvlUsd: 4_500_000, riskScore: 6, rotationCostPct: 0.2 },
];

const TreasurySimulation: React.FC = () => {
  const [scenarioName, setScenarioName] = useState("My Treasury Scenario");
  const [totalCapital, setTotalCapital] = useState("1000000");
  const [allocations, setAllocations] = useState<AllocationRow[]>(DEFAULT_ALLOCATIONS);
  const [result, setResult] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const totalPct = allocations.reduce((s, a) => s + a.allocationPct, 0);

  function updateAlloc(index: number, field: keyof AllocationRow, value: string | number) {
    setAllocations((prev) => {
      const next = [...prev];
      (next[index] as Record<string, unknown>)[field] = value;
      return next;
    });
  }

  async function handleSimulate(shouldSave = false) {
    setError("");
    const capital = parseFloat(totalCapital);
    if (!Number.isFinite(capital) || capital <= 0) {
      setError("Total capital must be a positive number");
      return;
    }
    if (Math.abs(totalPct - 100) > 0.01) {
      setError(`Allocations must sum to 100% (currently ${totalPct.toFixed(1)}%)`);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/treasury/simulate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: scenarioName,
          totalCapitalUsd: capital,
          allocations,
          save: shouldSave,
        }),
      });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "Simulation failed");
      } else {
        setResult(await res.json());
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Vault size={32} className="text-indigo-400" />
        <div>
          <h2 className="text-3xl font-extrabold tracking-tight">Treasury Simulation</h2>
          <p className="text-gray-400 text-sm">
            Model multi-position deployments before moving capital.
          </p>
        </div>
      </div>

      {/* Scenario Config */}
      <div className="glass-panel p-6 space-y-4">
        <h3 className="text-lg font-semibold">Scenario</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Scenario Name</label>
            <input
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Total Capital (USD)</label>
            <input
              type="number"
              value={totalCapital}
              onChange={(e) => setTotalCapital(e.target.value)}
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white"
            />
          </div>
        </div>
      </div>

      {/* Allocation Table */}
      <div className="glass-panel p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Allocations</h3>
          <span className={`text-sm font-semibold ${Math.abs(totalPct - 100) < 0.01 ? "text-green-400" : "text-yellow-400"}`}>
            Total: {totalPct.toFixed(1)}%
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-xs uppercase tracking-widest">
                <th className="text-left py-2">Vault</th>
                <th className="text-left py-2">Alloc %</th>
                <th className="text-left py-2">APY %</th>
                <th className="text-left py-2">Risk Score</th>
                <th className="text-left py-2">Rotation Cost %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {allocations.map((a, i) => (
                <tr key={a.vaultId}>
                  <td className="py-2 font-medium text-white">{a.vaultName}</td>
                  <td className="py-2">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={a.allocationPct}
                      onChange={(e) => updateAlloc(i, "allocationPct", parseFloat(e.target.value) || 0)}
                      className="w-20 bg-black/50 border border-gray-600 rounded px-2 py-1 text-white"
                    />
                  </td>
                  <td className="py-2">
                    <input
                      type="number"
                      min={0}
                      value={a.apy}
                      onChange={(e) => updateAlloc(i, "apy", parseFloat(e.target.value) || 0)}
                      className="w-20 bg-black/50 border border-gray-600 rounded px-2 py-1 text-white"
                    />
                  </td>
                  <td className="py-2">
                    <span className={a.riskScore >= 7 ? "text-green-400" : a.riskScore >= 4 ? "text-yellow-400" : "text-red-400"}>
                      {a.riskScore}/10
                    </span>
                  </td>
                  <td className="py-2">
                    <input
                      type="number"
                      min={0}
                      value={a.rotationCostPct}
                      onChange={(e) => updateAlloc(i, "rotationCostPct", parseFloat(e.target.value) || 0)}
                      className="w-20 bg-black/50 border border-gray-600 rounded px-2 py-1 text-white"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-red-400" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => handleSimulate(false)}
          disabled={loading}
          className="flex-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg flex items-center justify-center gap-2"
        >
          <TrendingUp size={18} />
          {loading ? "Simulating…" : "Run Simulation"}
        </button>
        <button
          onClick={() => handleSimulate(true)}
          disabled={loading}
          className="px-5 bg-white/10 hover:bg-white/20 text-white font-semibold py-3 rounded-lg flex items-center justify-center gap-2"
        >
          <Save size={18} /> Save
        </button>
        <button
          onClick={() => { setResult(null); setError(""); }}
          className="px-5 bg-white/5 hover:bg-white/10 text-gray-400 py-3 rounded-lg"
        >
          <RotateCcw size={18} />
        </button>
      </div>

      {result && (
        <div className="glass-panel p-6 space-y-6 border border-indigo-500/20">
          <h3 className="text-xl font-bold text-white">Simulation Results — {result.scenarioName}</h3>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="glass-card p-4">
              <p className="text-xs text-gray-400 uppercase tracking-widest">Projected Yield</p>
              <p className="text-2xl font-bold text-green-400">{result.projectedYieldPct.toFixed(2)}%</p>
              <p className="text-xs text-gray-500">${result.projectedYieldUsd.toLocaleString()}</p>
            </div>
            <div className="glass-card p-4">
              <p className="text-xs text-gray-400 uppercase tracking-widest">Rotation Cost</p>
              <p className="text-2xl font-bold text-yellow-400">${result.totalRotationCostUsd.toLocaleString()}</p>
            </div>
            <div className="glass-card p-4">
              <p className="text-xs text-gray-400 uppercase tracking-widest">Liquidity Risk</p>
              <p className={`text-2xl font-bold ${result.liquidityRiskScore <= 3 ? "text-green-400" : result.liquidityRiskScore <= 6 ? "text-yellow-400" : "text-red-400"}`}>
                {result.liquidityRiskScore.toFixed(1)}/10
              </p>
            </div>
            <div className="glass-card p-4">
              <p className="text-xs text-gray-400 uppercase tracking-widest">Warnings</p>
              <p className="text-2xl font-bold text-white">{result.concentrationWarnings.length}</p>
            </div>
          </div>

          {result.concentrationWarnings.length > 0 && (
            <div className="space-y-2">
              {result.concentrationWarnings.map((w, i) => (
                <div key={i} className="flex items-center gap-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                  <AlertTriangle size={14} className="text-yellow-400 shrink-0" />
                  <span className="text-sm text-yellow-300">{w}</span>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-widest">Breakdown</h4>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs uppercase">
                  <th className="text-left py-1">Vault</th>
                  <th className="text-right py-1">Alloc %</th>
                  <th className="text-right py-1">Capital</th>
                  <th className="text-right py-1">Yield</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {result.allocationBreakdown.map((b) => (
                  <tr key={b.vaultId}>
                    <td className="py-2 text-white">{b.vaultName}</td>
                    <td className="py-2 text-right text-gray-300">{b.allocationPct}%</td>
                    <td className="py-2 text-right text-gray-300">${b.capitalUsd.toLocaleString()}</td>
                    <td className="py-2 text-right text-green-400">${b.projectedYieldUsd.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default TreasurySimulation;
