const DEFAULT_APP_URL = "https://stellaryield.vercel.app";

export function buildReferralLink(walletAddress: string, appUrl = DEFAULT_APP_URL): string {
  const base = appUrl.replace(/\/$/, "");
  return `${base}/?ref=${encodeURIComponent(walletAddress)}`;
}

export function parseReferralParam(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("ref");
  } catch {
    return null;
  }
}

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

export function isAttributionPreserved(original: string, shared: string): boolean {
  const originalRef = parseReferralParam(original);
  const sharedRef = parseReferralParam(shared);
  return originalRef !== null && originalRef === sharedRef;
}
