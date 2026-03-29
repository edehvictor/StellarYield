import { useEffect, useState } from "react";
import { Activity, ArrowUpRight, ShieldCheck, TrendingUp } from "lucide-react";
import ApyHistoryChart from "./charts/ApyHistoryChart";
import MempoolVisualizer from "./mempool_graph/MempoolVisualizer";

interface YieldData {
  protocol: string;
  asset: string;
  apy: number;
  tvl: number;
  risk: string;
}

export default function Dashboard() {
  const [yields, setYields] = useState<YieldData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("http://localhost:3001/api/yields")
      .then((res) => res.json())
      .then((data) => {
        setYields(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch yields", err);
        setLoading(false);
      });
  }, []);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <header className="mb-10">
        <h2 className="mb-2 text-4xl font-extrabold tracking-tight">
          Welcome Back
        </h2>
        <p className="text-gray-400">
          Optimize your returns across the Stellar ecosystem
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="glass-card border-l-4 border-[#6C5DD3] p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="text-sm font-medium tracking-wide text-gray-400">
                TOTAL VALUE LOCKED
              </p>
              <h3 className="mt-1 text-3xl font-bold shadow-sm">$4,250,000</h3>
            </div>
            <div className="rounded-xl bg-[#6C5DD3]/20 p-3 text-[#6C5DD3]">
              <Activity size={24} />
            </div>
          </div>
          <div className="flex items-center gap-1 text-sm font-medium text-green-400">
            <ArrowUpRight size={16} /> +12.5% this week
          </div>
        </div>

        <div className="glass-card border-l-4 border-green-500 p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="text-sm font-medium tracking-wide text-gray-400">
                NET APY
              </p>
              <h3 className="mt-1 text-3xl font-bold">14.2%</h3>
            </div>
            <div className="rounded-xl bg-green-500/20 p-3 text-green-500">
              <TrendingUp size={24} />
            </div>
          </div>
          <div className="flex items-center gap-1 text-sm font-medium text-gray-400">
            Active in 3 protocols
          </div>
        </div>

        <div className="glass-card border-l-4 border-blue-500 p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="text-sm font-medium tracking-wide text-gray-400">
                RISK SCORE
              </p>
              <h3 className="mt-1 text-3xl font-bold">Low</h3>
            </div>
            <div className="rounded-xl bg-blue-500/20 p-3 text-blue-500">
              <ShieldCheck size={24} />
            </div>
          </div>
          <div className="flex items-center gap-1 text-sm font-medium text-gray-400">
            Audited smart contracts
          </div>
        </div>
      </div>

      <ApyHistoryChart />

      {/* Mempool Visualization Integration */}
      <MempoolVisualizer />

      <div className="glass-panel mt-8 overflow-hidden">

        <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.05)] p-6">
          <h3 className="text-xl font-bold">Top Stellar Yields</h3>
          <button className="text-sm font-medium text-[#6C5DD3] transition-colors hover:text-white">
            View All &rarr;
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-[rgba(255,255,255,0.02)] text-xs uppercase tracking-wider text-gray-400">
                <th className="px-6 py-4 font-semibold">Protocol</th>
                <th className="px-6 py-4 font-semibold">Asset</th>
                <th className="px-6 py-4 font-semibold">APY</th>
                <th className="px-6 py-4 font-semibold">TVL</th>
                <th className="px-6 py-4 font-semibold">Risk</th>
                <th className="px-6 py-4 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[rgba(255,255,255,0.05)]">
              {loading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-12 text-center text-gray-500"
                  >
                    <div className="flex items-center justify-center gap-3">
                      <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#6C5DD3] border-t-transparent" />
                      Fetching on-chain data...
                    </div>
                  </td>
                </tr>
              ) : (
                yields.map((y, i) => (
                  <tr
                    key={i}
                    className="group transition-colors hover:bg-[rgba(255,255,255,0.03)]"
                  >
                    <td className="px-6 py-5">
                      <span className="font-semibold tracking-wide text-white">
                        {y.protocol}
                      </span>
                    </td>
                    <td className="px-6 py-5">
                      <span className="rounded-full border border-[#6C5DD3]/30 bg-gradient-to-r from-[#6C5DD3]/20 to-[#6C5DD3]/10 px-3 py-1.5 text-xs font-bold text-[#6C5DD3]">
                        {y.asset}
                      </span>
                    </td>
                    <td className="px-6 py-5">
                      <span className="text-lg font-extrabold text-green-400">
                        {y.apy}%
                      </span>
                    </td>
                    <td className="px-6 py-5 font-medium text-gray-300">
                      ${y.tvl.toLocaleString()}
                    </td>
                    <td className="px-6 py-5">
                      <span
                        className={`rounded px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider ${
                          y.risk === "Low"
                            ? "bg-green-500 text-green-400"
                            : y.risk === "Medium"
                              ? "bg-yellow-500 text-yellow-400"
                              : "bg-red-500 text-red-400"
                        } bg-opacity-20`}
                      >
                        {y.risk}
                      </span>
                    </td>
                    <td className="px-6 py-5 text-right">
                      <button className="btn-secondary px-5 py-2 text-sm opacity-80 shadow-md transition-all group-hover:border-[#6C5DD3] group-hover:bg-[#6C5DD3] group-hover:text-white group-hover:opacity-100">
                        Deposit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
