import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';
import type { RoutingRecommendation } from './types';

interface MaterialImpactWarningProps {
  executionQualityScore: number;
  routingRecommendation: RoutingRecommendation;
}

/**
 * MaterialImpactWarning displays a warning banner when material impact is detected.
 * Shows descriptive text, routing recommendations, and includes dismiss button.
 * 
 * Requirements: 4.3, 8.4
 */
export default function MaterialImpactWarning({
  executionQualityScore,
  routingRecommendation,
}: MaterialImpactWarningProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) {
    return null;
  }

  return (
    <div className="glass-card border-l-4 border-red-500 p-6 bg-red-950/20">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4 flex-1">
          <div className="rounded-xl bg-red-500/20 p-3 text-red-500 flex-shrink-0">
            <AlertTriangle size={24} />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-red-400 mb-2">
              Material Impact Detected
            </h3>
            <p className="text-sm text-red-200/80 mb-4">
              Current liquidity fragmentation is significantly affecting trade execution quality 
              (score: {executionQualityScore.toFixed(1)}/100). Consider the following recommendations 
              to optimize your trading strategy.
            </p>
            
            <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
              <div>
                <h4 className="text-sm font-semibold text-gray-300 mb-1">
                  Recommended Strategy
                </h4>
                <p className="text-sm text-gray-400">
                  {routingRecommendation.strategy === 'multi-protocol' 
                    ? 'Use multi-protocol routing to access deeper liquidity across multiple venues'
                    : 'Single-protocol routing is sufficient for current conditions'}
                </p>
              </div>
              
              {routingRecommendation.alternativeSuggestions.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-gray-300 mb-1">
                    Alternative Suggestions
                  </h4>
                  <ul className="text-sm text-gray-400 list-disc list-inside space-y-1">
                    {routingRecommendation.alternativeSuggestions.map((suggestion, index) => (
                      <li key={index}>{suggestion}</li>
                    ))}
                  </ul>
                </div>
              )}
              
              <div>
                <h4 className="text-sm font-semibold text-gray-300 mb-1">
                  Reasoning
                </h4>
                <p className="text-sm text-gray-400">
                  {routingRecommendation.reasoning}
                </p>
              </div>
            </div>
          </div>
        </div>
        
        <button
          onClick={() => setDismissed(true)}
          className="text-red-400 hover:text-red-300 transition-colors flex-shrink-0"
          aria-label="Dismiss warning"
        >
          <X size={20} />
        </button>
      </div>
    </div>
  );
}
