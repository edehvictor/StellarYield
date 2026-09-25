import { Navigation, ArrowRight, Lightbulb } from 'lucide-react';
import type { RoutingRecommendation } from './types';

interface RoutingRecommendationsProps {
  recommendation: RoutingRecommendation;
  fragmentationScore: number;
}

/**
 * RoutingRecommendations displays routing recommendations based on fragmentation level.
 * Shows recommended strategy, deepest liquidity protocol, and alternative suggestions.
 * 
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */
export default function RoutingRecommendations({
  recommendation,
  fragmentationScore,
}: RoutingRecommendationsProps) {
  const isHighFragmentation = fragmentationScore > 60;
  const isLowFragmentation = fragmentationScore < 30;

  return (
    <div className="glass-panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.05)] p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-purple-500/20 p-2 text-purple-400">
            <Navigation size={20} />
          </div>
          <h3 className="text-xl font-bold">Routing Recommendations</h3>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Recommended Strategy */}
        <div className="bg-slate-800/30 rounded-lg p-5 border-l-4 border-purple-500">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-purple-500/20 p-2 text-purple-400 flex-shrink-0">
              <ArrowRight size={20} />
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-purple-400 mb-2 uppercase tracking-wider">
                Recommended Strategy
              </h4>
              <p className="text-base font-semibold text-white mb-2">
                {recommendation.strategy === 'multi-protocol' 
                  ? 'Multi-Protocol Routing' 
                  : 'Single-Protocol Routing'}
              </p>
              <p className="text-sm text-gray-400">
                {isHighFragmentation && (
                  'High fragmentation detected. Use multi-protocol routing to access deeper liquidity across multiple venues and minimize slippage.'
                )}
                {isLowFragmentation && (
                  'Low fragmentation detected. Single-protocol routing is sufficient for optimal execution with minimal complexity.'
                )}
                {!isHighFragmentation && !isLowFragmentation && (
                  'Moderate fragmentation. Consider your trade size when choosing between single and multi-protocol routing.'
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Deepest Liquidity Protocol */}
        <div className="bg-slate-800/30 rounded-lg p-5">
          <h4 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
            Deepest Liquidity
          </h4>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-indigo-500/20 px-4 py-2">
              <span className="text-lg font-bold text-indigo-400">
                {recommendation.deepestProtocol}
              </span>
            </div>
            <p className="text-sm text-gray-400">
              This protocol currently has the highest TVL and deepest liquidity pools
            </p>
          </div>
        </div>

        {/* Alternative Suggestions */}
        {recommendation.alternativeSuggestions.length > 0 && (
          <div className="bg-slate-800/30 rounded-lg p-5">
            <div className="flex items-start gap-3 mb-4">
              <div className="rounded-lg bg-yellow-500/20 p-2 text-yellow-400 flex-shrink-0">
                <Lightbulb size={20} />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-yellow-400 mb-1 uppercase tracking-wider">
                  Alternative Strategies
                </h4>
                <p className="text-sm text-gray-400">
                  Consider these alternatives to optimize your trading outcomes
                </p>
              </div>
            </div>
            <ul className="space-y-2 ml-11">
              {recommendation.alternativeSuggestions.map((suggestion, index) => (
                <li key={index} className="flex items-start gap-2 text-sm text-gray-300">
                  <span className="text-yellow-400 flex-shrink-0">•</span>
                  <span>{suggestion}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Reasoning */}
        <div className="bg-slate-800/30 rounded-lg p-5">
          <h4 className="text-sm font-semibold text-gray-300 mb-2 uppercase tracking-wider">
            Analysis
          </h4>
          <p className="text-sm text-gray-400 leading-relaxed">
            {recommendation.reasoning}
          </p>
        </div>
      </div>
    </div>
  );
}
