/**
 * Route Quote Assumptions
 *
 * Structured explanation of the market/yield inputs behind a zap quote route:
 * which provider and asset the figure came from, where the APY was sourced,
 * what fee schedule applies, and how fresh the underlying data was.
 *
 * Deliberately separate from `QuoteAssumptions` (the fingerprinted
 * mathematical parameters): these fields are informational context for the
 * UI ("why this route, what could change") and are NOT part of the
 * fingerprint canonical payload, so they can evolve without invalidating
 * in-flight quotes.
 */

/** Provider whose data backs the route. */
export interface RouteProviderAssumption {
  /** Stable provider identifier (lowercased protocol name). */
  providerId: string;
  /** Display name. */
  providerName: string;
}

/** Asset the route's yield figure applies to. */
export interface RouteAssetAssumption {
  /** Asset symbol or pair label (e.g. "XLM-USDC"). */
  symbol: string;
}

/** Where the APY figure came from. */
export interface RouteApySourceAssumption {
  /** Source identifier from the yield feed (e.g. "api", "oracle"). */
  source: string;
  /** Consensus total APY in percent, when the feed provided one. */
  totalApy?: number;
  /** Net APY after protocol fee drag, when available. */
  netApy?: number;
}

/** Fee schedule assumed for the route, in basis points. */
export interface RouteFeeAssumption {
  /** Management fee in bps. */
  managementFeeBps?: number;
  /** Performance fee in bps. */
  performanceFeeBps?: number;
  /** Combined management + performance fee in bps. */
  protocolFeeBps?: number;
}

/** Freshness of the underlying yield data at quote time. */
export interface RouteFreshnessAssumption {
  /** ISO timestamp the yield feed was last fetched. */
  fetchedAt: string;
  /** Age of the data in seconds at quote time (>= 0). */
  ageSeconds: number;
  /** True when the data is older than the configured staleness window. */
  isStale: boolean;
}

/** One of the assumption groups that could not be resolved for this quote. */
export type UnavailableRouteAssumptionField =
  | "provider"
  | "asset"
  | "apySource"
  | "fee"
  | "freshness";

/**
 * Assumptions behind the yield route a quote was priced from. Each group is
 * present when known and null when unavailable (also listed in
 * `unavailableFields`).
 */
export interface ZapQuoteRouteAssumptions {
  /** Protocol identifier used to select the route. */
  protocol: string;
  /** Provider backing the route, or null when the feed had no match. */
  provider: RouteProviderAssumption | null;
  /** Asset the yield figure applies to, or null when the feed omitted it. */
  asset: RouteAssetAssumption | null;
  /** APY source and figures, or null when unavailable. */
  apySource: RouteApySourceAssumption | null;
  /** Fee schedule, or null when unavailable. */
  fee: RouteFeeAssumption | null;
  /** Freshness of the underlying data, or null when unavailable. */
  freshness: RouteFreshnessAssumption | null;
  /** Assumption groups that were unavailable when this quote was built. */
  unavailableFields: UnavailableRouteAssumptionField[];
  /** ISO timestamp when this assumption snapshot was generated. */
  generatedAt: string;
}
