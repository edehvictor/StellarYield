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
import {
  ExportFailureError,
  toExportFailure,
} from "../types/exportFailure";

export const DEFAULT_EXPORT_RESPONSE_SIZE_LIMIT_BYTES = 1_000_000;

/** Default deadline for async export work (reliability scoring, aggregation). */
export const DEFAULT_EXPORT_TIMEOUT_MS = 15_000;

export class ExportSizeLimitExceededError extends ExportFailureError {
  public readonly actualBytes: number;
  public readonly limitBytes: number;

  constructor(actualBytes: number, limitBytes: number) {
    super(
      "EXPORT_SIZE_LIMIT_EXCEEDED",
      `Export response is ${actualBytes} bytes and exceeds the ${limitBytes} byte response-size limit.`,
      { actualBytes, limitBytes },
    );
    this.name = "ExportSizeLimitExceededError";
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
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
    throw new ExportFailureError(
      "EXPORT_VALIDATION_FAILED",
      "Export response-size limit must be a positive number of bytes.",
      { field: "maxResponseBytes" },
    );
  }

  return Math.floor(limit);
}

/**
 * Resolve the export deadline from request filters, defaulting to
 * {@link DEFAULT_EXPORT_TIMEOUT_MS}. Invalid values fail with a validation
 * failure code so the UI can show an input error rather than a 500.
 */
export function resolveExportTimeoutMs(filters: Record<string, any> = {}): number {
  const rawTimeout = filters.timeoutMs;
  if (rawTimeout === undefined || rawTimeout === null || rawTimeout === "") {
    return DEFAULT_EXPORT_TIMEOUT_MS;
  }

  const timeout = Number(rawTimeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new ExportFailureError(
      "EXPORT_VALIDATION_FAILED",
      "Export timeout must be a positive number of milliseconds.",
      { field: "timeoutMs" },
    );
  }

  return Math.floor(timeout);
}

/**
 * Race an export operation against a deadline. On expiry the promise rejects
 * with an `EXPORT_TIMEOUT` failure so callers (and the UI) can distinguish
 * timeouts from validation and service failures.
 */
export async function withExportTimeout<T>(
  operation: Promise<T> | (() => Promise<T> | T),
  timeoutMs: number = DEFAULT_EXPORT_TIMEOUT_MS,
  label = "Export",
): Promise<T> {
  const run: Promise<T> =
    typeof operation === "function"
      ? (async () => operation())()
      : operation;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ExportFailureError(
          "EXPORT_TIMEOUT",
          `${label} timed out after ${timeoutMs}ms.`,
          { timeoutMs },
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
   *
   * All failures are surfaced as typed `ExportFailureError`s carrying a
   * stable code: validation issues keep their validation codes, deadline
   * overruns surface as EXPORT_TIMEOUT, and unexpected/upstream failures
   * surface as EXPORT_SERVICE_UNAVAILABLE or EXPORT_SERVICE_FAILURE.
   */
  async generateSnapshotBundle(filters: Record<string, any> = {}): Promise<SnapshotBundle> {
    try {
      return await this.buildSnapshotBundle(filters);
    } catch (err) {
      throw ExportFailureError.from(toExportFailure(err));
    }
  }

  private async buildSnapshotBundle(filters: Record<string, any>): Promise<SnapshotBundle> {
    const now = new Date();
    const isoNow = now.toISOString();
    const timeoutMs = resolveExportTimeoutMs(filters);

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
    const reliabilityScores = await withExportTimeout(
      () =>
        yieldReliabilityEngine.getReliabilityScores(
          PROTOCOLS.map(p => ({
            id: p.protocolName.toLowerCase() + "_api",
            name: p.protocolName,
            source: p.source,
          }))
        ),
      timeoutMs,
      "Export bundle generation",
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

export { IDEMPOTENCY_KEY_TTL_MS };
