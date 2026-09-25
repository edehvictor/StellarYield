import { Network, Info } from 'lucide-react';
import { useState } from 'react';

interface EffectiveProtocolsCardProps {
  effectiveProtocolCount: number;
  hhi: number;
  multiProtocolRoutingPct: number;
}

/**
 * EffectiveProtocolsCard displays effective protocol count, HHI, and routing percentage.
 * Includes tooltip explanation for HHI.
 * 
 * Requirements: 4.1
 */
export default function EffectiveProtocolsCard({
  effectiveProtocolCount,
  hhi,
  multiProtocolRoutingPct,
}: EffectiveProtocolsCardProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div className="glass-card border-l-4 border-blue-500 p-6">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <p className="text-sm font-medium tracking-wide text-gray-400">
            EFFECTIVE PROTOCOLS
          </p>
          <h3 className="mt-1 text-3xl font-bold shadow-sm">
            {effectiveProtocolCount.toFixed(2)}
          </h3>
        </div>
        <div className="rounded-xl bg-blue-500/20 p-3 text-blue-500">
          <Network size={24} />
        </div>
      </div>
      
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-gray-400">
            <span>HHI</span>
            <button
              onMouseEnter={() => setShowTooltip(true)}
              onMouseLeave={() => setShowTooltip(false)}
              className="relative text-gray-500 hover:text-gray-300 transition-colors"
              aria-label="HHI explanation"
            >
              <Info size={14} />
              {showTooltip && (
                <div className="absolute left-0 top-6 z-10 w-64 rounded-lg bg-slate-800 border border-slate-700 p-3 text-xs text-gray-300 shadow-xl">
                  Herfindahl-Hirschman Index measures market concentration. 
                  Lower values indicate more competition and fragmentation.
                </div>
              )}
            </button>
          </div>
          <span className="font-semibold text-white">
            {hhi.toFixed(0)}
          </span>
        </div>
        
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Multi-Protocol Routing</span>
          <span className="font-semibold text-white">
            {multiProtocolRoutingPct.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}
