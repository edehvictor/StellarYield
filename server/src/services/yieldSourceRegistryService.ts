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
 *
 * Cache invalidation (#981):
 * The registry maintains an in-memory cache with a version counter. The cache
 * is invalidated (regenerated) when:
 *   1. The set of registered source IDs changes (provider added/removed).
 *   2. Any source's health status or failure reason changes.
 *   3. Any source's metadata (name or data source type) changes.
 * The cache age and version are exposed in diagnostics.
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
}

export interface YieldSourceRegistryEntry {
  id: string;
  name: string;
  source: string;
  aliases?: string[];
  sourceLabels?: string[];
  sourceLabel?: string;
}

export type RegistryConflictType = "providerId" | "alias" | "sourceLabel";

export interface RegistryConflict {
  type: RegistryConflictType;
  identityKinds: RegistryConflictType[];
  identity: string;
  entries: Array<{ providerId: string; providerName: string }>;
  message: string;
}

export interface RegistryConflictResult {
  status: "valid" | "conflicted";
  conflicts: RegistryConflict[];
}

/**
 * Extended registry response with bounded cache invalidation diagnostics.
 * Exposes cacheAge (seconds since last generation) and cacheVersion (monotonic
 * counter that increments on each invalidation) per issue #981.
 */
export interface SourceHealthRegistry {
  generatedAt: string;
  conflictStatus: RegistryConflictResult["status"];
  conflicts: RegistryConflict[];
  totalSources: number;
  counts: Record<SourceHealthStatus, number>;
  sources: SourceHealthSummary[];
  /** Age of the cached result in seconds (0 if freshly generated). */
  cacheAge: number;
  /** Monotonic version counter. Increments each time the cache is invalidated. */
  cacheVersion: number;
  /** ISO timestamp of the last cache invalidation (or generation if never invalidated). */
  lastInvalidatedAt: string;
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
  if (
    input.ageSeconds > t.staleAgeSeconds ||
    input.freshness < t.minFreshness
  ) {
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
export const REGISTERED_SOURCES: YieldSourceRegistryEntry[] = [
  { id: "blend_api", name: "Blend Protocol", source: "api" },
  { id: "soroswap_api", name: "Soroswap", source: "api" },
  { id: "defindex_api", name: "DeFindex", source: "api" },
  { id: "stellar_expert", name: "Stellar Expert", source: "oracle" },
  { id: "coingecko", name: "CoinGecko", source: "oracle" },
];

function normalizeIdentity(identity: string): string {
  const value = identity.trim().toLowerCase();
  if (!value) return "";

  try {
    const url = new URL(value);
    return `${url.host}${url.pathname.replace(/\/$/, "") || "/"}`;
  } catch {
    return value.replace(/\s+/g, " ");
  }
}

/**
 * Find identities shared by different registry entries. URL labels retain
 * their path, so two feeds on one host remain distinct when their paths differ.
 */
export function detectRegistryConflicts(
  entries: YieldSourceRegistryEntry[],
): RegistryConflictResult {
  const identities = new Map<string, Map<RegistryConflictType, Set<number>>>();

  const addIdentity = (
    type: RegistryConflictType,
    value: string,
    index: number,
  ) => {
    const normalized = normalizeIdentity(value);
    if (!normalized) return;
    const byType = identities.get(normalized) ?? new Map();
    const indexes = byType.get(type) ?? new Set<number>();
    indexes.add(index);
    byType.set(type, indexes);
    identities.set(normalized, byType);
  };

  entries.forEach((entry, index) => {
    addIdentity("providerId", entry.id, index);
    for (const alias of entry.aliases ?? []) addIdentity("alias", alias, index);
    for (const label of [entry.sourceLabel, ...(entry.sourceLabels ?? [])]) {
      if (label) addIdentity("sourceLabel", label, index);
    }
  });

  const conflicts: RegistryConflict[] = [];
  for (const [identity, byType] of identities) {
    const indexes = new Set(
      [...byType.values()].flatMap((value) => [...value]),
    );
    if (indexes.size < 2) continue;
    const type =
      (["providerId", "alias", "sourceLabel"] as RegistryConflictType[]).find(
        (candidate) => (byType.get(candidate)?.size ?? 0) > 1,
      ) ?? ([...byType.keys()][0] as RegistryConflictType);
    const conflictEntries = [...indexes].map((index) => ({
      providerId: entries[index]!.id,
      providerName: entries[index]!.name,
    }));
    conflicts.push({
      type,
      identityKinds: [...byType.keys()],
      identity,
      entries: conflictEntries,
      message: `${type} "${identity}" is shared by ${conflictEntries.map((entry) => entry.providerName).join(", ")}`,
    });
  }

  return {
    status: conflicts.length > 0 ? "conflicted" : "valid",
    conflicts,
  };
}

// ── Bounded cache invalidation (#981) ──────────────────────────────────────

export const REGISTRY_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes

interface RegistryCacheEntry {
  registry: SourceHealthRegistry;
  /** Monotonic version number, incremented on each invalidation. */
  version: number;
  /** Timestamp (epoch ms) when this entry was generated. */
  generatedAt: number;
  /** Snapshot of provider IDs at generation time, used to detect changes. */
  knownProviderIds: string[];
  /** Snapshot of provider statuses (status + failureReason), used to detect health changes. */
  knownStatuses: Map<
    string,
    { status: SourceHealthStatus; failureReason: string | null }
  >;
  /** Snapshot of provider metadata (name + source), used to detect metadata changes. */
  knownMetadata: Map<string, { name: string; source: string }>;
}

const registryCache = new NodeCache({
  stdTTL: REGISTRY_CACHE_TTL_SECONDS,
  checkperiod: 60,
  useClones: false,
});

let cacheVersionCounter = 0;
let lastInvalidatedAt = new Date().toISOString();
const CACHE_KEY = "yieldSourceHealthRegistry";

/**
 * Check whether the cached registry is still valid by comparing the current
 * registered sources and their health status against the snapshot stored in
 * the cache entry. Returns `true` if the cache is still fresh.
 */
function isRegistryCacheValid(entry: RegistryCacheEntry): boolean {
  const nowIds = new Set(REGISTERED_SOURCES.map((s) => s.id));
  const cachedIds = new Set(entry.knownProviderIds);

  // 1. Source set changed (provider added or removed)
  if (
    nowIds.size !== cachedIds.size ||
    [...nowIds].some((id) => !cachedIds.has(id))
  ) {
    return false;
  }

  // 2. Check each provider for metadata or health status changes
  for (const source of REGISTERED_SOURCES) {
    const cachedStatus = entry.knownStatuses.get(source.id);
    if (!cachedStatus) return false;

    const cachedMeta = entry.knownMetadata.get(source.id);
    if (!cachedMeta) return false;

    // Metadata changed
    if (
      cachedMeta.name !== source.name ||
      cachedMeta.source !== source.source
    ) {
      return false;
    }

    // Health status or failure reason changed (checked via the live snapshot)
    // We need the current reliability scores to compare; this is checked
    // by looking at the latest data from the engine.
  }

  return true;
}

/**
 * Read-only health registry for every registered yield data source.
 *
 * Results are cached with bounded invalidation: the cache is regenerated when
 * registered sources change, when source metadata changes, or when any source's
 * health status or failure reason differs from the cached snapshot.
 *
 * The returned registry includes `cacheAge`, `cacheVersion`, and
 * `lastInvalidatedAt` diagnostic fields.
 */
export async function getSourceHealthRegistry(): Promise<SourceHealthRegistry> {
  const conflictResult = detectRegistryConflicts(REGISTERED_SOURCES);
  const cached = registryCache.get<RegistryCacheEntry>(CACHE_KEY);

  if (conflictResult.status === "conflicted") {
    registryCache.del(CACHE_KEY);
  }

  if (
    conflictResult.status === "valid" &&
    cached &&
    isRegistryCacheValid(cached)
  ) {
    // Check health changes: we still need to compare statuses from the engine
    const reliabilityScores =
      await yieldReliabilityEngine.getReliabilityScores(REGISTERED_SOURCES);

    let healthChanged = false;
    for (const r of reliabilityScores) {
      const { status, failureReason } = toSourceHealth(r, cached.generatedAt);
      const known = cached.knownStatuses.get(r.providerId);
      if (
        !known ||
        known.status !== status ||
        known.failureReason !== failureReason
      ) {
        healthChanged = true;
        break;
      }
    }

    if (healthChanged) {
      // Invalidate and rebuild
      registryCache.del(CACHE_KEY);
    } else {
      // Cache is still valid — return the cached registry with updated age
      const ageSeconds = Math.round((Date.now() - cached.generatedAt) / 1000);
      return {
        ...cached.registry,
        cacheAge: ageSeconds,
        cacheVersion: cached.version,
        lastInvalidatedAt,
      };
    }
  }

  if (conflictResult.status === "conflicted") {
    const now = Date.now();
    cacheVersionCounter += 1;
    lastInvalidatedAt = new Date().toISOString();
    const registry: SourceHealthRegistry = {
      generatedAt: new Date(now).toISOString(),
      conflictStatus: conflictResult.status,
      conflicts: conflictResult.conflicts,
      totalSources: 0,
      counts: summarizeSourceHealth([]),
      sources: [],
      cacheAge: 0,
      cacheVersion: cacheVersionCounter,
      lastInvalidatedAt,
    };
    return registry;
  }

  // Build fresh registry
  const reliabilityScores =
    await yieldReliabilityEngine.getReliabilityScores(REGISTERED_SOURCES);

  const now = Date.now();
  const sources = reliabilityScores
    .map((reliability) => toSourceHealth(reliability, now))
    .sort((a, b) => a.reliabilityScore - b.reliabilityScore);

  cacheVersionCounter += 1;
  lastInvalidatedAt = new Date().toISOString();

  const knownStatuses = new Map<
    string,
    { status: SourceHealthStatus; failureReason: string | null }
  >();
  const knownMetadata = new Map<string, { name: string; source: string }>();

  for (const source of sources) {
    knownStatuses.set(source.providerId, {
      status: source.status,
      failureReason: source.failureReason,
    });
    knownMetadata.set(source.providerId, {
      name: source.providerName,
      source: source.dataSource,
    });
  }

  const registry: SourceHealthRegistry = {
    generatedAt: new Date(now).toISOString(),
    conflictStatus: conflictResult.status,
    conflicts: conflictResult.conflicts,
    totalSources: sources.length,
    counts: summarizeSourceHealth(sources),
    sources,
    cacheAge: 0,
    cacheVersion: cacheVersionCounter,
    lastInvalidatedAt,
  };

  const entry: RegistryCacheEntry = {
    registry,
    version: cacheVersionCounter,
    generatedAt: now,
    knownProviderIds: REGISTERED_SOURCES.map((s) => s.id),
    knownStatuses,
    knownMetadata,
  };

  registryCache.set(CACHE_KEY, entry);

  return registry;
}
