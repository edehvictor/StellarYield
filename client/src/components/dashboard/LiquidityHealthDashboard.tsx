import React, { useEffect, useState } from 'react';
import { Activity, ShieldCheck, ShieldAlert, ShieldX, Info } from 'lucide-react';

interface LiquidityHealth {
  strategyId: string;
  score: number;
  status: 'healthy' | 'warning' | 'critical';
  components: {
    depth: number;
    spread: number;
    stability: number;
    withdrawalSensitivity: number;
  };
  updatedAt: string;
}

export const LiquidityHealthDashboard: React.FC = () => {
  const [scores, setScores] = useState<LiquidityHealth[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Mocking API call - in production this would fetch from /api/liquidity/health
    const mockScores: LiquidityHealth[] = [
      {
        strategyId: 'blend',
        score: 85,
        status: 'healthy',
        components: { depth: 80, spread: 90, stability: 85, withdrawalSensitivity: 85 },
        updatedAt: new Date().toISOString()
      },
      {
        strategyId: 'soroswap',
        score: 55,
        status: 'warning',
        components: { depth: 40, spread: 60, stability: 50, withdrawalSensitivity: 70 },
        updatedAt: new Date().toISOString()
      }
    ];
    
    setTimeout(() => {
      setScores(mockScores);
      setLoading(false);
    }, 800);
  }, []);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'healthy': return <ShieldCheck className="text-green-500" />;
      case 'warning': return <ShieldAlert className="text-amber-500" />;
      case 'critical': return <ShieldX className="text-red-500" />;
      default: return <Activity className="text-slate-400" />;
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 70) return 'bg-green-500';
    if (score >= 40) return 'bg-amber-500';
    return 'bg-red-500';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="animate-pulse flex space-x-2">
          <div className="h-2 w-2 bg-slate-400 rounded-full"></div>
          <div className="h-2 w-2 bg-slate-400 rounded-full"></div>
          <div className="h-2 w-2 bg-slate-400 rounded-full"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
      <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="text-blue-500" />
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Liquidity Health</h3>
        </div>
        <button className="text-slate-400 hover:text-slate-600 transition-colors">
          <Info size={18} />
        </button>
      </div>

      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {scores.map((s) => (
          <div key={s.strategyId} className="p-6 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                {getStatusIcon(s.status)}
                <span className="font-semibold text-slate-900 dark:text-white capitalize">{s.strategyId}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-1 rounded text-xs font-bold text-white ${getScoreColor(s.score)}`}>
                  {s.score}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-2">
              <ComponentBar label="Depth" value={s.components.depth} color="bg-blue-500" />
              <ComponentBar label="Spread" value={s.components.spread} color="bg-indigo-500" />
              <ComponentBar label="Stability" value={s.components.stability} color="bg-cyan-500" />
              <ComponentBar label="Withdrawal" value={s.components.withdrawalSensitivity} color="bg-teal-500" />
            </div>

            {s.status === 'critical' && (
              <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-100 dark:border-red-900/30 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
                <ShieldX size={14} />
                Execution suppressed due to critical liquidity health.
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const ComponentBar: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div>
    <div className="flex justify-between items-center mb-1">
      <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">{label}</span>
      <span className="text-[10px] font-mono text-slate-600 dark:text-slate-400">{value}%</span>
    </div>
    <div className="h-1 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
      <div 
        className={`h-full ${color} transition-all duration-500`} 
        style={{ width: `${value}%` }}
      />
    </div>
  </div>
);
