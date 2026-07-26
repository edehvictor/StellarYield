/**
 * Yield Data Source Registry
 *
 * Turns the lower-level reliability signals produced by
 * {@link yieldReliabilityEngine} into a contributor-friendly health registry:
 * a flat list of every yield data source with its latest fetch time, uptime,
 * latency, and (when unhealthy) a human-readable failure reason.
 *
 * The registry uses an operator-facing status vocabulary
 * (`healthy | degraded | stale | unavailable`) that is intentionally simpler
 * than the engine's internal reliability tiers.
 */

import NodeCache from "node-cache";
import {
  yieldReliabilityEngine,
  type DataSourceReliability,
} from "./yieldReliabilityService";

export type SourceHealthStatus =
  | "healthy"
  | "degraded"
  | "stale"
  | "unavailable";

export interface SourceHealthSummary {
  providerId: string;
  providerName: string;
  dataSource: string;
  status: SourceHealthStatus;
  reliabilityScore: number; // 0-100
  uptimePct: number; // 0-100
  freshnessPct: number; // 0-100
  errorRatePct: number; // 0-100
  latencyMs: number;
  latestFetch: string; // ISO timestamp of the last successful fetch
  ageSeconds: number; // seconds elapsed since latestFetch
  consecutiveFailures: number;
  failureReason: string | null;
  trend: DataSourceReliability["trend"];
  cacheVersion: number;
}

export interface SourceHealthRegistry {
  generatedAt: string;
  totalSources: number;
  counts: Record<SourceHealthStatus, number>;
  sources: SourceHealthSummary[];
  cacheVersion: number;
  cacheAge: number;
}

// ── Classification thresholds ─────────────────────────────────────────────
// Exported so tests (and operators) can reason about the exact boundaries.

export const SOURCE_HEALTH_THRESHOLDS = {
  /** Data older than this (seconds) is considered stale. Matches the engine's 30m window. */
  staleAgeSeconds: 30 * 60,
  /** Below this freshness ratio (0-1) a source is treated as stale. */
  minFreshness: 0.5,
  /** A degraded source tolerates error rates up to this ratio (0-1). */
  degradedMaxErrorRate: 0.05,
  /** Above this latency (ms) a healthy source is downgraded to degraded. */
  degradedMaxLatencyMs: 800,
  /** Reliability score (0-100) at or above which a source can be healthy. */
  healthyMinScore: 70,
  /** Consecutive failures at or above which a source is unavailable. */
  unavailableConsecutiveFailures: 3,
  /** Error rate (0-1) at or above which a source is unavailable. */
  unavailableErrorRate: 0.5,
} as const;

/** Normalized inputs to the pure status classifier. */
export interface SourceHealthInput {
  reliabilityStatus: DataSourceReliability["status"];
  reliabilityScore: number;
  consecutiveFailures: number;
  errorRate: number; // 0-1
  latencyMs: number;
  freshness: number; // 0-1
  ageSeconds: number;
}

/**
 * Pure classifier: map normalized signals to an operator status and reason.
 * Kept separate from the engine so it is trivial to unit-test.
 */
export function classifySourceHealth(input: SourceHealthInput): {
  status: SourceHealthStatus;
  failureReason: string | null;
} {
  const t = SOURCE_HEALTH_THRESHOLDS;

  // Unavailable — the source cannot be trusted at all.
  if (
    input.reliabilityStatus === "unreliable" ||
    input.reliabilityScore <= 0 ||
    input.consecutiveFailures >= t.unavailableConsecutiveFailures ||
    input.errorRate >= t.unavailableErrorRate
  ) {
    let reason = "Provider marked unreliable";
    if (input.consecutiveFailures >= t.unavailableConsecutiveFailures) {
      reason = `${input.consecutiveFailures} consecutive fetch failures`;
    } else if (input.errorRate >= t.unavailableErrorRate) {
      reason = `Error rate ${Math.round(input.errorRate * 100)}% exceeds safe threshold`;
    }
    return { status: "unavailable", failureReason: reason };
  }

  // Stale — connectivity is fine but the data is too old.
  if (input.ageSeconds > t.staleAgeSeconds || input.freshness < t.minFreshness) {
    const minutes = Math.round(input.ageSeconds / 60);
    return {
      status: "stale",
      failureReason: `No fresh data for ${minutes}m`,
    };
  }

  // Degraded — usable but worth watching.
  if (
    input.reliabilityStatus === "low" ||
    input.errorRate > t.degradedMaxErrorRate ||
    input.latencyMs > t.degradedMaxLatencyMs ||
    input.reliabilityScore < t.healthyMinScore
  ) {
    let reason = `Reliability score ${input.reliabilityScore} below target`;
    if (input.latencyMs > t.degradedMaxLatencyMs) {
      reason = `Elevated latency ${Math.round(input.latencyMs)}ms`;
    } else if (input.errorRate > t.degradedMaxErrorRate) {
      reason = `Elevated error rate ${Math.round(input.errorRate * 100)}%`;
    }
    return { status: "degraded", failureReason: reason };
  }

  return { status: "healthy", failureReason: null };
}

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Map a single reliability record to a registry health summary.
 */
export function toSourceHealth(
  reliability: DataSourceReliability,
  now: number = Date.now(),
): SourceHealthSummary {
  const { metrics, signals } = reliability;
  const lastFetchMs = new Date(signals.lastSuccessfulFetch).getTime();
  const ageSeconds = Number.isFinite(lastFetchMs)
    ? Math.max(0, Math.round((now - lastFetchMs) / 1000))
    : Number.POSITIVE_INFINITY;

  const { status, failureReason } = classifySourceHealth({
    reliabilityStatus: reliability.status,
    reliabilityScore: reliability.reliabilityScore,
    consecutiveFailures: signals.consecutiveFailures,
    errorRate: metrics.errorRate,
    latencyMs: metrics.latency,
    freshness: metrics.freshness,
    ageSeconds,
  });

  return {
    providerId: reliability.providerId,
    providerName: reliability.providerName,
    dataSource: reliability.dataSource,
    status,
    reliabilityScore: Math.round(reliability.reliabilityScore),
    uptimePct: round(metrics.historicalUptime * 100),
    freshnessPct: round(metrics.freshness * 100),
    errorRatePct: round(metrics.errorRate * 100),
    latencyMs: Math.round(metrics.latency),
    latestFetch: signals.lastSuccessfulFetch,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : -1,
    consecutiveFailures: signals.consecutiveFailures,
    failureReason,
    trend: reliability.trend,
    cacheVersion: 0,
  };
}

/**
 * Build a status-count summary keyed by every possible status.
 */
export function summarizeSourceHealth(
  sources: SourceHealthSummary[],
): Record<SourceHealthStatus, number> {
  const counts: Record<SourceHealthStatus, number> = {
    healthy: 0,
    degraded: 0,
    stale: 0,
    unavailable: 0,
  };
  for (const source of sources) {
    counts[source.status] += 1;
  }
  return counts;
}

/** Registered yield data sources tracked by the health dashboard. */
const REGISTERED_SOURCES: Array<{ id: string; name: string; source: string }> =
  [
    { id: "blend_api", name: "Blend Protocol", source: "api" },
    { id: "soroswap_api", name: "Soroswap", source: "api" },
    { id: "defindex_api", name: "DeFindex", source: "api" },
    { id: "stellar_expert", name: "Stellar Expert", source: "oracle" },
    { id: "coingecko", name: "CoinGecko", source: "oracle" },
  ];

// ── Bounded cache ─────────────────────────────────────────────────────────
// Each registry entry is cached with a version number. When source metadata or
// health status changes the affected entries are invalidated so the next read
// produces fresh data.  The cache is bounded by TTL and maximum size.

const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes
const CACHE_MAX_KEYS = 100;

interface CacheEntry {
  summary: SourceHealthSummary;
  cachedAt: number;
}

const registryCache = new NodeCache({
  stdTTL: CACHE_TTL_SECONDS,
  maxKeys: CACHE_MAX_KEYS,
  checkperiod: 120,
});

let globalCacheVersion = 1;

function nextCacheVersion(): number {
  globalCacheVersion += 1;
  return globalCacheVersion;
}

/**
 * Invalidate cache entries for one or all yield sources.
 * Call this when source metadata or health status changes upstream.
 *
 * @param providerId - Optional specific provider to invalidate. Omitting
 *                     invalidates the entire registry cache.
 */
export function invalidateSourceCache(providerId?: string): void {
  if (providerId) {
    registryCache.del(`registry:${providerId}`);
  } else {
    registryCache.flushAll();
  }
  nextCacheVersion();
}

/**
 * Read-only health registry for every registered yield data source.
 * Results are cached with versioning and automatically invalidated on TTL
 * expiry or when {@link invalidateSourceCache} is called.
 */
export async function getSourceHealthRegistry(): Promise<SourceHealthRegistry> {
  const now = Date.now();

  // Attempt a full-registry cache hit.
  const cachedRegistry = registryCache.get<{
    sources: SourceHealthSummary[];
    cachedAt: number;
  }>("registry:full");
  if (cachedRegistry) {
    return {
      generatedAt: new Date(now).toISOString(),
      totalSources: cachedRegistry.sources.length,
      counts: summarizeSourceHealth(cachedRegistry.sources),
      sources: cachedRegistry.sources,
      cacheVersion: globalCacheVersion,
      cacheAge: Math.round((now - cachedRegistry.cachedAt) / 1000),
    };
  }

  const reliabilityScores =
    await yieldReliabilityEngine.getReliabilityScores(REGISTERED_SOURCES);

  const sources = reliabilityScores
    .map((reliability) => toSourceHealth(reliability, now))
    .sort((a, b) => a.reliabilityScore - b.reliabilityScore);

  // Assign cache version to each entry and store individually.
  const version = globalCacheVersion;
  for (const source of sources) {
    source.cacheVersion = version;
    registryCache.set(
      `registry:${source.providerId}`,
      { summary: source, cachedAt: now } satisfies CacheEntry,
    );
  }

  // Store the full result for bulk reads.
  registryCache.set("registry:full", { sources, cachedAt: now });

  return {
    generatedAt: new Date(now).toISOString(),
    totalSources: sources.length,
    counts: summarizeSourceHealth(sources),
    sources,
    cacheVersion: version,
    cacheAge: 0,
  };
}
