/**
 * Asset Identity Normalization Service
 *
 * Prevents duplicate holdings when the same asset appears under different
 * symbols, issuers, or display aliases by resolving every raw asset
 * descriptor to a single canonical key.
 *
 * Design decisions
 * ─────────────────
 * • A canonical key is the form `<SYMBOL>:<ISSUER>` (upper-cased).
 *   For native XLM there is no issuer, so the key is just `XLM`.
 * • Symbol aliases (e.g. "USDC" / "USD Coin" / "usdc") are mapped to
 *   a single symbol via SYMBOL_ALIASES.
 * • Issuer aliases (e.g. multiple known issuers for the same token, or
 *   a test-net address mapped to the main-net address) are collapsed via
 *   ISSUER_ALIASES.
 * • Unknown assets are returned with `isKnown: false` — they remain
 *   visible without any unsafe merging.
 */

// ── Symbol alias table ────────────────────────────────────────────────────

/**
 * Maps every known variant of a symbol to its canonical upper-case form.
 *
 * Keys are lower-cased for case-insensitive look-up.
 */
const SYMBOL_ALIASES: Record<string, string> = {
  // USDC
  usdc: "USDC",
  "usd coin": "USDC",
  "usd-coin": "USDC",
  "circle usdc": "USDC",

  // XLM / Lumens
  xlm: "XLM",
  lumen: "XLM",
  lumens: "XLM",
  stellar: "XLM",
  "stellar lumens": "XLM",
  "native xlm": "XLM",

  // yXLM (liquid-staking wrapped XLM)
  yxlm: "yXLM",
  "yield xlm": "yXLM",

  // XLM-USDC LP token
  "xlm-usdc": "XLM-USDC",
  xlmusdc: "XLM-USDC",
  "usdc-xlm": "XLM-USDC",
  "soroswap xlm/usdc": "XLM-USDC",

  // BTC (wrapped)
  wbtc: "BTC",
  btc: "BTC",
  bitcoin: "BTC",

  // ETH (wrapped)
  weth: "ETH",
  eth: "ETH",
  ethereum: "ETH",
};

// ── Issuer alias table ────────────────────────────────────────────────────

/**
 * Maps known issuer variants → canonical issuer address.
 *
 * Useful for collapsing test-net / main-net address pairs or situations
 * where the same token is issued by two addresses that should be treated
 * as equivalent (e.g. bridged vs native).
 */
const ISSUER_ALIASES: Record<string, string> = {
  // Circle USDC on Stellar (main-net)
  CENTRE_USDC_ISSUER:
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",

  // Example: test-net Circle USDC issuer → treated as the same canonical issuer
  GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5:
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

// ── Types ─────────────────────────────────────────────────────────────────

export interface RawAssetDescriptor {
  /** Symbol as received from wallet / indexer — may be an alias */
  symbol: string;
  /**
   * Issuer Stellar account address.
   * Omit (or leave undefined) for native XLM.
   */
  issuer?: string;
  /** Optional human-readable display name */
  displayName?: string;
}

export interface CanonicalAsset {
  /** Canonical symbol, e.g. "USDC", "XLM", "XLM-USDC" */
  canonicalSymbol: string;
  /**
   * Canonical issuer address, or undefined for native XLM.
   */
  canonicalIssuer: string | undefined;
  /**
   * Opaque identity key used as the deduplication map key.
   * Format: `<SYMBOL>` for native or `<SYMBOL>:<ISSUER>` for issued assets.
   */
  identityKey: string;
  /**
   * True when the symbol AND issuer are both in our known alias tables
   * (or are native XLM).  Unknown assets remain visible but are NOT
   * merged with any other holding.
   */
  isKnown: boolean;
  /**
   * The original raw descriptor that was resolved.
   */
  raw: RawAssetDescriptor;
}

// ── Core normalisation helpers ────────────────────────────────────────────

/**
 * Resolve the canonical symbol for a raw symbol string.
 * Returns the upper-cased original when not found in the alias table.
 */
export function resolveCanonicalSymbol(rawSymbol: string): {
  canonical: string;
  isKnown: boolean;
} {
  const key = rawSymbol.trim().toLowerCase();
  const canonical = SYMBOL_ALIASES[key];
  if (canonical !== undefined) {
    return { canonical, isKnown: true };
  }
  // Not in alias table — return upper-cased original, mark as unknown
  return { canonical: rawSymbol.trim().toUpperCase(), isKnown: false };
}

/**
 * Resolve the canonical issuer for a raw issuer address.
 * Returns the original (upper-cased) address when not in the alias table.
 */
export function resolveCanonicalIssuer(rawIssuer: string): {
  canonical: string;
  isKnown: boolean;
} {
  const upper = rawIssuer.trim().toUpperCase();
  const canonical = ISSUER_ALIASES[upper] ?? ISSUER_ALIASES[rawIssuer.trim()];
  if (canonical !== undefined) {
    return { canonical, isKnown: true };
  }
  return { canonical: upper, isKnown: false };
}

/**
 * Derive the opaque identity key from a canonical symbol and optional issuer.
 */
export function buildIdentityKey(
  canonicalSymbol: string,
  canonicalIssuer: string | undefined,
): string {
  if (!canonicalIssuer) return canonicalSymbol;
  return `${canonicalSymbol}:${canonicalIssuer}`;
}

// ── Primary public API ────────────────────────────────────────────────────

/**
 * Resolve a raw asset descriptor to its canonical form.
 *
 * This is the single entry point that all holdings normalisation should
 * go through — it produces a stable `identityKey` suitable for use as a
 * Map key when merging duplicate rows.
 */
export function resolveAssetIdentity(raw: RawAssetDescriptor): CanonicalAsset {
  const { canonical: canonicalSymbol, isKnown: symbolKnown } =
    resolveCanonicalSymbol(raw.symbol);

  // Native XLM: no issuer
  if (canonicalSymbol === "XLM" && !raw.issuer) {
    return {
      canonicalSymbol,
      canonicalIssuer: undefined,
      identityKey: "XLM",
      isKnown: true,
      raw,
    };
  }

  let canonicalIssuer: string | undefined;
  let issuerKnown = false; // no issuer supplied — issuer knowledge is irrelevant

  if (raw.issuer) {
    const resolved = resolveCanonicalIssuer(raw.issuer);
    canonicalIssuer = resolved.canonical;
    issuerKnown = resolved.isKnown;
  }

  return {
    canonicalSymbol,
    canonicalIssuer,
    identityKey: buildIdentityKey(canonicalSymbol, canonicalIssuer),
    // An asset is "known" when its symbol is recognised OR when a supplied issuer
    // is in our alias table.  Assets with unrecognised symbols AND no recognised
    // issuer are treated as unknown and must not be merged with anything else.
    isKnown: symbolKnown || (raw.issuer !== undefined && issuerKnown),
    raw,
  };
}

// ── Holding merge helpers ─────────────────────────────────────────────────

export interface RawHolding {
  /** Raw asset descriptor */
  asset: RawAssetDescriptor;
  /** Balance amount in the asset's own units */
  amount: number;
  /** Optional source label (wallet / indexer / protocol name) */
  source?: string;
  /** Any additional metadata to preserve after merging */
  metadata?: Record<string, unknown>;
}

export interface MergedHolding {
  identityKey: string;
  canonicalSymbol: string;
  canonicalIssuer: string | undefined;
  /** Combined total amount across all merged sources */
  totalAmount: number;
  /** Each individual contribution preserved */
  contributions: Array<{
    source: string | undefined;
    amount: number;
    rawSymbol: string;
    rawIssuer: string | undefined;
    metadata?: Record<string, unknown>;
  }>;
  isKnown: boolean;
}

/**
 * Merge an array of raw holdings, collapsing duplicates that resolve to
 * the same canonical identity key.
 *
 * Rules:
 *  1. Known assets with the same identity key are merged into one row.
 *  2. Unknown assets are kept as-is (one row per input) to avoid
 *     accidentally collapsing unrelated tokens.
 *  3. The `contributions` array on each merged row preserves every
 *     source's individual amount for audit / display purposes.
 */
export function mergeHoldings(rawHoldings: RawHolding[]): MergedHolding[] {
  const mergedMap = new Map<string, MergedHolding>();
  // Give each unknown asset a unique synthetic key so it is never merged
  let unknownIndex = 0;

  for (const holding of rawHoldings) {
    const canonical = resolveAssetIdentity(holding.asset);

    // Unknown assets get a unique key so they are never accidentally merged
    const key = canonical.isKnown
      ? canonical.identityKey
      : `__unknown_${unknownIndex++}_${canonical.identityKey}`;

    const contribution = {
      source: holding.source,
      amount: holding.amount,
      rawSymbol: holding.asset.symbol,
      rawIssuer: holding.asset.issuer,
      metadata: holding.metadata,
    };

    const existing = mergedMap.get(key);
    if (existing) {
      existing.totalAmount += holding.amount;
      existing.contributions.push(contribution);
    } else {
      mergedMap.set(key, {
        identityKey: canonical.identityKey,
        canonicalSymbol: canonical.canonicalSymbol,
        canonicalIssuer: canonical.canonicalIssuer,
        totalAmount: holding.amount,
        contributions: [contribution],
        isKnown: canonical.isKnown,
      });
    }
  }

  return Array.from(mergedMap.values());
}
