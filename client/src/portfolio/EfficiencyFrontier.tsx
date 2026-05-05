import React, { useState, useMemo } from 'react';
import { 
  ScatterChart, 
  Scatter, 
  XAxis, 
  YAxis, 
  ZAxis, 
  Tooltip, 
  ResponsiveContainer, 
  Line,
  Cell
} from 'recharts';
import { TrendingUp, AlertTriangle, ArrowRightLeft, Info } from 'lucide-react';

interface FrontierPoint {
  risk: number;
  return: number;
  name?: string;
  type: 'frontier' | 'current' | 'candidate';
}

export const EfficiencyFrontier: React.FC = () => {
  const [selectedAdjustment, setSelectedAdjustment] = useState<string | null>(null);

  const data: FrontierPoint[] = useMemo(() => {
    // Mock frontier data
    const frontier: FrontierPoint[] = [
      { risk: 2.1, return: 4.5, type: 'frontier' },
      { risk: 3.5, return: 6.2, type: 'frontier' },
      { risk: 5.2, return: 8.4, type: 'frontier' },
      { risk: 7.8, return: 11.2, type: 'frontier' },
      { risk: 10.5, return: 14.8, type: 'frontier' },
    ];

    const current: FrontierPoint = { risk: 6.5, return: 7.2, name: 'Current Portfolio', type: 'current' };
    
    const candidates: FrontierPoint[] = [
      { risk: 4.8, return: 8.1, name: 'Conservative Rebalance', type: 'candidate' },
      { risk: 8.2, return: 11.5, name: 'Yield Optimization', type: 'candidate' },
    ];

    return [...frontier, current, ...candidates];
  }, []);

  const currentPos = data.find(p => p.type === 'current')!;
  const candidates = data.filter(p => p.type === 'candidate');

  return (
    <div className="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-2">
          <TrendingUp className="text-blue-500" />
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Capital Efficiency Frontier</h3>
        </div>
        <div className="flex items-center gap-1 text-xs text-slate-400">
          <Info size={14} />
          <span>Lower risk & Higher return is better</span>
        </div>
      </div>

      <div className="h-72 w-full mb-8">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
            <XAxis 
              type="number" 
              dataKey="risk" 
              name="Risk" 
              unit="%" 
              label={{ value: 'Risk (Volatility)', position: 'bottom', offset: 0, fontSize: 12 }} 
            />
            <YAxis 
              type="number" 
              dataKey="return" 
              name="Return" 
              unit="%" 
              label={{ value: 'Return (APY)', angle: -90, position: 'left', fontSize: 12 }} 
            />
            <ZAxis type="number" range={[100, 400]} />
            <Tooltip 
              cursor={{ strokeDasharray: '3 3' }} 
              contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
            />
            
            {/* The Efficient Frontier Curve */}
            <Scatter name="Efficient Frontier" data={data.filter(p => p.type === 'frontier')} fill="#3b82f6" line shape="circle" opacity={0.5} />
            
            {/* Current Position */}
            <Scatter name="Current Position" data={[currentPos]} fill="#6366f1">
              <Cell fill="#6366f1" strokeWidth={4} stroke="#818cf8" />
            </Scatter>

            {/* Candidate Adjustments */}
            <Scatter name="Candidates" data={candidates} fill="#10b981">
              {candidates.map((entry, index) => (
                <Cell 
                  key={`cell-${index}`} 
                  fill={selectedAdjustment === entry.name ? "#10b981" : "#d1fae5"} 
                  stroke={selectedAdjustment === entry.name ? "#059669" : "#10b981"}
                  className="cursor-pointer transition-all duration-300"
                  onClick={() => setSelectedAdjustment(entry.name || null)}
                />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      <div className="space-y-4">
        <h4 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Candidate Adjustments</h4>
        {candidates.map((c) => (
          <div 
            key={c.name}
            onClick={() => setSelectedAdjustment(c.name || null)}
            className={`p-4 rounded-xl border transition-all cursor-pointer ${
              selectedAdjustment === c.name 
                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20' 
                : 'border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium text-slate-900 dark:text-white">{c.name}</span>
              <div className="flex items-center gap-2">
                <div className={`px-2 py-0.5 rounded text-[10px] font-bold text-white bg-emerald-500`}>
                  +{ (c.return - currentPos.return).toFixed(1) }% APY
                </div>
                <div className={`px-2 py-0.5 rounded text-[10px] font-bold text-white ${c.risk < currentPos.risk ? 'bg-blue-500' : 'bg-slate-400'}`}>
                  { (c.risk - currentPos.risk).toFixed(1) }% Risk
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <ArrowRightLeft size={14} />
              <span>Shift: Move { Math.abs(c.risk - currentPos.risk).toFixed(1) }% {c.risk < currentPos.risk ? 'left' : 'right'} and { Math.abs(c.return - currentPos.return).toFixed(1) }% up.</span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-100 dark:border-blue-900/30 flex items-start gap-3">
        <Info size={18} className="text-blue-500 mt-0.5 shrink-0" />
        <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
          Frontier projections are estimates based on historical volatility and current yield. They represent potential trade-offs and are not guaranteed outcomes.
        </p>
      </div>
    </div>
  );
};
