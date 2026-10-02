import { AlertTriangle, Info, Loader2 } from "lucide-react";
import { formatStroopsToDecimal } from "../zap/amount";
import { formatPercentFromBps, type RedemptionView } from "./redemptionPreview";

export interface RedemptionPreviewPanelProps {
  /** `null` while there is nothing to preview (no amount, or totals not loaded). */
  view: RedemptionView | null;
  /** Vault totals are still being read. */
  loading: boolean;
  /** Vault totals could not be read. */
  totalsError: string | null;
  /** Decimals of the share and asset amounts. */
  decimals: number;
  symbol: string;
}

/**
 * What a partial withdrawal does to the user's position: shares burned, assets
 * received, and what is left. Shown before signing (#1404).
 */
export default function RedemptionPreviewPanel({
  view,
  loading,
  totalsError,
  decimals,
  symbol,
}: RedemptionPreviewPanelProps) {
  const fmt = (value: bigint) => formatStroopsToDecimal(value, decimals);

  if (loading) {
    return (
      <div aria-busy="true" className="flex items-center gap-2 py-2 text-sm text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin" />
        Reading vault share price…
      </div>
    );
  }

  if (totalsError) {
    return (
      <p role="status" className="text-xs text-amber-300">
        Share redemption preview unavailable: {totalsError}
      </p>
    );
  }

  if (!view) return null;

  if (!view.ok) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-300"
      >
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          {view.message}
          {view.maxShares !== undefined && (
            <> You can redeem at most {fmt(view.maxShares)} shares.</>
          )}
        </span>
      </div>
    );
  }

  const { preview, sharePrice } = view;
  const rows: Array<[string, string]> = [
    ["Shares to burn", `${fmt(preview.sharesToBurn)} (${formatPercentFromBps(preview.percentOfPositionBps)}% of position)`],
    ["You receive", `${fmt(preview.netAssets)} ${symbol}`],
    ["Share price", `${sharePrice} ${symbol}`],
    [
      "Remaining position",
      preview.isFullRedemption
        ? "None — full withdrawal"
        : `${fmt(preview.remainingShares)} shares (≈ ${fmt(preview.remainingAssets)} ${symbol})`,
    ],
  ];

  return (
    <div
      role="region"
      aria-label="Share redemption preview"
      className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-white">
        <Info className="w-4 h-4 text-indigo-300" />
        Redemption preview
        {preview.isFullRedemption && (
          <span className="ml-auto rounded-full bg-indigo-500/20 px-2 py-0.5 text-xs text-indigo-200">
            Full withdrawal
          </span>
        )}
      </div>
      <dl className="space-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 text-xs">
            <dt className="text-gray-400">{label}</dt>
            <dd className="text-right text-gray-100">{value}</dd>
          </div>
        ))}
      </dl>
      {preview.warnings.map((warning) => (
        <div
          key={warning.code}
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3 text-xs text-yellow-200/90"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 text-yellow-400 mt-0.5" />
          <span>
            {warning.message} {warning.remediation}
          </span>
        </div>
      ))}
    </div>
  );
}
