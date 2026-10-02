import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { apiUrl } from "../lib/api";
import {
  getSharePriceFreshnessDisplay,
  type SharePriceFreshness,
} from "../lib/sharePriceFreshness";

interface SharePriceFreshnessBannerProps {
  vaultId: string;
}

/**
 * SharePriceFreshnessBanner — warns when a vault's share price trails the
 * latest indexed event beyond the delay threshold (#1155).
 *
 * Renders nothing while data is current, still loading, or unavailable —
 * without a response we cannot confirm a delay, so the banner stays quiet.
 */
export default function SharePriceFreshnessBanner({
  vaultId,
}: SharePriceFreshnessBannerProps) {
  const [freshness, setFreshness] = useState<SharePriceFreshness | null>(null);

  const fetchFreshness = useCallback(async () => {
    try {
      const response = await fetch(
        apiUrl(`/api/vaults/${encodeURIComponent(vaultId)}/share-price-freshness`),
      );
      if (!response.ok) return;
      const body = (await response.json()) as SharePriceFreshness;
      setFreshness(body);
    } catch {
      // Quiet on failure: without a response we cannot confirm a delay.
      setFreshness(null);
    }
  }, [vaultId]);

  useEffect(() => {
    setFreshness(null);
    void fetchFreshness();
  }, [fetchFreshness]);

  const display = getSharePriceFreshnessDisplay(freshness);
  if (!display) return null;

  const tone =
    display.variant === "danger"
      ? "bg-red-500/10 border-red-500/30 text-red-400"
      : "bg-yellow-500/10 border-yellow-500/30 text-yellow-400";

  return (
    <div
      role="status"
      data-testid="share-price-freshness-banner"
      className={`flex items-start gap-3 p-4 border rounded-lg ${tone}`}
    >
      <AlertTriangle
        className="shrink-0 mt-0.5"
        size={18}
        aria-hidden="true"
      />
      <div className="text-sm">
        <span className="font-semibold">{display.label}</span>
        {display.message && (
          <p className="mt-0.5 opacity-90">{display.message}</p>
        )}
        {display.lastUpdatedAt && (
          <p className="mt-1 flex items-center gap-1 text-xs opacity-70">
            <Clock size={12} aria-hidden="true" />
            Last known update: {display.lastUpdatedAt}
          </p>
        )}
      </div>
    </div>
  );
}
