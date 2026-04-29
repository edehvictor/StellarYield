import { PROTOCOLS, ProtocolConfig } from "../config/protocols";
import { 
  rankStrategies, 
  computeRiskAdjustedYield,
  StrategyInput
} from "./riskAdjustedYieldService";
import { yieldReliabilityEngine } from "./yieldReliabilityService";
import { 
  computeConfidenceScore, 
  computeFreshnessScore,
  computeProviderAgreement,
  computeLiquidityScore,
  computeModelCompleteness,
  ConfidenceFactors
} from "./confidenceService";

export interface SnapshotBundle {
  timestamp: string;
  version: string;
  opportunities: OpportunitySnapshot[];
  metadata: {
    totalOpportunities: number;
    scoringMethodology: string;
  };
}

export interface OpportunitySnapshot {
  id: string;
  name: string;
  protocolType: string;
  apy: number;
  tvlUsd: number;
  liquidityUsd: number;
  riskScore: number;
  riskAdjustedYield: number;
  drawdown: {
    estimated: number;
    multiplier: number;
    proxy: number;
  };
  reliability: {
    score: number;
    status: string;
    freshness: number;
  };
  confidence: {
    score: number;
    label: string;
    factors: ConfidenceFactors;
  };
  metadata: {
    source: string;
    ageDays: number;
    fetchedAt: string;
  };
}

export class ExportService {
  /**
   * Generates a full snapshot bundle of current opportunity data.
   * Excludes secrets and internal-only metadata.
   */
  async generateSnapshotBundle(): Promise<SnapshotBundle> {
    const now = new Date();
    const isoNow = now.toISOString();

    const strategyInputs: StrategyInput[] = PROTOCOLS.map(p => ({
      id: p.protocolName.toLowerCase(),
      name: p.protocolName,
      strategyType: p.protocolType,
      apy: p.baseApyBps / 100,
      tvlUsd: p.baseTvlUsd,
      ilVolatilityPct: p.volatilityPct,
      riskScore: 7, // Default or derived risk score
      fetchedAt: isoNow,
    }));

    const ranked = rankStrategies(strategyInputs);
    const reliabilityScores = await yieldReliabilityEngine.getReliabilityScores(
      PROTOCOLS.map(p => ({
        id: p.protocolName.toLowerCase() + "_api",
        name: p.protocolName,
        source: p.source,
      }))
    );

    const snapshots: OpportunitySnapshot[] = ranked.map((s, index) => {
      const protocol = PROTOCOLS.find(p => p.protocolName.toLowerCase() === s.id)!;
      const reliability = reliabilityScores[index] || { reliabilityScore: 0, status: 'unknown', metrics: { freshness: 0 } };
      
      const confidenceFactors: ConfidenceFactors = {
        freshness: computeFreshnessScore(0), // Assumed fresh for snapshot
        providerAgreement: computeProviderAgreement([s.apy]), // Mock agreement
        liquidityQuality: computeLiquidityScore(s.tvlUsd),
        modelCompleteness: computeModelCompleteness(['apy', 'tvl', 'risk'], ['apy', 'tvl', 'risk']),
      };
      const confidence = computeConfidenceScore(confidenceFactors);

      return {
        id: s.id,
        name: s.name,
        protocolType: s.strategyType,
        apy: s.apy,
        tvlUsd: s.tvlUsd,
        liquidityUsd: protocol.liquidityUsd,
        riskScore: s.riskScore,
        riskAdjustedYield: s.riskAdjustedYield,
        drawdown: {
          estimated: s.estimatedDrawdown,
          multiplier: s.drawdownMultiplier,
          proxy: s.drawdownProxy,
        },
        reliability: {
          score: reliability.reliabilityScore,
          status: reliability.status,
          freshness: reliability.metrics.freshness,
        },
        confidence: {
          score: confidence.score,
          label: confidence.label,
          factors: confidence.factors,
        },
        metadata: {
          source: protocol.source,
          ageDays: protocol.protocolAgeDays,
          fetchedAt: isoNow,
        },
      };
    });

    return {
      timestamp: isoNow,
      version: "1.0.0",
      opportunities: snapshots,
      metadata: {
        totalOpportunities: snapshots.length,
        scoringMethodology: "RAY = APY * (riskScore / 10) * drawdownMultiplier / (1 + drawdownProxy)",
      },
    };
  }
}

export const exportService = new ExportService();
