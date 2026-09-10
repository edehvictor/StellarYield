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
import { PortfolioService, type VaultPosition } from "./portfolioService";

export const DEFAULT_EXPORT_RESPONSE_SIZE_LIMIT_BYTES = 1_000_000;

export class ExportSizeLimitExceededError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly limitBytes: number,
  ) {
    super(
      `Export response is ${actualBytes} bytes and exceeds the ${limitBytes} byte response-size limit.`,
    );
    this.name = "ExportSizeLimitExceededError";
  }
}

function getExportPayloadSizeBytes(payload: string): number {
  return typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(payload).byteLength
    : payload.length;
}

function resolveExportSizeLimit(filters: Record<string, any>): number {
  const rawLimit = filters.maxResponseBytes ?? filters.responseSizeLimitBytes;
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return DEFAULT_EXPORT_RESPONSE_SIZE_LIMIT_BYTES;
  }

  const limit = Number(rawLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("Export response-size limit must be a positive number of bytes.");
  }

  return Math.floor(limit);
}

export function assertWithinExportSizeLimit(
  payload: string,
  limitBytes: number = DEFAULT_EXPORT_RESPONSE_SIZE_LIMIT_BYTES,
): string {
  const actualBytes = getExportPayloadSizeBytes(payload);
  if (actualBytes > limitBytes) {
    throw new ExportSizeLimitExceededError(actualBytes, limitBytes);
  }
  return payload;
}

export interface SnapshotBundle {
  version: string;
  generatedAt: string;
  timestamp: string;
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

export class ExportService {
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
      riskScore: 7,
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
      const reliability = reliabilityScores[index] || { reliabilityScore: 0, status: "unknown", metrics: { freshness: 0 } };

      const confidenceFactors: ConfidenceFactors = {
        freshness: computeFreshnessScore(0),
        providerAgreement: computeProviderAgreement([s.apy]),
        liquidityQuality: computeLiquidityScore(s.tvlUsd),
        modelCompleteness: computeModelCompleteness(["apy", "tvl", "risk"], ["apy", "tvl", "risk"]),
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

  async exportPortfolio(
    positions: VaultPosition[],
    filters: Record<string, any>
  ): Promise<string> {
    const filtered = PortfolioService.filterPositionsByAssetClass(positions, filters);
    const limitBytes = resolveExportSizeLimit(filters);

    const headers = ["Protocol", "Asset", "Deposited USD", "Current Value USD", "Asset Class"];
    const rows = filtered.map(pos => [
      pos.protocol,
      pos.asset,
      pos.depositedUsd.toFixed(2),
      pos.currentValueUsd.toFixed(2),
      PortfolioService.getAssetClass(pos.asset)
    ].map(val => {
      const s = String(val);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    }).join(","));

    const csv = [headers.join(","), ...rows].join("\n");
    return assertWithinExportSizeLimit(csv, limitBytes);
  }
}

export const exportService = new ExportService();