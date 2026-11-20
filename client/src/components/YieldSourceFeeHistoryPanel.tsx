/**
 * Yield Source Fee History Panel (#1147)
 *
 * Renders recent protocol fee changes (management + performance fee,
 * combined, in basis points) for a yield source's detail view, newest-first.
 * Presentational only — takes the already-fetched `feeHistory` array (from
 * `VaultStats.feeHistory`, sourced from `GET /api/yields`) rather than
 * fetching independently, since the parent vault detail view already loads
 * this data as part of its single `fetchVaultStats` call.
 *
 * Renders a clean empty state (no layout jump relative to the populated
 * state) both when history is genuinely empty and when it's unavailable
 * (`null`/`undefined`, e.g. an older cached response or a degraded server) —
 * both are visually identical to the user since neither is actionable.
 */
import { History } from "lucide-react";
import type { ProtocolFeeSnapshot } from "../lib/vaultData";

export interface YieldSourceFeeHistoryPanelProps {
  protocolName: string;
  feeHistory: ProtocolFeeSnapshot[] | null | undefined;
}

function formatFeeBps(feeBps: number): string {
  return `${(feeBps / 100).toFixed(2)}%`;
}

function formatChangedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function YieldSourceFeeHistoryPanel({
  protocolName,
  feeHistory,
}: YieldSourceFeeHistoryPanelProps) {
  const entries = Array.isArray(feeHistory) ? feeHistory : [];

  return (
    <div className="glass-panel p-6" data-testid="yield-source-fee-history">
      <div className="flex items-center gap-2 mb-4">
        <History className="w-4 h-4 text-gray-400" />
        <h3 className="text-sm font-bold uppercase tracking-widest text-gray-400">
          {protocolName} fee history
        </h3>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="fee-history-empty-state">
          No recent fee changes recorded for this protocol.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="fee-history-list">
          {entries.map((entry, i) => (
            <li
              key={`${entry.changedAt}-${i}`}
              className="flex items-center justify-between text-sm border-b border-white/5 pb-2 last:border-0 last:pb-0"
            >
              <span className="text-gray-400">{formatChangedAt(entry.changedAt)}</span>
              <span className="font-mono font-semibold text-white">{formatFeeBps(entry.feeBps)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
