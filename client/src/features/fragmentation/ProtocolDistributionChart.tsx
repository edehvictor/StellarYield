import { PieChart, Star } from 'lucide-react';
import type { ProtocolContribution } from './types';

interface ProtocolDistributionChartProps {
  protocolBreakdown: ProtocolContribution[];
}

/**
 * ProtocolDistributionChart displays TVL distribution across protocols.
 * Uses a horizontal bar chart showing protocol names and percentages.
 * Highlights the protocol with deepest liquidity.
 * Responsive for mobile and desktop.
 * 
 * Requirements: 4.4, 8.3
 */
export default function ProtocolDistributionChart({
  protocolBreakdown,
}: ProtocolDistributionChartProps) {
  // Sort by TVL share descending
  const sortedProtocols = [...protocolBreakdown].sort((a, b) => b.tvlShare - a.tvlShare);

  // Color palette for protocols
  const colors = [
    'bg-indigo-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-blue-500',
    'bg-cyan-500',
    'bg-teal-500',
  ];

  return (
    <div className="glass-panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.05)] p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-indigo-500/20 p-2 text-indigo-400">
            <PieChart size={20} />
          </div>
          <h3 className="text-xl font-bold">Protocol Distribution</h3>
        </div>
      </div>

      <div className="p-6 space-y-4">
        {sortedProtocols.map((protocol, index) => (
          <div key={protocol.protocol} className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-white">
                  {protocol.protocol}
                </span>
                {protocol.isDeepest && (
                  <div className="flex items-center gap-1 text-xs text-yellow-400">
                    <Star size={14} fill="currentColor" />
                    <span>Deepest</span>
                  </div>
                )}
              </div>
              <span className="text-sm font-bold text-gray-300">
                {protocol.tvlShare.toFixed(1)}%
              </span>
            </div>
            
            <div className="relative h-8 bg-slate-800/50 rounded-lg overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 ${colors[index % colors.length]} transition-all duration-500 ease-out flex items-center justify-end pr-3`}
                style={{ width: `${protocol.tvlShare}%` }}
              >
                {protocol.tvlShare > 10 && (
                  <span className="text-xs font-bold text-white">
                    {protocol.tvlShare.toFixed(1)}%
                  </span>
                )}
              </div>
            </div>

            {protocol.executionImpact > 0 && (
              <div className="text-xs text-gray-400">
                Execution impact: {protocol.executionImpact.toFixed(1)}%
              </div>
            )}
          </div>
        ))}
      </div>

      {sortedProtocols.length === 0 && (
        <div className="p-12 text-center text-gray-500">
          No protocol data available
        </div>
      )}
    </div>
  );
}
