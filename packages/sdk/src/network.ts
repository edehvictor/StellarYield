import { UnsupportedNetworkError } from "./errors";

/**
 * Centralized network id validation (#1109).
 *
 * Several client flows (wallet connection, chart data fetching, deposit/
 * withdraw simulation) previously assumed whatever network id they were
 * given was valid and only discovered otherwise deep in a request or,
 * worse, at signing time. This module gives every flow a single place to
 * validate a network id up front and a single typed error shape
 * ({@link UnsupportedNetworkError}) to catch, so "unsupported network"
 * fails clearly and consistently before the user is ever asked to sign
 * anything.
 *
 * `NetworkName` is intentionally re-declared here (matching
 * `contractRegistry.ts`'s `testnet | mainnet | local`) rather than imported
 * from it, so this module has no dependency on the registry loader and
 * `contractRegistry.ts` can depend on this module instead, without a
 * circular import. The two types are kept in sync by convention (both are
 * simple literal unions covering the three networks the contract registry,
 * and its `contracts/registry.json` data file, know how to resolve
 * addresses for) and by the shared `SUPPORTED_NETWORKS` export other
 * modules should prefer over redeclaring the list themselves.
 */
export type NetworkName = "testnet" | "mainnet" | "local";

export const SUPPORTED_NETWORKS: readonly NetworkName[] = ["testnet", "mainnet", "local"];

/** True if `network` is one of {@link SUPPORTED_NETWORKS} (case-sensitive; ids are always lowercase). */
export function isSupportedNetwork(network: string): network is NetworkName {
  return (SUPPORTED_NETWORKS as readonly string[]).includes(network);
}

/**
 * Validates a network id, returning it narrowed to {@link NetworkName} on
 * success. Throws {@link UnsupportedNetworkError} for anything outside
 * {@link SUPPORTED_NETWORKS} — including `""`, `undefined`-turned-string,
 * and casing variants (network ids are treated as exact, case-sensitive
 * matches; callers that derive an id from free text, e.g. a passphrase,
 * are responsible for mapping it onto one of the canonical ids before
 * calling this).
 */
export function validateNetworkName(network: string): NetworkName {
  if (!isSupportedNetwork(network)) {
    throw new UnsupportedNetworkError(network, SUPPORTED_NETWORKS);
  }
  return network;
}
