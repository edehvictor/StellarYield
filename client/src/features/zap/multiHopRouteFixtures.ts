/**
 * Canonical multi-hop zap route fixtures used to regression-test deposit
 * impact estimation (see `useDepositImpact`). Each fixture models a
 * `QuoteSnapshot.route` — the ordered list of contract IDs a zap conversion
 * hops through, starting at the deposited asset and ending at the vault
 * token — at increasing route depths.
 *
 * These fixtures exist so that impact-warning regressions across route
 * depth (single-hop, one intermediate hop, and deep multi-hop paths) are
 * caught by tests rather than discovered against a live/simulated quote.
 */

/** A named, ordered list of contract IDs a zap quote routed through. */
export interface RouteFixture {
  /** Human-readable label for test output. */
  description: string;
  /** Ordered contract IDs: [inputAsset, ...intermediateHops, vaultToken]. */
  route: string[];
  /** Number of conversion hops (edges) implied by `route`. */
  hopCount: number;
}

/** Direct deposit: the deposited asset already matches the vault token. */
export const DIRECT_ROUTE: RouteFixture = {
  description: "direct deposit (0 hops, asset === vault token)",
  route: ["CVAULT"],
  hopCount: 0,
};

/** Single-hop swap: asset -> vault token, no intermediates. */
export const SINGLE_HOP_ROUTE: RouteFixture = {
  description: "single-hop swap (1 hop)",
  route: ["CXLM", "CVAULT"],
  hopCount: 1,
};

/** One intermediate hop: asset -> intermediate -> vault token. */
export const ONE_INTERMEDIATE_HOP_ROUTE: RouteFixture = {
  description: "one intermediate hop (2 hops)",
  route: ["CXLM", "CUSDC", "CVAULT"],
  hopCount: 2,
};

/**
 * More than one intermediate hop — the scenario this fixture set exists to
 * cover: "deposit impact estimation should stay accurate when zap routing
 * spans more than one intermediate hop".
 */
export const MULTI_HOP_ROUTE: RouteFixture = {
  description: "multi-hop route, two intermediates (3 hops)",
  route: ["CXLM", "CUSDC", "CAQUA", "CVAULT"],
  hopCount: 3,
};

/** Deep multi-hop route — exercises the critical route-depth threshold. */
export const DEEP_MULTI_HOP_ROUTE: RouteFixture = {
  description: "deep multi-hop route, four intermediates (5 hops)",
  route: ["CXLM", "CUSDC", "CAQUA", "CYBTC", "CSHX", "CVAULT"],
  hopCount: 5,
};

/**
 * An alternate 3-hop route to `MULTI_HOP_ROUTE`'s destination via a
 * different intermediate pool sequence, used to exercise "route re-priced
 * through a different path" scenarios where the nominal output amount is
 * unchanged but the underlying path is not.
 */
export const MULTI_HOP_ROUTE_ALTERNATE_PATH: RouteFixture = {
  description: "multi-hop route, alternate intermediates, same hop count (3 hops)",
  route: ["CXLM", "CAQUA", "CUSDC", "CVAULT"],
  hopCount: 3,
};

/** All route fixtures, ordered from shallowest to deepest. */
export const ALL_ROUTE_FIXTURES: RouteFixture[] = [
  DIRECT_ROUTE,
  SINGLE_HOP_ROUTE,
  ONE_INTERMEDIATE_HOP_ROUTE,
  MULTI_HOP_ROUTE,
  DEEP_MULTI_HOP_ROUTE,
];
