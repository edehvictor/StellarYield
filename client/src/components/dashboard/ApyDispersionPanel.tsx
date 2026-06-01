import { useState, useEffect } from 'react';
import { BarChart3, AlertTriangle, RefreshCw, CheckCircle, MinusCircle, XCircle, Info } from 'lucide-react';

interface DispersionSource {
  provider: string;
  apy: number;
  tvlUsd: number;
  deviationFromMean: number;
}

interface ApyDispersionResult {
  strategyId: string;
  strategyName: string;
  providerCount: number;
  meanApy: number;
  medianApy: number;
  minApy: number;
  maxApy: number;
  range: number;
  variance: number;
  stdDev: number;
  coefficientOfVariation: number;
  dispersionLevel: 'low' | 'moderate' | 'high' | 'critical';
  confidenceSignal: 'high' | 'reduced' | 'low' | 'warning';
  sources: DispersionSource[];
  warning: string | null;
}

const DISPERSION_CONFIG: Record<string, { color: string; bg: string; icon: typeof CheckCircle }> = {
  low: { color: 'text-green-400', bg: 'bg-green-500/15', icon: CheckCircle },
  moderate: { color: 'text-yellow-400', bg: 'bg-yellow-500/15', icon: MinusCircle },
  high: { color: 'text-orange-400', bg: 'bg-orange-500/15', icon: AlertTriangle },
  critical: { color: 'text-red-400', bg: 'bg-red-500/15', icon: XCircle },
};

function formatTvl(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString()}`;
}

export default function ApyDispersionPanel({ strategyId = 'blend-usdc', strategyName = 'Blend USDC' }: { strategyId?: string; strategyName?: string }) {
  const [dispersion, setDispersion] = useState<ApyDispersionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchDispersion = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/risk/dispersion/compute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            strategyId,
            strategyName,
            inputs: [
              { provider: 'DeFiLlama', apy: 6.5, tvlUsd: 10_000_000, fetchedAt: new Date().toISOString() },
              { provider: 'YieldWatch', apy: 6.8, tvlUsd: 8_000_000, fetchedAt: new Date().toISOString() },
              { provider: 'StellarExpert', apy: 6.3, tvlUsd: 9_000_000, fetchedAt: new Date().toISOString() },
            ],
          }),
        });
        const data = await res.json();
        setDispersion(data.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch dispersion data');
      } finally {
        setLoading(false);
      }
    };

    void fetchDispersion();
  }, [strategyId, strategyName]);

  if (loading) {
    return (
      <div className="glass-card p-5">
        <div className="flex items-center justify-center py-8">
          <RefreshCw size={24} className="animate-spin text-[#6C5DD3]" />
        </div>
      </div>
    );
  }

  if (error || !dispersion) {
    return (
      <div className="glass-card p-5 border border-red-500/30">
        <div className="flex items-center gap-2 text-red-400">
          <AlertTriangle size={16} />
          <p className="text-sm">{error || 'No dispersion data'}</p>
        </div>
      </div>
    );
  }

  const levelConfig = DISPERSION_CONFIG[dispersion.dispersionLevel] ?? DISPERSION_CONFIG.low;
  const LevelIcon = levelConfig.icon;

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <BarChart3 size={18} className="text-[#6C5DD3]" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
            APY Dispersion
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${levelConfig.bg} ${levelConfig.color}`}
          >
            <LevelIcon size={10} />
            {dispersion.dispersionLevel}
          </span>
          <span className="text-[10px] text-gray-500 bg-white/5 px-2 py-0.5 rounded">
            {dispersion.providerCount} sources
          </span>
        </div>
      </div>

      {dispersion.warning && (
        <div className="flex items-start gap-2 mb-3 p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg">
          <Info size={14} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-200">{dispersion.warning}</p>
        </div>
      )}

      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="text-center p-2 bg-white/5 rounded-lg">
          <p className="text-[10px] text-gray-500 uppercase">Mean</p>
          <p className="text-sm font-bold text-white">{dispersion.meanApy.toFixed(2)}%</p>
        </div>
        <div className="text-center p-2 bg-white/5 rounded-lg">
          <p className="text-[10px] text-gray-500 uppercase">Median</p>
          <p className="text-sm font-bold text-white">{dispersion.medianApy.toFixed(2)}%</p>
        </div>
        <div className="text-center p-2 bg-white/5 rounded-lg">
          <p className="text-[10px] text-gray-500 uppercase">Range</p>
          <p className="text-sm font-bold text-white">{dispersion.range.toFixed(2)}%</p>
        </div>
        <div className="text-center p-2 bg-white/5 rounded-lg">
          <p className="text-[10px] text-gray-500 uppercase">Std Dev</p>
          <p className={`text-sm font-bold ${levelConfig.color}`}>{dispersion.stdDev.toFixed(3)}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        {dispersion.sources.map((source) => (
          <div
            key={source.provider}
            className="flex items-center justify-between py-2 px-2.5 rounded-lg bg-white/5"
          >
            <span className="text-xs text-gray-300">{source.provider}</span>
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-white">{source.apy.toFixed(2)}%</span>
              <span className="text-[10px] text-gray-500">{formatTvl(source.tvlUsd)}</span>
              <span
                className={`text-[10px] font-medium ${
                  source.deviationFromMean >= 0 ? 'text-green-400' : 'text-red-400'
                }`}
              >
                {source.deviationFromMean >= 0 ? '+' : ''}{source.deviationFromMean.toFixed(2)}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between text-xs">
        <span className="text-gray-400">Confidence Signal</span>
        <span
          className={`font-bold uppercase ${
            dispersion.confidenceSignal === 'high'
              ? 'text-green-400'
              : dispersion.confidenceSignal === 'reduced'
              ? 'text-yellow-400'
              : 'text-red-400'
          }`}
        >
          {dispersion.confidenceSignal}
        </span>
      </div>
    </div>
  );
}
