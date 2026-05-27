import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { apiUrl } from "../lib/api";

type StressScenario = "apy-collapse" | "liquidity-drain" | "oracle-shock";

interface StressScenarioResponse {
  scenario: StressScenario;
  projectedFinalValueUsd: number;
  expectedLossUsd: number;
  expectedLossPct: number;
  recoveryDaysEstimate: number;
  exposureBreakdown: {
    yieldExposurePct: number;
    liquidityExposurePct: number;
    oracleExposurePct: number;
  };
}

export default function StressTestDashboard() {
  const [scenario, setScenario] = useState<StressScenario>("apy-collapse");
  const [initialValueUsd, setInitialValueUsd] = useState("10000");
  const [baseApyPct, setBaseApyPct] = useState("10");
  const [days, setDays] = useState("90");
  const [result, setResult] = useState<StressScenarioResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const runScenario = async () => {
    setLoading(true);
    try {
      const response = await fetch(apiUrl("/api/stress-scenarios/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario,
          initialValueUsd: Number(initialValueUsd),
          baseApyPct: Number(baseApyPct),
          days: Number(days),
        }),
      });
      const data = (await response.json()) as StressScenarioResponse;
      setResult(data);
    } finally {
      setLoading(false);
    }
  };

  const exposureSummary = useMemo(() => {
    if (!result) return "";
    return `Yield ${result.exposureBreakdown.yieldExposurePct}% | Liquidity ${result.exposureBreakdown.liquidityExposurePct}% | Oracle ${result.exposureBreakdown.oracleExposurePct}%`;
  }, [result]);

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-3xl font-bold text-white">Stress Scenario Dashboard</h2>
        <p className="text-gray-400 text-sm mt-1">
          Simulations are offline-only and never execute live vault actions.
        </p>
      </header>

      <div className="glass-panel p-5 grid grid-cols-1 md:grid-cols-4 gap-3">
        <select
          value={scenario}
          onChange={(event) => setScenario(event.target.value as StressScenario)}
          className="bg-black/40 border border-white/10 rounded px-3 py-2"
          aria-label="Scenario"
        >
          <option value="apy-collapse">APY Collapse</option>
          <option value="liquidity-drain">Liquidity Drain</option>
          <option value="oracle-shock">Oracle Shock</option>
        </select>
        <input
          value={initialValueUsd}
          onChange={(event) => setInitialValueUsd(event.target.value)}
          className="bg-black/40 border border-white/10 rounded px-3 py-2"
          aria-label="Initial value"
        />
        <input
          value={baseApyPct}
          onChange={(event) => setBaseApyPct(event.target.value)}
          className="bg-black/40 border border-white/10 rounded px-3 py-2"
          aria-label="Base APY"
        />
        <input
          value={days}
          onChange={(event) => setDays(event.target.value)}
          className="bg-black/40 border border-white/10 rounded px-3 py-2"
          aria-label="Days"
        />
      </div>

      <button className="btn-primary" onClick={runScenario} disabled={loading}>
        {loading ? "Running..." : "Run Scenario"}
      </button>

      {result && (
        <div className="glass-panel p-6 space-y-2">
          <div className="flex items-center gap-2 text-amber-400">
            <AlertTriangle size={16} />
            <span className="text-sm font-semibold uppercase tracking-widest">{result.scenario}</span>
          </div>
          <p className="text-white">Projected final value: ${result.projectedFinalValueUsd.toLocaleString()}</p>
          <p className="text-red-300">
            Expected loss: ${result.expectedLossUsd.toLocaleString()} ({result.expectedLossPct}%)
          </p>
          <p className="text-gray-300">Recovery estimate: {result.recoveryDaysEstimate} days</p>
          <p className="text-xs text-gray-500">Exposure breakdown: {exposureSummary}</p>
        </div>
      )}
    </div>
  );
}
