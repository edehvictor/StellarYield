/**
 * Client-side helper for the vault share price freshness endpoint (#1155).
 *
 * Mirrors `server/src/services/sharePriceFreshness.ts`. The display helper is
 * intentionally quiet when data is current: dashboards only render a banner
 * when the share price is delayed or missing.
 */

export type SharePriceFreshnessStatus = "current" | "delayed" | "missing";

export interface SharePriceFreshness {
  vaultId?: string;
  status: SharePriceFreshnessStatus;
  isDelayed: boolean;
  sharePriceUpdatedAt: string | null;
  eventCheckpointAt: string | null;
  delayMs: number | null;
  maxDelayMs: number;
  message: string | null;
  evaluatedAt: string;
}

export interface SharePriceFreshnessDisplay {
  variant: "warning" | "danger";
  label: string;
  message: string | null;
  /** Human-readable "last known update" timestamp (UTC), when available. */
  lastUpdatedAt: string | null;
}

/**
 * Format an ISO timestamp as `YYYY-MM-DD HH:MM:SS UTC`.
 * Returns null for missing or unparseable values.
 */
export function formatLastKnownUpdate(
  iso: string | null | undefined,
): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return `${new Date(parsed).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Map a freshness payload to banner display data.
 * Returns null when there is nothing to warn about (current data or no payload).
 */
export function getSharePriceFreshnessDisplay(
  freshness: SharePriceFreshness | null | undefined,
): SharePriceFreshnessDisplay | null {
  if (!freshness) return null;

  const lastUpdatedAt = formatLastKnownUpdate(freshness.sharePriceUpdatedAt);

  if (freshness.status === "current") {
    return null;
  }

  if (freshness.status === "delayed") {
    return {
      variant: "warning",
      label: "Share price delayed",
      message: freshness.message,
      lastUpdatedAt,
    };
  }

  return {
    variant: "danger",
    label: "Share price data unavailable",
    message: freshness.message,
    lastUpdatedAt,
  };
}
