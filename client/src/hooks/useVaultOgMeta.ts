/**
 * useVaultOgMeta.ts
 *
 * Injects Open Graph and Twitter Card <meta> tags into the document <head>
 * for a given vault page.  Works with react-helmet-async (or any head manager
 * that reads from a shared HelmetProvider).
 *
 * The og:image URL points to the /api/og edge function which renders a
 * dynamic PNG for the vault.
 *
 * @example
 *   const meta = useVaultOgMeta("usdc");
 *   // meta.title, meta.description, meta.ogImageUrl, meta.tags
 */

/** Base URL for the OG image API.  Override via VITE_OG_API_BASE_URL. */
const OG_API_BASE =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_OG_API_BASE_URL) ||
  "";

export interface VaultOgMeta {
  /** Page <title> */
  title: string;
  /** og:description / twitter:description */
  description: string;
  /** Fully-qualified URL to the dynamic OG image */
  ogImageUrl: string;
  /** Flat list of { property, content } pairs ready for <Helmet> */
  tags: Array<{ property: string; content: string }>;
}

/**
 * Returns OG meta tag data for the given vault slug.
 *
 * This is a pure, synchronous function — no network calls.  The og:image
 * URL is constructed so the edge function fetches live data at render time.
 *
 * @param slug        - Vault identifier (e.g. "usdc", "xlm-usdc")
 * @param siteUrl     - Canonical site URL (defaults to window.location.origin)
 */
export function useVaultOgMeta(
  slug: string,
  siteUrl?: string,
): VaultOgMeta {
  const origin =
    siteUrl ??
    (typeof window !== "undefined" ? window.location.origin : "https://stellaryield.app");

  const vaultLabel = slug.toUpperCase();
  const title = `${vaultLabel} Yield Vault — Stellar Yield`;
  const description = `Earn auto-compounding yield on ${vaultLabel} via Soroban smart contracts. View live APY and TVL.`;

  const ogImageUrl = `${OG_API_BASE || origin}/api/og?vault=${encodeURIComponent(slug)}`;
  const pageUrl = `${origin}/vault/${encodeURIComponent(slug)}`;

  const tags: VaultOgMeta["tags"] = [
    // Open Graph
    { property: "og:type",        content: "website" },
    { property: "og:site_name",   content: "Stellar Yield" },
    { property: "og:title",       content: title },
    { property: "og:description", content: description },
    { property: "og:url",         content: pageUrl },
    { property: "og:image",       content: ogImageUrl },
    { property: "og:image:width",  content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:type",   content: "image/png" },
    { property: "og:image:alt",    content: `${vaultLabel} Yield Vault social card` },
    // Twitter Card
    { property: "twitter:card",        content: "summary_large_image" },
    { property: "twitter:title",       content: title },
    { property: "twitter:description", content: description },
    { property: "twitter:image",       content: ogImageUrl },
  ];

  return { title, description, ogImageUrl, tags };
}
