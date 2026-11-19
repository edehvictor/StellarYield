/**
 * Route Quote Assumptions Service
 *
 * Builds the structured, UI-facing explanation of the yield/market inputs
 * behind a zap quote route (`ZapQuoteRouteAssumptions`): the provider and
 * asset the APY figure came from, the fee schedule assumed, and how fresh the
 * underlying data was at quote time.
 *
 * All inputs are optional upstream data, so every group degrades gracefully:
 * a missing protocol entry, missing fee schedule, or missing/invalid
 * `fetchedAt` yields `null` for that group plus an entry in
 * `unavailableFields` — the quote itself is never blocked or rejected for
 * missing assumptions. This mirrors the degrade-gracefully convention used
 * elsewhere in the zap quote path (e.g. reserve checks, router simulation).
 *
 * Kept deliberately separate from the fingerprint machinery
 * (`quoteAssumptionFingerprint.ts`): these fields are informational context
 * for "why this route / what could change", not mathematical parameters, so
 * they are not part of the canonical fingerprint payload.
 */

import type { NormalizedYield } from "../types/yields";
import type {
  RouteApySourceAssumption,
  RouteFeeAssumption,
  RouteFreshnessAssumption,
  UnavailableRouteAssumptionField,
  ZapQuoteRouteAssumptions,
} from "../../../shared/types/routeAssumptions";

/**
 * Freshness window (seconds) beyond which the underlying yield data is
 * considered stale for route-assumption purposes. Matches the 30-minute
 * stale-age window used by the yield source health registry
 * (`yieldSourceRegistryService.SOURCE_HEALTH_THRESHOLDS.staleAgeSeconds`).
 */
export const ROUTE_ASSUMPTION_FRESHNESS_WINDOW_SECONDS = 30 * 60;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Builds the APY-source group from a normalized yield entry. */
function buildApySource(entry: NormalizedYield | undefined): RouteApySourceAssumption | null {
  if (!entry) return null;
  const source = nonEmptyString(entry.source);
  if (source === null) return null;

  const totalApy = isFiniteNumber(entry.totalApy) ? entry.totalApy : undefined;
  const netApy = isFiniteNumber(entry.netApy) ? entry.netApy : undefined;

  return {
    source,
    ...(totalApy !== undefined ? { totalApy } : {}),
    ...(netApy !== undefined ? { netApy } : {}),
  };
}

/** Builds the fee-schedule group from a normalized yield entry. */
function buildFee(entry: NormalizedYield | undefined): RouteFeeAssumption | null {
  if (!entry) return null;
  const managementFeeBps = isFiniteNumber(entry.managementFeeBps)
    ? entry.managementFeeBps
    : undefined;
  const performanceFeeBps = isFiniteNumber(entry.performanceFeeBps)
    ? entry.performanceFeeBps
    : undefined;

  // Nothing usable — report the whole group unavailable rather than a hollow
  // object that would render as "0 bps" in the UI.
  if (managementFeeBps === undefined && performanceFeeBps === undefined) {
    return null;
  }

  const protocolFeeBps =
    (managementFeeBps ?? 0) + (performanceFeeBps ?? 0);

  return {
    ...(managementFeeBps !== undefined ? { managementFeeBps } : {}),
    ...(performanceFeeBps !== undefined ? { performanceFeeBps } : {}),
    protocolFeeBps,
  };
}

/** Builds the freshness group, computing data age relative to `nowMs`. */
function buildFreshness(
  entry: NormalizedYield | undefined,
  nowMs: number,
): RouteFreshnessAssumption | null {
  const fetchedAt = nonEmptyString(entry?.fetchedAt);
  if (fetchedAt === null) return null;

  const fetchedMs = new Date(fetchedAt).getTime();
  if (!Number.isFinite(fetchedMs)) return null;

  const ageSeconds = Math.max(0, Math.round((nowMs - fetchedMs) / 1000));
  return {
    fetchedAt,
    ageSeconds,
    isStale: ageSeconds > ROUTE_ASSUMPTION_FRESHNESS_WINDOW_SECONDS,
  };
}

/**
 * Builds route assumptions for `protocol` from the normalized yield feed.
 *
 * - Complete data: every group populated, `unavailableFields` empty.
 * - Partial data: missing groups become null and are listed in
 *   `unavailableFields` (e.g. a feed entry with no fee schedule reports
 *   `fee` unavailable instead of inventing zero fees).
 * - No matching protocol: all groups null, all listed as unavailable —
 *   the quote still succeeds; the UI shows the assumptions as unknown.
 *
 * Pure and deterministic given `yieldData` and `nowMs` (both injectable for
 * tests). Never throws on malformed entries.
 */
export function buildZapQuoteRouteAssumptions(
  protocol: string,
  yieldData: NormalizedYield[] | undefined,
  nowMs: number = Date.now(),
): ZapQuoteRouteAssumptions {
  const unavailable: UnavailableRouteAssumptionField[] = [];

  const entry = Array.isArray(yieldData)
    ? yieldData.find(
        (y) =>
          y != null &&
          typeof y.protocolName === "string" &&
          y.protocolName.toLowerCase() === protocol.toLowerCase(),
      )
    : undefined;

  const provider = entry
    ? { providerId: entry.protocolName.toLowerCase(), providerName: entry.protocolName }
    : null;
  if (provider === null) unavailable.push("provider");

  const assetSymbol = nonEmptyString(entry?.asset);
  const asset = assetSymbol !== null ? { symbol: assetSymbol } : null;
  if (asset === null) unavailable.push("asset");

  const apySource = buildApySource(entry);
  if (apySource === null) unavailable.push("apySource");

  const fee = buildFee(entry);
  if (fee === null) unavailable.push("fee");

  const freshness = buildFreshness(entry, nowMs);
  if (freshness === null) unavailable.push("freshness");

  return {
    protocol,
    provider,
    asset,
    apySource,
    fee,
    freshness,
    unavailableFields: unavailable,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
