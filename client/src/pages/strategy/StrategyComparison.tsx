import { useEffect, useState } from 'react';
import {
  BarChart3,
  RefreshCw,
  AlertTriangle,
  Flame,
  Layers,
  Activity,
  Zap,
  TrendingDown,
  TrendingUp,
  Percent,
} from 'lucide-react';
import { apiUrl } from '../../lib/api';

interface StrategyYield {
  protocolName: string;
  apy: number;
  rewardApy: number;
  totalApy: number;
  tvl: number;
  riskScore: number;
  liquidityUsd: number;
  rebalancingBehavior: string;
  managementFeeBps: number;
  performanceFeeBps: number;
  capitalEfficiencyPct: number;
  fetchedAt?: string;
}

const STRATEGY_THEMES: Record<string, { bg: string; text: string; shadow: string }> = {
  Blend: { bg: 'from-violet-500/20 to-indigo-600/20', text: 'text-indigo-400', shadow: 'shadow-indigo-500/20' },
  Soroswap: { bg: 'from-cyan-500/20 to-blue-600/20', text: 'text-cyan-400', shadow: 'shadow-cyan-500/20' },
  DeFindex: { bg: 'from-amber-500/20 to-orange-600/20', text: 'text-amber-400', shadow: 'shadow-amber-500/20' },
};

function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString()}`;
}

export default function StrategyComparison() {
  const [data, setData] = useState<StrategyYield[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStrategies = async () => {
    try {
      setError(null);
      setLoading(true);
      const res = await fetch(apiUrl('/api/yields'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const yields = await res.json();
      
      // Filter for the 3 distinct strategies we augmented
      const strategies = yields.filter((y: StrategyYield) => 
        ['Blend', 'Soroswap', 'DeFindex'].includes(y.protocolName)
      );
      setData(strategies);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch strategies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStrategies();
  }, []);

  if (error) {
    return (
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <header className="mb-6">
          <h2 className="text-4xl font-extrabold tracking-tight mb-2">Strategy Comparison</h2>
        </header>
        <div className="glass-panel p-12 text-center border border-red-500/30 bg-red-500/5">
          <AlertTriangle size={32} className="text-red-500 mx-auto mb-4" />
          <h3 className="text-xl font-bold mb-2">Failed to Load Strategy Data</h3>
          <p className="text-gray-400 max-w-md mx-auto mb-6">{error}</p>
          <button onClick={fetchStrategies} className="btn-primary inline-flex items-center gap-2">
            <RefreshCw size={16} /> Retry Fetch
          </button>
        </div>
      </div>
    );
  }

  const renderSkeleton = () => (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="glass-card p-6 animate-pulse border border-white/5">
          <div className="h-8 bg-white/5 rounded w-1/2 mb-6"></div>
          <div className="space-y-4">
             <div className="h-16 bg-white/5 rounded-xl"></div>
             <div className="h-16 bg-white/5 rounded-xl"></div>
             <div className="h-16 bg-white/5 rounded-xl"></div>
             <div className="h-16 bg-white/5 rounded-xl"></div>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-emerald-500/20 p-2.5 rounded-xl border border-emerald-500/30 shadow-lg shadow-emerald-500/20">
              <Zap size={22} className="text-emerald-400" />
            </div>
            <h2 className="text-4xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400">
              Strategy Comparison Workspace
            </h2>
          </div>
          <p className="text-gray-400 ml-[52px]">
            Side-by-side analysis of risk, liquidity, and rebalancing approaches.
          </p>
        </div>
        <button
          onClick={fetchStrategies}
          disabled={loading}
          className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Analyzing...' : 'Refresh Analysis'}
        </button>
      </header>

      {loading ? (
        renderSkeleton()
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 relative">
          {data.map((strategy, i) => {
            const theme = STRATEGY_THEMES[strategy.protocolName] || { bg: 'bg-white/5', text: 'text-gray-400', shadow: '' };
            return (
              <div
                key={strategy.protocolName}
                style={{ animationDelay: `${i * 100}ms` }}
                className={`glass-card overflow-hidden border border-white/5 hover:border-white/20 transition-all duration-300 shadow-2xl ${theme.shadow}`}
              >
                {/* Header */}
                <div className={`p-6 bg-gradient-to-br ${theme.bg} border-b border-white/10`}>
                  <h3 className="text-3xl font-black text-white mb-2 tracking-tight">
                    {strategy.protocolName}
                  </h3>
                  <div className="flex items-center gap-2 text-sm font-medium text-white/80 uppercase tracking-widest">
                     <span className="flex items-center gap-1"><Activity size={14}/> Score: {strategy.riskScore}/100</span>
                  </div>
                </div>

                <div className="p-6 space-y-5 flex-1 flex flex-col">
                  {/* APY Wrap */}
                  <div className="bg-white/5 rounded-2xl p-4 border border-white/10 relative overflow-hidden group">
                    <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/0 via-emerald-500/5 to-emerald-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-gray-400 text-sm font-medium flex items-center gap-2">
                        <Flame size={14} className={theme.text} /> Projected APY
                      </span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-black text-white">
                        {strategy.totalApy.toFixed(2)}<span className="text-2xl text-emerald-400">%</span>
                      </span>
                    </div>
                  </div>

                  {/* Features List */}
                  <div className="grid grid-cols-2 gap-4">
                    {/* Rebalancing */}
                    <div className="bg-white/5 rounded-xl p-4 border border-white/10 hover:bg-white/10 transition-colors">
                      <span className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1 block">
                        Rebalancing
                      </span>
                      <span className="text-white font-bold text-sm">
                        {strategy.rebalancingBehavior || "Standard"}
                      </span>
                    </div>
                    {/* Capital Efficiency */}
                    <div className="bg-white/5 rounded-xl p-4 border border-white/10 hover:bg-white/10 transition-colors">
                      <span className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1 block">
                        Efficiency
                      </span>
                      <span className="text-white font-bold text-sm flex items-center gap-1">
                        <TrendingUp size={14} className="text-cyan-400"/>
                        {strategy.capitalEfficiencyPct || 100}%
                      </span>
                    </div>
                  </div>

                  {/* Liquidity */}
                  <div className="bg-white/5 rounded-xl p-4 border border-white/10 flex justify-between items-center hover:bg-white/10 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400">
                        <Layers size={18} />
                      </div>
                      <div>
                        <span className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1 block">
                          Liquidity Check
                        </span>
                        <span className="text-white font-bold text-lg">
                          {formatCurrency(strategy.liquidityUsd || strategy.tvl)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Fees Section */}
                  <div className="bg-white/5 rounded-xl p-4 border border-white/10 mt-auto">
                    <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-3">
                      <TrendingDown size={14} className="text-red-400" /> Embedded Fees
                    </div>
                    
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-300">Management</span>
                        <span className="text-sm font-bold text-white bg-white/10 px-2 py-0.5 rounded-md flex items-center gap-1">
                          {((strategy.managementFeeBps || 0) / 100).toFixed(2)}<Percent size={10} className="text-gray-400"/>
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-300">Performance</span>
                        <span className="text-sm font-bold text-white bg-white/10 px-2 py-0.5 rounded-md flex items-center gap-1">
                          {((strategy.performanceFeeBps || 0) / 100).toFixed(2)}<Percent size={10} className="text-gray-400"/>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <button className="w-full btn-primary py-3 rounded-xl hover:scale-[1.02] transition-transform font-bold tracking-wide mt-2">
                    Select Strategy
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
