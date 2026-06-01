import { useState, useEffect } from 'react';
import { AlertTriangle, ShieldCheck, TrendingUp, Activity, Droplets, RefreshCw } from 'lucide-react';

interface DriftDimension {
  dimension: string;
  actualValue: number;
  thresholdValue: number;
  deviationPct: number;
  isDrifting: boolean;
}

interface DriftResult {
  userId: string;
  statedPreference: string;
  overallDriftPct: number;
  isDrifting: boolean;
  dimensions: DriftDimension[];
  message: string;
}

const PREFERENCE_COLORS: Record<string, string> = {
  conservative: 'from-blue-500/80 to-teal-600/80',
  balanced: 'from-amber-500/80 to-orange-600/80',
  aggressive: 'from-red-500/80 to-rose-600/80',
};

const DIMENSION_ICONS: Record<string, typeof Activity> = {
  concentration: TrendingUp,
  volatility: Activity,
  liquidity: Droplets,
};

export default function RiskPreferenceDriftIndicator({ walletAddress }: { walletAddress: string }) {
  const [driftResult, setDriftResult] = useState<DriftResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchDrift = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/risk/drift/detect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: walletAddress,
            statedPreference: 'balanced',
            positions: [
              { protocol: 'Blend', weightPct: 40, volatilityPct: 6, liquidityUsd: 1_000_000 },
              { protocol: 'Soroswap', weightPct: 35, volatilityPct: 15, liquidityUsd: 300_000 },
              { protocol: 'DeFindex', weightPct: 25, volatilityPct: 8, liquidityUsd: 500_000 },
            ],
          }),
        });
        const data = await res.json();
        setDriftResult(data.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch drift data');
      } finally {
        setLoading(false);
      }
    };

    void fetchDrift();
  }, [walletAddress]);

  if (loading) {
    return (
      <div className="glass-card p-5">
        <div className="flex items-center justify-center py-8">
          <RefreshCw size={24} className="animate-spin text-[#6C5DD3]" />
        </div>
      </div>
    );
  }

  if (error || !driftResult) {
    return (
      <div className="glass-card p-5 border border-red-500/30">
        <div className="flex items-center gap-2 text-red-400">
          <AlertTriangle size={16} />
          <p className="text-sm">{error || 'No drift data available'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {driftResult.isDrifting ? (
            <AlertTriangle size={18} className="text-amber-400" />
          ) : (
            <ShieldCheck size={18} className="text-green-400" />
          )}
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
            Risk Preference Drift
          </h3>
        </div>
        <span
          className={`px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wider bg-gradient-to-r ${PREFERENCE_COLORS[driftResult.statedPreference] ?? 'from-gray-500 to-gray-600'} text-white`}
        >
          {driftResult.statedPreference}
        </span>
      </div>

      <div className={`text-sm font-medium mb-3 ${driftResult.isDrifting ? 'text-amber-300' : 'text-green-300'}`}>
        {driftResult.message}
      </div>

      <div className="space-y-2">
        {driftResult.dimensions.map((dim) => {
          const Icon = DIMENSION_ICONS[dim.dimension] ?? Activity;
          return (
            <div
              key={dim.dimension}
              className={`flex items-center justify-between p-2.5 rounded-lg border ${
                dim.isDrifting
                  ? 'bg-amber-500/10 border-amber-500/30'
                  : 'bg-white/5 border-white/10'
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon size={14} className={dim.isDrifting ? 'text-amber-400' : 'text-gray-400'} />
                <span className="text-xs capitalize text-gray-300">{dim.dimension}</span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className={dim.isDrifting ? 'text-amber-400' : 'text-gray-400'}>
                  {dim.actualValue}{dim.dimension === 'liquidity' ? '' : '%'}
                </span>
                <span className="text-gray-600">/</span>
                <span className="text-gray-500">
                  {dim.thresholdValue}{dim.dimension === 'liquidity' ? '' : '%'}
                </span>
                {dim.isDrifting && (
                  <span className="text-amber-400 font-medium">
                    +{Math.round(Math.abs(dim.deviationPct))}%
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {driftResult.overallDriftPct > 0 && (
        <div className="mt-3 pt-3 border-t border-white/10">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-400">Overall Drift</span>
            <span className={`font-bold ${driftResult.isDrifting ? 'text-amber-400' : 'text-green-400'}`}>
              {driftResult.overallDriftPct}%
            </span>
          </div>
          <div className="mt-1.5 h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                driftResult.isDrifting ? 'bg-gradient-to-r from-amber-500 to-red-500' : 'bg-green-500'
              }`}
              style={{ width: `${Math.min(driftResult.overallDriftPct, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
