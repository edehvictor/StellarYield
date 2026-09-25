export type FragmentationCategory = 'Low' | 'Medium' | 'High';

export interface ProtocolContribution {
  protocol: string;
  tvlShare: number;              // Percentage of total TVL
  executionImpact: number;       // Contribution to quality degradation
  isDeepest: boolean;            // True if this protocol has deepest liquidity
}

export interface DataCompletenessStatus {
  poolDepthAvailable: boolean;
  routeDataAvailable: boolean;
  missingProtocols: string[];
  isStale: boolean;
  staleSince?: string;
}

export interface RoutingRecommendation {
  strategy: 'single-protocol' | 'multi-protocol';
  deepestProtocol: string;
  alternativeSuggestions: string[];
  reasoning: string;
}

export interface FragmentationMetrics {
  fragmentationScore: number;        // 0-100 scale
  hhi: number;                        // Herfindahl-Hirschman Index
  effectiveProtocolCount: number;    // 1/HHI
  multiProtocolRoutingPct: number;   // Percentage of trades requiring multi-protocol routing
  executionQualityScore: number;     // 0-100 scale
  materialImpact: boolean;           // True if execution quality < 70
  category: FragmentationCategory;
  categoryDescription: string;
  protocolBreakdown: ProtocolContribution[];
  dataCompleteness: DataCompletenessStatus;
  routingRecommendation: RoutingRecommendation;
  timestamp: string;
  nextUpdateAt: string;
}

export interface FragmentationAPIResponse {
  success: boolean;
  data: FragmentationMetrics;
  meta: {
    cacheStatus: 'HIT' | 'MISS';
    computeTimeMs: number;
    nextUpdateAt: string;
  };
}

export interface FragmentationErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: {
      missingProtocols?: string[];
      lastSuccessfulUpdate?: string;
    };
  };
}
