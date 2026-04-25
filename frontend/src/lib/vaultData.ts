/**
 * vaultData.ts
 *
 * Fetches live APY and TVL for a given vault slug from the yields API.
 * Used by the /api/og edge function to populate dynamic OG images.
 */

/** Supported vault slugs mapped to their display names and asset symbols. */
export const VAULT_REGISTRY: Record<string, { name: string; asset: string; protocol: string }> = {
  usdc:       { name: "USDC Yield Vault",    asset: "USDC",       protocol: "Blend" },
  xlm:        { name: "XLM Yield Vault",     asset: "XLM",        protocol: "Blend" },
  "xlm-usdc": { name: "XLM-USDC LP Vault",  asset: "XLM-USDC",   protocol: "Soroswap" },
  "xlm-eth":  { name: "XLM-ETH LP Vault",   asset: "XLM-ETH",    protocol: "Soroswap" },
  index:      { name: "Yield Index Vault",   asset: "Yield Index", protocol: "DeFindex" },
  bluechip:   { name: "Blue Chip Vault",     asset: "Blue Chip",  protocol: "DeFindex" },
};

export interface VaultStats {
  name: string;
  asset: string;
  protocol: string;
  apy: number;
  tvl: number;
  /** Whether the data came from the live API (true) or fallback defaults (false). */
  live: boolean;
}

interface YieldsApiEntry {
  protocol: string;
  asset: string;
  apy: number;
  tvl: number;
  risk: string;
}

/**
 * Fetches vault stats for the given slug.
 *
 * Falls back to sensible defaults when the API is unreachable so the edge
 * function always returns a valid image rather than a 500.
 *
 * @param slug   - Vault identifier (e.g. "usdc", "xlm-usdc")
 * @param apiUrl - Base URL for the yields API (injectable for testing)
 */
export async function fetchVaultStats(
  slug: string,
  apiUrl = "http://localhost:3001",
): Promise<VaultStats | null> {
  const meta = VAULT_REGISTRY[slug.toLowerCase()];
  if (!meta) return null;

  try {
    const res = await fetch(`${apiUrl}/api/yields`, {
      // Edge functions must not cache stale data longer than the CDN TTL
      next: { revalidate: 60 },
    } as RequestInit);

    if (!res.ok) throw new Error(`yields API ${res.status}`);

    const data: YieldsApiEntry[] = await res.json();
    const entry = data.find(
      (d) =>
        d.protocol.toLowerCase() === meta.protocol.toLowerCase() &&
        d.asset.toLowerCase() === meta.asset.toLowerCase(),
    );

    return {
      ...meta,
      apy: entry?.apy ?? 0,
      tvl: entry?.tvl ?? 0,
      live: !!entry,
    };
  } catch {
    // Graceful degradation: return meta with zeroed stats
    return { ...meta, apy: 0, tvl: 0, live: false };
  }
}

/**
 * Formats a TVL number into a human-readable string (e.g. "$2.45M").
 *
 * @param value - Raw TVL in USD
 */
export function formatTvl(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString()}`;
}
