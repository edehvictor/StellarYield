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
  ShieldCheck,
  Check,
} from 'lucide-react';
import { apiUrl } from '../../lib/api';
import { useBackendStatus } from '../../hooks/useBackendStatus';
import { BackendUnavailable } from '../../components/BackendUnavailable';
import {
  downloadStrategyComparisonExport,
  type StrategyComparisonExportFormat,
  type StrategyYield,
} from './strategyComparisonExport';
import { formatShortFingerprint } from '../../../../shared/types/strategyComparisonConfigFingerprint';

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

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Failed to fetch strategies';
}

export default function StrategyComparison() {
  const [data, setData] = useState<StrategyYield[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configFingerprint, setConfigFingerprint] = useState<string | null>(null);
  const [isStaleConfig, setIsStaleConfig] = useState(false);
  const [validationWarning, setValidationWarning] = useState<string | null>(null);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ type: 'error' | 'success'; message: string } | null>(null);
  
  // Ref to track confirmed fingerprint across async calls
  const confirmedFingerprintRef = useRef<string | null>(null);
  const backendStatus = useBackendStatus();

  const fetchStrategies = async () => {
    try {
      setError(null);
      setValidationWarning(null);
      setActionNotice(null);
      setLoading(true);

      const res = await fetch(apiUrl('/api/yields'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      const headerFingerprint = res.headers?.get?.('x-strategy-config-fingerprint') || null;
      const yields = await res.json();
      
      // Extract fingerprint from header or yield payload
      const incomingFingerprint = headerFingerprint || (Array.isArray(yields) && yields[0]?.configFingerprint) || null;

      // Check if active snapshot fingerprint has drifted
      if (confirmedFingerprintRef.current && incomingFingerprint && confirmedFingerprintRef.current !== incomingFingerprint) {
        setIsStaleConfig(true);
      } else {
        setIsStaleConfig(false);
      }

      if (incomingFingerprint) {
        confirmedFingerprintRef.current = incomingFingerprint;
        setConfigFingerprint(incomingFingerprint);
      }

      // Validate untrusted fields at the boundary - return empty (safe failure)
      // without mutating state. Skip any entries with missing or malformed data.
      const strategies = Array.isArray(yields)
        ? yields.filter((y: StrategyYield) => {
            if (!y?.protocolName) return false;
            if (!['Blend', 'Soroswap', 'DeFindex'].includes(y.protocolName)) return false;
            if (typeof y.apy !== 'number' || !Number.isFinite(y.apy)) return false;
            if (typeof y.tvl !== 'number' || !Number.isFinite(y.tvl)) return false;
            if (typeof y.riskScore !== 'number') return false;
            if (typeof y.liquidityUsd !== 'number' || !Number.isFinite(y.liquidityUsd)) return false;
            if (y.rebalancingBehavior && !['Static', 'Dynamic', 'Yield-Weighted'].includes(y.rebalancingBehavior)) return false;
            return true;
          })
        : [];
      
      // Preserve existing state and balances when validation fails (#1918)
      if (strategies.length === 0 && Array.isArray(yields) && yields.length > 0) {
        setData((prevData) => {
          if (prevData.length > 0) {
            setValidationWarning('Validation failed on updated strategy snapshot. Retaining existing valid strategy data and balances.');
            return prevData;
          }
          return [];
        });
      } else {
        setData(strategies);
      }
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      setData((prevData) => {
        if (prevData.length > 0) {
          setValidationWarning(`Strategy refresh failed (${msg}). Retaining existing strategy data.`);
          return prevData;
        }
        setError(msg);
        return [];
      });
    } finally {
      setLoading(false);
    }
  };

  const handleExport = (format: StrategyComparisonExportFormat) => {
    downloadStrategyComparisonExport(data, format);
  };

  const handleSelectStrategy = (strategy: StrategyYield) => {
    if (isStaleConfig) {
      setActionNotice({
        type: 'error',
        message: 'Cannot select strategy: configuration snapshot is stale. Please refresh configuration to continue.',
      });
      return;
    }

    setSelectedStrategyId(strategy.protocolName);
    setActionNotice({
      type: 'success',
      message: `Selected ${strategy.protocolName} strategy with verified configuration snapshot.`,
    });
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
          reason="The backend service is currently disconnected or unavailable. Please try again later."
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
            {configFingerprint && (
              <span
                data-testid="config-fingerprint-badge"
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono bg-white/5 text-gray-300 border border-white/10"
                title={`Snapshot Fingerprint: ${configFingerprint}`}
              >
                <ShieldCheck size={12} className="text-emerald-400" />
                {formatShortFingerprint(configFingerprint)}
              </span>
            )}
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

      {/* Stale Configuration Warning Banner */}
      {isStaleConfig && (
        <div
          data-testid="stale-config-warning"
          className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg shadow-amber-500/5 animate-in fade-in"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle size={20} className="text-amber-400 shrink-0" />
            <div>
              <p className="font-semibold text-sm">Strategy Configuration Snapshot Stale</p>
              <p className="text-xs text-amber-300/80">
                Underlying strategy configuration has changed. Existing comparisons and balances are preserved. Refresh to update safely.
              </p>
            </div>
          </div>
          <button
            onClick={fetchStrategies}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-xs font-semibold border border-amber-500/40 transition-colors shrink-0"
          >
            Refresh Configuration
          </button>
        </div>
      )}

      {/* Non-destructive Validation Warning Banner */}
      {validationWarning && (
        <div
          data-testid="validation-warning-banner"
          className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-200 flex items-center gap-3 shadow-lg shadow-rose-500/5 animate-in fade-in"
        >
          <AlertTriangle size={18} className="text-rose-400 shrink-0" />
          <p className="text-xs font-medium">{validationWarning}</p>
        </div>
      )}

      {/* Action Notice (Selection Success / Failure) */}
      {actionNotice && (
        <div
          data-testid="action-notice"
          className={`p-4 rounded-2xl border text-xs font-medium flex items-center gap-3 animate-in fade-in ${
            actionNotice.type === 'error'
              ? 'bg-rose-500/10 border-rose-500/30 text-rose-200'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
          }`}
        >
          {actionNotice.type === 'error' ? (
            <AlertTriangle size={16} className="text-rose-400 shrink-0" />
          ) : (
            <Check size={16} className="text-emerald-400 shrink-0" />
          )}
          <p>{actionNotice.message}</p>
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
            const isSelected = selectedStrategyId === strategy.protocolName;
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
                  <button
                    onClick={() => handleSelectStrategy(strategy)}
                    className={`w-full py-3 rounded-xl transition-all font-bold tracking-wide mt-2 ${
                      isSelected
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : 'btn-primary hover:scale-[1.02]'
                    }`}
                  >
                    {isSelected ? 'Strategy Selected ✓' : 'Select Strategy'}
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
