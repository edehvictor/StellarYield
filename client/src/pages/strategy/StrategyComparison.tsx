import { useEffect, useState, useRef } from 'react';
import {
  RefreshCw,
  AlertTriangle,
  Flame,
  Layers,
  Activity,
  Zap,
  TrendingDown,
  TrendingUp,
  Percent,
  Download,
  Check,
} from 'lucide-react';
import { apiUrl } from '../../lib/api';
import { useBackendStatus } from '../../hooks/useBackendStatus';
import { BackendUnavailable } from '../../components/BackendUnavailable';
import {
  fetchComparisonStateVersioned,
 selectStrategySafely,
  StrategyComparisonConflictError,
} from '../../features/strategies/strategyComparisonConcurrencyApi';

import {
  bpsToPercent,
  formatApy,
  formatComparisonCurrency,
} from '../../features/strategies/strategyComparisonMath';
import {
  downloadStrategyComparisonExport,
  isComparableStrategy,
  type StrategyComparisonExportFormat,
  type StrategyYield,
} from './strategyComparisonExport';

const STRATEGY_THEMES: Record<string, { bg: string; text: string; shadow: string }> = {
  Blend: { bg: 'from-violet-500/20 to-indigo-600/20', text: 'text-indigo-400', shadow: 'shadow-indigo-500/20' },
  Soroswap: { bg: 'from-cyan-500/20 to-blue-600/20', text: 'text-cyan-400', shadow: 'shadow-cyan-500/20' },
  DeFindex: { bg: 'from-amber-500/20 to-orange-600/20', text: 'text-amber-400', shadow: 'shadow-amber-500/20' },
};

export default function StrategyComparison() {
  const [data, setData] = useState<StrategyYield[]>([]);
  const [loading, setLoading] = useState(true);
  const [validationWarning, setValidationWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comparisonVersion, setComparisonVersion] = useState<number>(0);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [isUpdatingSelection, setIsUpdatingSelection] = useState(false);
  const backendStatus = useBackendStatus();

  const refreshSequence = useRef(0);
 const selectionPending = useRef(false);
 const fetchStrategies = async () => {
   const sequence = ++refreshSequence.current;
   let stage = 'retrieval';
   setError(null);
   setValidationWarning(null);
   setLoading(true);
   try {
     const res = await fetch(apiUrl('/api/yields'));
     if (!res.ok) throw new Error();
     stage = 'validation';
     const yields: unknown = await res.json();
     if (!Array.isArray(yields)) throw new Error();
     const strategies = yields.filter(isComparableStrategy);
     if (sequence !== refreshSequence.current) return;
     if (!strategies.length && data.length) throw new Error();
     if (strategies.length !== yields.length) {
       setValidationWarning("Validation failed for some strategy rows. Invalid rows were excluded. Refresh analysis to retry.");
     }
     setData(strategies);
   } catch {
     if (sequence === refreshSequence.current) {
       setError(stage === 'validation'
         ? 'Validation failed: strategy data is incomplete or invalid. Refresh analysis to retry.'
         : 'The backend service is currently disconnected or unavailable. Please try again later.');
     }
   } finally {
     if (sequence === refreshSequence.current) setLoading(false);
   }
 };

 const handleSelectStrategy = async (strategyName: string) => {
   if (selectionPending.current || loading || error) return;
   selectionPending.current = true;
   setIsUpdatingSelection(true);
   setConflictNotice(null);
   try {
     const wallet = 'G_CURRENT_USER';
     const snapshot = await fetchComparisonStateVersioned(wallet);
     const result = await selectStrategySafely(wallet, strategyName.toLowerCase(), 1000, {
       expectedVersion: snapshot.version,
     });
     setSelectedStrategyId(result.state.selectedStrategyId);
     setComparisonVersion(result.version);
   } catch (err: unknown) {
     if (err instanceof StrategyComparisonConflictError) {
       setConflictNotice('Concurrency check failed. Workspace changed. Review the current selection and retry.');
       setComparisonVersion(err.currentVersion);
       setSelectedStrategyId(err.currentState.selectedStrategyId);
     } else {
       setConflictNotice('Selection could not be confirmed. Refresh analysis and review the workspace before retrying.');
     }
   } finally {
     selectionPending.current = false;
     setIsUpdatingSelection(false);
   }
 };

 const handleExport = (format: StrategyComparisonExportFormat) => {
    downloadStrategyComparisonExport(data, format);
  };

  useEffect(() => {
    fetchStrategies();
  }, []);

  // Show backend unavailable state if backend is down and no cached data exists
  if (backendStatus === "unavailable" && !data.length) {
    return (
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <header className="mb-6">
          <h2 className="text-4xl font-extrabold tracking-tight mb-2">Strategy Comparison</h2>
        </header>
        <BackendUnavailable 
          featureName="Strategy Comparison"
          reason="Unable to fetch strategy data. The backend service is currently unavailable."
          onRetry={fetchStrategies}
        />
      </div>
    );
  }

  if (error && !data.length) {
    return (
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <header className="mb-6">
          <h2 className="text-4xl font-extrabold tracking-tight mb-2">Strategy Comparison</h2>
        </header>
        <BackendUnavailable 
          featureName="Strategy Comparison"
          reason={error}
          onRetry={fetchStrategies}
        />
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
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-white/10 pb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-emerald-500/20 p-2.5 rounded-xl border border-emerald-500/30 shadow-lg shadow-emerald-500/20">
              <Zap size={22} className="text-emerald-400" />
            </div>
            <h2 className="text-4xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400">
              Strategy Comparison Workspace
            </h2>
          </div>
          <div className="flex items-center gap-3 ml-[52px]">
            <p className="text-gray-400">
              Side-by-side analysis of risk, liquidity, and rebalancing approaches.
            </p>
            <span
              data-testid="comparison-version-badge"
              className="text-xs px-2.5 py-0.5 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 font-mono inline-flex items-center gap-1"
            >
              <Layers size={11} /> Workspace v{comparisonVersion}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={fetchStrategies}
            disabled={loading}
            className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Analyzing...' : 'Refresh Analysis'}
          </button>
          <button
            type="button"
            onClick={() => handleExport('csv')}
            disabled={loading || data.length === 0}
            aria-label={
              data.length === 0
                ? 'No strategies available to export as CSV'
                : 'Export strategy comparison as CSV'
            }
            className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50"
          >
            <Download size={14} />
            CSV
          </button>
          <button
            type="button"
            onClick={() => handleExport('json')}
            disabled={loading || data.length === 0}
            aria-label={
              data.length === 0
                ? 'No strategies available to export as JSON'
                : 'Export strategy comparison as JSON'
            }
            className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50"
          >
            <Download size={14} />
            JSON
          </button>
        </div>
      </header>

      {conflictNotice && (
        <div
          role="status"
          data-testid="concurrent-conflict-notice"
          className="p-4 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-between text-indigo-200 text-sm animate-in fade-in"
        >
          <div className="flex items-center gap-2">
            <Activity size={18} className="text-indigo-400 flex-shrink-0" />
            <span>{conflictNotice}</span>
          </div>
          <button
            onClick={() => setConflictNotice(null)}
            className="text-xs text-gray-400 hover:text-white ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && data.length > 0 && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-amber-200 text-sm animate-in fade-in"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-400 flex-shrink-0" />
            <span>
              {error} Existing displayed comparisons remain preserved.
            </span>
          </div>
          <button
            onClick={fetchStrategies}
            className="px-3 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded text-xs font-semibold ml-4"
          >
            Retry
          </button>
        </div>
      )}

      {validationWarning && !loading && (
        <div role="alert" className="p-4 rounded-xl bg-amber-500/10 text-amber-200">
          {validationWarning}
        </div>
      )}

      {loading ? (
        renderSkeleton()
      ) : data.length === 0 ? (
        <div
          className="glass-panel p-12 text-center border border-white/10"
          data-testid="strategy-export-empty-state"
        >
          <AlertTriangle size={32} className="text-gray-500 mx-auto mb-4" />
          <h3 className="text-xl font-bold mb-2">No Strategy Data Available</h3>
          <p className="text-gray-400 max-w-md mx-auto">
            Export actions unlock once Blend, Soroswap, or DeFindex strategy
            rows are available.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 relative">
          {data.map((strategy, i) => {
            const theme = STRATEGY_THEMES[strategy.protocolName] || { bg: 'bg-white/5', text: 'text-gray-400', shadow: '' };
            const isSelected = selectedStrategyId === strategy.protocolName.toLowerCase();
            return (
              <div
                key={strategy.protocolName}
                style={{ animationDelay: `${i * 100}ms` }}
                className={`glass-card overflow-hidden border transition-all duration-300 shadow-2xl ${
                  isSelected ? 'border-emerald-500/50 ring-2 ring-emerald-500/20' : 'border-white/5 hover:border-white/20'
                } ${theme.shadow}`}
              >
                {/* Header */}
                <div className={`p-6 bg-gradient-to-br ${theme.bg} border-b border-white/10 flex justify-between items-start`}>
                  <div>
                    <h3 className="text-3xl font-black text-white mb-2 tracking-tight">
                      {strategy.protocolName}
                    </h3>
                    <div className="flex items-center gap-2 text-sm font-medium text-white/80 uppercase tracking-widest">
                       <span className="flex items-center gap-1"><Activity size={14}/> Score: {strategy.riskScore}/100</span>
                    </div>
                  </div>
                  {isSelected && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                      <Check size={12} /> Active
                    </span>
                  )}
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
                        {formatApy(strategy.totalApy)}<span className="text-2xl text-emerald-400">%</span>
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
                        {strategy.capitalEfficiencyPct ?? 100}%
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
                          {formatComparisonCurrency(strategy.liquidityUsd ?? strategy.tvl)}
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
                          {bpsToPercent(strategy.managementFeeBps ?? 0).toFixed(2)}<Percent size={10} className="text-gray-400"/>
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-300">Performance</span>
                        <span className="text-sm font-bold text-white bg-white/10 px-2 py-0.5 rounded-md flex items-center gap-1">
                          {bpsToPercent(strategy.performanceFeeBps ?? 0).toFixed(2)}<Percent size={10} className="text-gray-400"/>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <button
                    type="button"
                    onClick={() => handleSelectStrategy(strategy.protocolName)}
                    disabled={isUpdatingSelection || loading || Boolean(error)}
                    aria-pressed={selectedStrategyId === strategy.protocolName.toLowerCase()}
                    className={`w-full py-3 rounded-xl transition-all font-bold tracking-wide mt-2 ${
                      selectedStrategyId === strategy.protocolName.toLowerCase()
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30'
                        : 'btn-primary hover:scale-[1.02]'
                    }`}
                  >
                    {selectedStrategyId === strategy.protocolName.toLowerCase()
                      ? '✓ Strategy Selected'
                      : 'Select Strategy'}
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
