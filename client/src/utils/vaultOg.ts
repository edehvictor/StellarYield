/**
 * Path to the dynamic OG image endpoint for a vault (see `src/pages/api/og.tsx`).
 * Uses URLSearchParams so `vault` is encoded correctly in the query string.
 */
export function buildVaultOgImagePath(vault: string): string {
  return `/api/og?${new URLSearchParams({ vault }).toString()}`;
}
