import { PROTOCOLS } from "../config/protocols";
import { 
  rankStrategies, 
  type StrategyInput
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
  version: string;
  generatedAt: string;
  timestamp: string;  // alias for generatedAt (backward-compat)
  appVersion: string;
  opportunities: OpportunitySnapshot[];
  metadata: {
    totalOpportunities: number;
    scoringMethodology: string;
    sourceFreshness: number;
    filtersApplied: Record<string, any>;
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

interface IdempotentExportJob {
  key: string;
  params: Record<string, any>;
  result: SnapshotBundle;
  createdAt: number;
}

/** Default TTL for idempotency keys (24 hours). */
const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyCheckResult {
  status: "hit" | "mismatch" | "stale" | "miss";
  result?: SnapshotBundle;
}

export class ExportService {
  private idempotencyCache = new Map<string, IdempotentExportJob>();

  /**
   * Checks whether an idempotency key already has a stored result.
   *
   * - "hit"    → caller should return the cached result immediately.
   * - "mismatch" → the key exists but was created with different params;
   *                 caller must reject with 422.
   * - "stale"  → the key exists but has expired; caller should treat as
   *               a fresh request ("miss") and overwrite the stale entry.
   * - "miss"   → no entry for this key; proceed normally.
   */
  checkIdempotency(
    key: string,
    currentParams: Record<string, any>,
  ): IdempotencyCheckResult {
    const existing = this.idempotencyCache.get(key);
    if (!existing) return { status: "miss" };

    if (Date.now() - existing.createdAt > IDEMPOTENCY_KEY_TTL_MS) {
      this.idempotencyCache.delete(key);
      return { status: "stale" };
    }

    const paramsMatch =
      JSON.stringify(existing.params) === JSON.stringify(currentParams);
    if (!paramsMatch) return { status: "mismatch" };

    return { status: "hit", result: existing.result };
  }

  /**
   * Stores a result against the given idempotency key.
   */
  storeIdempotentResult(
    key: string,
    params: Record<string, any>,
    result: SnapshotBundle,
  ): void {
    this.idempotencyCache.set(key, {
      key,
      params,
      result,
      createdAt: Date.now(),
    });
  }

  /**
   * Generates a full snapshot bundle of current opportunity data.
   * Excludes secrets and internal-only metadata.
   */
  async generateSnapshotBundle(filters: Record<string, any> = {}): Promise<SnapshotBundle> {
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

    const avgFreshness = snapshots.length > 0
      ? snapshots.reduce((acc, s) => acc + s.reliability.freshness, 0) / snapshots.length
      : 0;

    return {
      version: "1.0.0",
      generatedAt: isoNow,
      timestamp: isoNow,
      appVersion: "1.0.0",
      opportunities: snapshots,
      metadata: {
        totalOpportunities: snapshots.length,
        scoringMethodology: "RAY = APY * (riskScore / 10) * drawdownMultiplier / (1 + drawdownProxy)",
        sourceFreshness: Math.round(avgFreshness * 100) / 100,
        filtersApplied: filters,
      },
    };
  }
}

export const exportService = new ExportService();

export { IDEMPOTENCY_KEY_TTL_MS };
