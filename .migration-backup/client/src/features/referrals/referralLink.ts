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
