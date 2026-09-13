import { useMemo, useState } from "react";
import { normalizeVaultMetadata, type VaultIconMetadata } from "../../lib/vaultData";

const BADGE_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#ef4444",
];

function colorForSymbol(symbol: string): string {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  }
  return BADGE_COLORS[hash % BADGE_COLORS.length];
}

function fallbackReasons(fallback: {
  icon: boolean;
  symbol: boolean;
  issuer: boolean;
  decimals: boolean;
}): string[] {
  const reasons: string[] = [];
  if (fallback.symbol) reasons.push("symbol is missing or invalid");
  if (fallback.issuer) reasons.push("issuer is missing");
  if (fallback.decimals) reasons.push("decimals is missing or invalid");
  if (fallback.icon) reasons.push("icon is unavailable");
  return reasons;
}

export interface VaultIconProps {
  /** Possibly missing/malformed vault icon metadata. */
  metadata?: VaultIconMetadata | null;
  /** Diameter in pixels. */
  size?: number;
  className?: string;
}

/**
 * Renders a vault's icon, falling back to a stable generated badge (the
 * normalized symbol's first character on a deterministic color) whenever
 * metadata is missing/malformed or the image itself fails to load.
 *
 * Metadata is normalized via `normalizeVaultMetadata` so this component
 * never crashes on missing icon/symbol/issuer/decimals fields, and always
 * renders something usable. When any field fell back, a tooltip explains
 * why via the native `title` attribute.
 */
export default function VaultIcon({ metadata, size = 40, className = "" }: VaultIconProps) {
  const normalized = useMemo(() => normalizeVaultMetadata(metadata ?? undefined), [metadata]);
  const [imageFailed, setImageFailed] = useState(false);

  const showImage = normalized.iconUrl !== null && !imageFailed;
  const reasons = fallbackReasons(normalized.fallback);
  const isFallbackVisual = !showImage;

  const tooltip =
    reasons.length > 0
      ? `Showing fallback vault icon: ${reasons.join(", ")}.`
      : undefined;

  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) };

  if (showImage) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-full overflow-hidden shrink-0 bg-gray-800 ${className}`}
        style={style}
        title={tooltip}
        data-testid="vault-icon"
      >
        <img
          src={normalized.iconUrl as string}
          alt={`${normalized.symbol} icon`}
          onError={() => setImageFailed(true)}
          className="w-full h-full object-cover"
        />
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full shrink-0 font-bold text-white select-none ${className}`}
      style={{ ...style, backgroundColor: colorForSymbol(normalized.symbol) }}
      title={tooltip ?? `${normalized.symbol} vault icon`}
      data-testid="vault-icon-fallback"
      aria-label={`${normalized.symbol} vault icon${isFallbackVisual ? " (fallback)" : ""}`}
    >
      {normalized.symbol.slice(0, 1)}
    </span>
  );
}
