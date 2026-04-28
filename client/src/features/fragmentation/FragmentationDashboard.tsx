import { useState, useEffect, useCallback } from 'react';
import { AlertCircle, X } from 'lucide-react';
import type { FragmentationMetrics } from './types';
import { apiUrl } from '../../lib/api';
import FragmentationScoreCard from './FragmentationScoreCard';
import ExecutionQualityCard from './ExecutionQualityCard';
import EffectiveProtocolsCard from './EffectiveProtocolsCard';
import MaterialImpactWarning from './MaterialImpactWarning';
import ProtocolDistributionChart from './ProtocolDistributionChart';
import RoutingRecommendations from './RoutingRecommendations';
import DataFreshnessIndicator from './DataFreshnessIndicator';

interface FragmentationDashboardProps {
  refreshInterval?: number;  // Default: 60000ms (1 minute)
  showRecommendations?: boolean;  // Default: true
}

/**
 * FragmentationDashboard displays liquidity fragmentation metrics across Stellar DeFi protocols.
 * Features:
 * - Real-time fragmentation score with visual indicators
 * - Execution quality gauge with color-coded status
 * - Protocol distribution breakdown
 * - Material impact warnings
 * - Routing recommendations
 * - Auto-refresh with configurable interval
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 8.1, 8.2, 8.3, 8.4
 */
export default function FragmentationDashboard({
  refreshInterval = 60000,
  showRecommendations = true,
}: FragmentationDashboardProps) {
  const [metrics, setMetrics] = useState<FragmentationMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const response = await fetch(apiUrl('/api/liquidity/fragmentation'));
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error?.message || 'Failed to fetch fragmentation metrics');
      }

      if (data.success && data.data) {
        setMetrics(data.data);
        setLastUpdate(new Date());
        setError(null);
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred while fetching metrics';
      setError(errorMessage);
      console.error('Failed to fetch fragmentation metrics:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  // Auto-refresh
  useEffect(() => {
    if (refreshInterval > 0) {
      const intervalId = setInterval(fetchMetrics, refreshInterval);
      return () => clearInterval(intervalId);
    }
  }, [refreshInterval, fetchMetrics]);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <header className="mb-10">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="mb-2 text-4xl font-extrabold tracking-tight">
              Liquidity Fragmentation
            </h2>
            <p className="text-gray-400">
              Monitor liquidity distribution across Stellar DeFi protocols
            </p>
          </div>
          <button
            onClick={fetchMetrics}
            disabled={loading}
            className="text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          >
            {loading ? 'Refreshing...' : 'Refresh Now'}
          </button>
        </div>
      </header>

      {/* Error Banner */}
      {error && (
        <div className="glass-card border-l-4 border-red-500 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 flex-1">
              <AlertCircle size={20} className="text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold text-red-500 mb-1">Error</h4>
                <p className="text-sm text-red-200/80">{error}</p>
              </div>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-300 transition-colors"
              aria-label="Dismiss error"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}

      {/* Loading State */}
      {loading && !metrics && (
        <div className="glass-card p-12 text-center">
          <div className="flex items-center justify-center gap-3">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#6C5DD3] border-t-transparent" />
            <span className="text-gray-400">Loading fragmentation metrics...</span>
          </div>
        </div>
      )}

      {/* Metrics Display */}
      {metrics && (
        <>
          {/* Material Impact Warning */}
          {metrics.materialImpact && (
            <MaterialImpactWarning
              executionQualityScore={metrics.executionQualityScore}
              routingRecommendation={metrics.routingRecommendation}
            />
          )}

          {/* Metrics Summary Cards */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <FragmentationScoreCard
              score={metrics.fragmentationScore}
              category={metrics.category}
              categoryDescription={metrics.categoryDescription}
            />
            <ExecutionQualityCard
              score={metrics.executionQualityScore}
              materialImpact={metrics.materialImpact}
            />
            <EffectiveProtocolsCard
              effectiveProtocolCount={metrics.effectiveProtocolCount}
              hhi={metrics.hhi}
              multiProtocolRoutingPct={metrics.multiProtocolRoutingPct}
            />
          </div>

          {/* Protocol Distribution Chart */}
          <ProtocolDistributionChart
            protocolBreakdown={metrics.protocolBreakdown}
          />

          {/* Routing Recommendations */}
          {showRecommendations && (
            <RoutingRecommendations
              recommendation={metrics.routingRecommendation}
              fragmentationScore={metrics.fragmentationScore}
            />
          )}

          {/* Data Freshness Indicator */}
          <DataFreshnessIndicator
            timestamp={metrics.timestamp}
            nextUpdateAt={metrics.nextUpdateAt}
            dataCompleteness={metrics.dataCompleteness}
            lastUpdate={lastUpdate}
          />
        </>
      )}
    </div>
  );
}
