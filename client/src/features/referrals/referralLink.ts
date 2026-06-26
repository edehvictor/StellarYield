/**
 * Pure helpers for building referral links, isolated from the dashboard
 * component so the URL/fallback logic is unit-testable.
 */

export const DEFAULT_APP_URL = "https://stellaryield.vercel.app";

/**
 * Resolve the app base URL from configuration, falling back gracefully when
 * `VITE_APP_URL` is missing or blank. `isFallback` lets the UI surface that the
 * link uses a default rather than a configured domain.
 */
export function resolveAppBaseUrl(envUrl: string | undefined): {
  url: string;
  isFallback: boolean;
} {
  const trimmed = (envUrl ?? "").trim();
  if (trimmed) {
    return { url: trimmed.replace(/\/+$/, ""), isFallback: false };
  }
  return { url: DEFAULT_APP_URL, isFallback: true };
}

/** Build the shareable referral link, URL-encoding the wallet address. */
export function buildReferralLink(baseUrl: string, walletAddress: string): string {
  if (!walletAddress) return "";
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/?ref=${encodeURIComponent(walletAddress)}`;
}

/** Extract the `ref` attribution parameter from a referral URL. */
export function parseReferralParam(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("ref");
  } catch {
    return null;
  }
}

/**
 * Normalize a referral URL to its canonical form:
 * strips extra query params and hash fragments, preserving only the `ref` param.
 */
export function normalizeReferralLink(url: string): string {
  try {
    const parsed = new URL(url);
    const ref = parsed.searchParams.get("ref");
    if (!ref) return url;
    return `${parsed.origin}/?ref=${encodeURIComponent(ref)}`;
  } catch {
    return url;
  }
}

/**
 * Returns true when the `ref` attribution parameter is identical in both URLs,
 * confirming the referral attribution survives copy/share.
 */
export function isAttributionPreserved(original: string, shared: string): boolean {
  const originalRef = parseReferralParam(original);
  const sharedRef = parseReferralParam(shared);
  return originalRef !== null && originalRef === sharedRef;
}
