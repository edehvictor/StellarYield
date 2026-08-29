/**
 * vaultData.ts
 *
 * Fetches live APY and TVL for a given vault slug from the yields API.
 */

import { apiUrl } from "./api";

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
  /** Vault risk level label (Low | Medium | High) from the yields API. */
  risk: string;
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

export interface VaultValidationResult {
  valid: boolean;
  normalized: string;
}

/**
 * Validates and normalizes a vault slug.
 *
 * @param slug - The raw slug string to validate
 * @returns Object indicating if valid and the normalized slug
 */
export function validateVaultSlug(slug: string | undefined): VaultValidationResult {
  if (!slug) {
    return { valid: false, normalized: "" };
  }

  const normalized = slug.trim().toLowerCase();
  const valid = normalized in VAULT_REGISTRY;

  return { valid, normalized };
}

/**
 * Fetches vault stats for the given slug.
 *
 * @param slug   - Vault identifier (e.g. "usdc", "xlm-usdc")
 */
export async function fetchVaultStats(
  slug: string,
): Promise<VaultStats | null> {
  const { valid, normalized } = validateVaultSlug(slug);
  if (!valid) return null;

  const meta = VAULT_REGISTRY[normalized];

  try {
    const res = await fetch(apiUrl("/api/yields"));

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
      risk: entry?.risk ?? "Unknown",
      live: !!entry,
    };
  } catch (error) {
    console.error("Error fetching vault stats:", error);
    // Graceful degradation: return meta with zeroed stats, marked as not live
    return { ...meta, apy: 0, tvl: 0, risk: "Unknown", live: false };
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

// ── Vault metadata normalization (issue #1042) ───────────────────────────
//
// Vault icon/symbol/issuer/decimals metadata may come from partially-trusted
// sources (asset registries, third-party metadata APIs) and can be missing
// or malformed. `normalizeVaultMetadata` is the single place that turns
// whatever we're given into a metadata shape UI components can render
// without special-casing — every field always has a safe value, and callers
// can see exactly which fields fell back via `fallback`.

export interface VaultIconMetadata {
  iconUrl?: string;
  symbol?: string;
  issuer?: string;
  decimals?: number;
}

export interface VaultMetadataFallbackFlags {
  icon: boolean;
  symbol: boolean;
  issuer: boolean;
  decimals: boolean;
}

export interface NormalizedVaultMetadata {
  /** `null` when no valid icon URL is available — render a generated fallback instead. */
  iconUrl: string | null;
  symbol: string;
  issuer: string;
  decimals: number;
  /** Which fields were missing/invalid and replaced with a safe default. */
  fallback: VaultMetadataFallbackFlags;
  /** True if any field fell back to a default. */
  hasFallback: boolean;
}

export const DEFAULT_VAULT_SYMBOL = "?";
export const DEFAULT_VAULT_ISSUER = "Unknown issuer";
export const DEFAULT_VAULT_DECIMALS = 7;
const MAX_VAULT_DECIMALS = 18;
/** Symbols follow Stellar asset code conventions: 1-12 alphanumerics/dots. */
const VALID_SYMBOL_RE = /^[A-Za-z0-9.]{1,12}$/;

function isValidIconUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidSymbol(value: unknown): value is string {
  return typeof value === "string" && VALID_SYMBOL_RE.test(value.trim());
}

function isValidIssuer(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDecimals(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_VAULT_DECIMALS
  );
}

/**
 * Normalize possibly-missing or malformed vault icon metadata into a shape
 * safe to render directly. Never throws — every field always resolves to a
 * usable value, with `fallback` recording which ones were defaulted.
 */
export function normalizeVaultMetadata(
  raw: VaultIconMetadata | null | undefined,
): NormalizedVaultMetadata {
  const iconValid = isValidIconUrl(raw?.iconUrl);
  const symbolValid = isValidSymbol(raw?.symbol);
  const issuerValid = isValidIssuer(raw?.issuer);
  const decimalsValid = isValidDecimals(raw?.decimals);

  const fallback: VaultMetadataFallbackFlags = {
    icon: !iconValid,
    symbol: !symbolValid,
    issuer: !issuerValid,
    decimals: !decimalsValid,
  };

  return {
    iconUrl: iconValid ? (raw!.iconUrl as string).trim() : null,
    symbol: symbolValid ? (raw!.symbol as string).trim().toUpperCase() : DEFAULT_VAULT_SYMBOL,
    issuer: issuerValid ? (raw!.issuer as string).trim() : DEFAULT_VAULT_ISSUER,
    decimals: decimalsValid ? (raw!.decimals as number) : DEFAULT_VAULT_DECIMALS,
    fallback,
    hasFallback: fallback.icon || fallback.symbol || fallback.issuer || fallback.decimals,
  };
}
