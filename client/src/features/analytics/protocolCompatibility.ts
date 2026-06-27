/**
 * Protocol compatibility matrix for the Source Health panel.
 *
 * Each yield data source reports health via a (protocol, dataSource) pair.
 * This module classifies that pair into one of four compatibility tiers and
 * surfaces a human-readable degradation reason when the combination is not
 * fully supported.
 */

export type ProtocolId =
  | "soroban"
  | "horizon"
  | "stellar-anchor"
  | "aqua"
  | "phoenix"
  | "blend";

export type DataSourceId =
  | "rest-api"
  | "graphql"
  | "websocket"
  | "rpc"
  | "ipfs";

export type CompatibilityTier =
  | "supported"      // protocol + dataSource work together without caveats
  | "partial"        // works but with known limitations (e.g. no streaming)
  | "incompatible"   // combination is explicitly not supported
  | "unknown";       // no matrix entry — treat as unverified

export interface CompatibilityResult {
  tier: CompatibilityTier;
  /** Human-readable message explaining any degradation or limitation. */
  message: string;
}

/**
 * Sparse compatibility matrix.
 * Key format: `${protocolId}::${dataSourceId}`
 * Absence means "unknown".
 */
const MATRIX: Record<string, CompatibilityResult> = {
  // Soroban (smart contracts via RPC)
  "soroban::rpc":        { tier: "supported",     message: "Soroban RPC is the canonical data source." },
  "soroban::rest-api":   { tier: "partial",        message: "REST API does not expose Soroban event streams; polling only." },
  "soroban::graphql":    { tier: "partial",        message: "GraphQL layer proxies RPC — adds latency overhead." },
  "soroban::websocket":  { tier: "incompatible",   message: "Soroban does not support WebSocket subscriptions." },
  "soroban::ipfs":       { tier: "incompatible",   message: "IPFS cannot serve live Soroban state." },

  // Horizon (classic Stellar API)
  "horizon::rest-api":   { tier: "supported",     message: "Horizon REST is the primary interface." },
  "horizon::websocket":  { tier: "supported",     message: "Horizon SSE streams are fully supported." },
  "horizon::rpc":        { tier: "incompatible",   message: "Horizon does not expose an RPC interface." },
  "horizon::graphql":    { tier: "partial",        message: "Third-party GraphQL wrappers only — not officially supported." },
  "horizon::ipfs":       { tier: "incompatible",   message: "IPFS cannot serve live Horizon ledger data." },

  // Stellar Anchor (SEP-6/24/31)
  "stellar-anchor::rest-api":  { tier: "supported",   message: "SEP-compliant REST is the standard interface." },
  "stellar-anchor::graphql":   { tier: "incompatible", message: "Anchor protocol does not define a GraphQL schema." },
  "stellar-anchor::websocket": { tier: "partial",      message: "Some anchors offer webhooks, but WebSocket is non-standard." },
  "stellar-anchor::rpc":       { tier: "incompatible", message: "Anchors do not expose RPC endpoints." },
  "stellar-anchor::ipfs":      { tier: "incompatible", message: "IPFS cannot serve Anchor SEP data." },

  // Aqua / AMM pools
  "aqua::rest-api":    { tier: "supported",     message: "Aqua pool data is served via REST." },
  "aqua::graphql":     { tier: "supported",     message: "Aqua subgraph supports full GraphQL queries." },
  "aqua::websocket":   { tier: "partial",       message: "WebSocket price feeds are rate-limited on free tier." },
  "aqua::rpc":         { tier: "incompatible",  message: "Aqua has no RPC interface." },
  "aqua::ipfs":        { tier: "incompatible",  message: "IPFS cannot serve live AMM pricing." },

  // Phoenix DEX
  "phoenix::rest-api":   { tier: "supported",   message: "Phoenix REST API provides full market data." },
  "phoenix::graphql":    { tier: "partial",      message: "Phoenix GraphQL is in beta — schema may change." },
  "phoenix::websocket":  { tier: "partial",      message: "WebSocket streaming is available but experimental." },
  "phoenix::rpc":        { tier: "incompatible", message: "Phoenix does not expose an RPC interface." },
  "phoenix::ipfs":       { tier: "incompatible", message: "IPFS cannot serve live Phoenix DEX data." },

  // Blend (lending protocol)
  "blend::rpc":        { tier: "supported",     message: "Blend exposes state via Soroban RPC." },
  "blend::rest-api":   { tier: "partial",       message: "REST API is read-only and does not cover all Blend events." },
  "blend::graphql":    { tier: "partial",       message: "Community-maintained subgraph; may lag behind chain." },
  "blend::websocket":  { tier: "incompatible",  message: "Blend does not support WebSocket subscriptions." },
  "blend::ipfs":       { tier: "incompatible",  message: "IPFS cannot serve live Blend lending state." },
};

const UNKNOWN_RESULT: CompatibilityResult = {
  tier: "unknown",
  message: "No compatibility data for this protocol/data-source combination.",
};

/**
 * Look up the compatibility tier and degradation message for a
 * (protocol, dataSource) pair.
 */
export function checkProtocolCompatibility(
  protocol: ProtocolId | string,
  dataSource: DataSourceId | string,
): CompatibilityResult {
  const key = `${protocol}::${dataSource}`;
  return MATRIX[key] ?? UNKNOWN_RESULT;
}

/** True when the combination is known to work without caveats. */
export function isFullySupported(protocol: string, dataSource: string): boolean {
  return checkProtocolCompatibility(protocol, dataSource).tier === "supported";
}

/** True when the combination is explicitly not supported. */
export function isIncompatible(protocol: string, dataSource: string): boolean {
  return checkProtocolCompatibility(protocol, dataSource).tier === "incompatible";
}

/**
 * Summarise a batch of (protocol, dataSource) pairs.
 * Returns counts by tier and the first degradation message per non-supported entry.
 */
export interface MatrixSummary {
  total: number;
  supported: number;
  partial: number;
  incompatible: number;
  unknown: number;
  degradationMessages: string[];
}

export function summariseMatrix(
  pairs: Array<{ protocol: string; dataSource: string }>,
): MatrixSummary {
  const summary: MatrixSummary = {
    total: pairs.length,
    supported: 0,
    partial: 0,
    incompatible: 0,
    unknown: 0,
    degradationMessages: [],
  };

  for (const { protocol, dataSource } of pairs) {
    const result = checkProtocolCompatibility(protocol, dataSource);
    summary[result.tier]++;
    if (result.tier !== "supported") {
      summary.degradationMessages.push(result.message);
    }
  }

  return summary;
}
