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
import {
  validateYieldSourceOnboarding,
  YieldSourceOnboardingError,
  type OnboardingChecklistIssue,
  type YieldSourceOnboardingMetadata,
} from "./yieldSourceOnboardingService";

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
  /** Required onboarding metadata (#1156); entries without it are excluded. */
  onboarding?: YieldSourceOnboardingMetadata;
}

/** One registry entry that failed the onboarding checklist (#1156). */
export interface IncompleteYieldSource {
  id: string;
  name: string;
  missingFields: string[];
  issues: OnboardingChecklistIssue[];
  message: string;
}

/** Onboarding checklist summary embedded in the registry payload (#1156). */
export interface SourceOnboardingSummary {
  status: "valid" | "incomplete";
  /** Entries excluded from `sources` because their checklist failed. */
  incompleteSources: IncompleteYieldSource[];
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
  /** Onboarding checklist status (#1156): incomplete entries are excluded from `sources`. */
  onboarding: SourceOnboardingSummary;
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
  {
    id: "blend_api",
    name: "Blend Protocol",
    source: "api",
    onboarding: {
      protocol: "Blend",
      asset: "USDC",
      fee: { managementBps: 0, performanceBps: 1000 },
      risk: { level: "Medium" },
      freshness: { maxAgeSeconds: 1800 },
    },
  },
  {
    id: "soroswap_api",
    name: "Soroswap",
    source: "api",
    onboarding: {
      protocol: "Soroswap",
      asset: "XLM-USDC",
      fee: { managementBps: 30, performanceBps: 0 },
      risk: { level: "Medium" },
      freshness: { maxAgeSeconds: 1800 },
    },
  },
  {
    id: "defindex_api",
    name: "DeFindex",
    source: "api",
    onboarding: {
      protocol: "DeFindex",
      asset: "USDC",
      fee: { managementBps: 0, performanceBps: 500 },
      risk: { level: "Medium" },
      freshness: { maxAgeSeconds: 1800 },
    },
  },
  {
    id: "stellar_expert",
    name: "Stellar Expert",
    source: "oracle",
    onboarding: {
      protocol: "Stellar Expert",
      asset: "USDC",
      fee: { managementBps: 0, performanceBps: 0 },
      risk: { level: "Low" },
      freshness: { maxAgeSeconds: 3600 },
    },
  },
  {
    id: "coingecko",
    name: "CoinGecko",
    source: "oracle",
    onboarding: {
      protocol: "CoinGecko",
      asset: "USDC",
      fee: { managementBps: 0, performanceBps: 0 },
      risk: { level: "Low" },
      freshness: { maxAgeSeconds: 3600 },
    },
  },
];

/**
 * Sources promoted at runtime through `promoteYieldSource` (#1156).
 * Kept separate from the static registry so promotion can be validated,
 * audited, and rolled back (`unregisterYieldSource`) without code changes.
 */
const promotedYieldSources: YieldSourceRegistryEntry[] = [];

/** Every known source: the static registry plus runtime promotions. */
export function listYieldSources(): YieldSourceRegistryEntry[] {
  return [...REGISTERED_SOURCES, ...promotedYieldSources];
}

/**
 * Split sources into checklist-eligible entries (visible on production routes)
 * and incomplete entries (excluded, with actionable reasons).
 */
export function partitionYieldSources(entries: YieldSourceRegistryEntry[]): {
  eligible: YieldSourceRegistryEntry[];
  incomplete: IncompleteYieldSource[];
} {
  const eligible: YieldSourceRegistryEntry[] = [];
  const incomplete: IncompleteYieldSource[] = [];

  for (const entry of entries) {
    const result = validateYieldSourceOnboarding(entry);
    if (result.valid) {
      eligible.push(entry);
    } else {
      incomplete.push({
        id: typeof entry.id === "string" ? entry.id : "unknown",
        name: typeof entry.name === "string" ? entry.name : "unknown",
        missingFields: result.missingFields,
        issues: result.issues,
        message: result.message,
      });
    }
  }

  return { eligible, incomplete };
}

/**
 * Promote a yield source so it becomes visible on production routes (#1156).
 *
 * Throws {@link YieldSourceOnboardingError} when the onboarding checklist
 * fails or the id is already registered — incomplete entries are never added.
 */
export function promoteYieldSource(
  entry: YieldSourceRegistryEntry,
): YieldSourceRegistryEntry {
  const result = validateYieldSourceOnboarding(entry);
  if (!result.valid) {
    throw new YieldSourceOnboardingError(result.message, {
      code: "ONBOARDING_CHECKLIST_FAILED",
      statusCode: 400,
      missingFields: result.missingFields,
      issues: result.issues,
    });
  }

  if (listYieldSources().some((source) => source.id === entry.id)) {
    throw new YieldSourceOnboardingError(
      `Yield source "${entry.id}" is already registered.`,
      { code: "YIELD_SOURCE_ALREADY_REGISTERED", statusCode: 409 },
    );
  }

  promotedYieldSources.push(entry);
  registryCache.del(CACHE_KEY);
  return entry;
}

/**
 * Remove a runtime-promoted source (the static `REGISTERED_SOURCES` entries
 * cannot be unregistered this way). Returns false when the id is unknown.
 */
export function unregisterYieldSource(id: string): boolean {
  const index = promotedYieldSources.findIndex((source) => source.id === id);
  if (index === -1) return false;
  promotedYieldSources.splice(index, 1);
  registryCache.del(CACHE_KEY);
  return true;
}

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
  /** Snapshot of eligible provider IDs at generation time, used to detect changes. */
  knownProviderIds: string[];
  /** Fingerprint of the incomplete-source set, used to detect checklist changes. */
  knownIncomplete: string;
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
 * Fingerprint of the incomplete-source set so checklist changes (an entry
 * losing required metadata) invalidate the cache even when the eligible id
 * set happens to stay the same.
 */
function incompleteFingerprint(incomplete: IncompleteYieldSource[]): string {
  return incomplete
    .map((entry) => `${entry.id}:${[...entry.missingFields].sort().join("|")}`)
    .sort()
    .join(";");
}

/**
 * Check whether the cached registry is still valid by comparing the current
 * eligible sources, their health status, and the incomplete-source fingerprint
 * against the snapshot stored in the cache entry. Returns `true` if the cache
 * is still fresh.
 */
function isRegistryCacheValid(entry: RegistryCacheEntry): boolean {
  const { eligible, incomplete } = partitionYieldSources(listYieldSources());
  const nowIds = new Set(eligible.map((s) => s.id));
  const cachedIds = new Set(entry.knownProviderIds);

  // 1. Eligible source set changed (provider added, removed, or checklist flipped)
  if (
    nowIds.size !== cachedIds.size ||
    [...nowIds].some((id) => !cachedIds.has(id))
  ) {
    return false;
  }

  // 2. Incomplete-source set or its reasons changed (#1156)
  if (incompleteFingerprint(incomplete) !== entry.knownIncomplete) {
    return false;
  }

  // 3. Check each eligible provider for metadata changes
  for (const source of eligible) {
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
  const allSources = listYieldSources();
  const { eligible, incomplete } = partitionYieldSources(allSources);
  const conflictResult = detectRegistryConflicts(allSources);
  const onboarding: SourceOnboardingSummary = {
    status: incomplete.length > 0 ? "incomplete" : "valid",
    incompleteSources: incomplete,
  };
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
      await yieldReliabilityEngine.getReliabilityScores(eligible);

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
        onboarding,
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
      onboarding,
    };
    return registry;
  }

  // Build fresh registry from checklist-eligible sources only (#1156):
  // incomplete entries never reach production routes.
  const reliabilityScores =
    await yieldReliabilityEngine.getReliabilityScores(eligible);

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
    onboarding,
  };

  const entry: RegistryCacheEntry = {
    registry,
    version: cacheVersionCounter,
    generatedAt: now,
    knownProviderIds: eligible.map((s) => s.id),
    knownIncomplete: incompleteFingerprint(incomplete),
    knownStatuses,
    knownMetadata,
  };

  registryCache.set(CACHE_KEY, entry);

  return registry;
}
