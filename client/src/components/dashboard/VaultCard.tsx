import VaultIcon from "../vault/VaultIcon";
import type { VaultIconMetadata } from "../../lib/vaultData";

export type VaultCardVariant = "list" | "detail" | "action";

export interface VaultCardProps {
  name: string;
  metadata?: VaultIconMetadata | null;
  apy?: number;
  tvl?: string;
  variant?: VaultCardVariant;
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * Vault summary card, reused across the list, detail, and action contexts
 * (issue #1042). All three variants render through the same `VaultIcon`, so
 * fallback visuals stay visually and behaviorally consistent everywhere a
 * vault icon appears, regardless of how incomplete the vault's metadata is.
 */
export default function VaultCard({
  name,
  metadata,
  apy,
  tvl,
  variant = "list",
  actionLabel = "Deposit",
  onAction,
}: VaultCardProps) {
  if (variant === "detail") {
    return (
      <div className="glass-card p-6 flex items-center gap-4" data-testid="vault-card-detail">
        <VaultIcon metadata={metadata} size={56} />
        <div>
          <h3 className="text-xl font-bold">{name}</h3>
          {typeof apy === "number" && (
            <p className="text-sm text-gray-400">APY {apy.toFixed(2)}%</p>
          )}
        </div>
      </div>
    );
  }

  if (variant === "action") {
    return (
      <div
        className="glass-card p-4 flex items-center justify-between gap-4"
        data-testid="vault-card-action"
      >
        <div className="flex items-center gap-3">
          <VaultIcon metadata={metadata} size={32} />
          <span className="font-medium">{name}</span>
        </div>
        <button
          type="button"
          onClick={onAction}
          className="btn-secondary px-4 py-1.5 text-sm"
        >
          {actionLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 py-2" data-testid="vault-card-list">
      <VaultIcon metadata={metadata} size={28} />
      <span className="flex-1">{name}</span>
      {tvl && <span className="text-sm text-gray-400">{tvl}</span>}
    </div>
  );
}
