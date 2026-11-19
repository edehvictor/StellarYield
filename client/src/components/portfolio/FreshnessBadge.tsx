import StatusBadge, { type StatusVariant } from '../StatusBadge';
import { formatFreshnessAge, type FreshnessStatus } from './holdingFreshness';

interface FreshnessBadgeProps {
  status: FreshnessStatus;
  ageSeconds?: number | null;
  compact?: boolean;
}

const FRESHNESS_DISPLAY: Record<FreshnessStatus, { label: string; variant: StatusVariant }> = {
  fresh: { label: 'Fresh', variant: 'success' },
  stale: { label: 'Stale', variant: 'warning' },
  unknown: { label: 'Unknown', variant: 'neutral' },
};

/**
 * Displays a portfolio holding's source-data freshness as a compact badge
 * (#1107). Fresh/stale/unknown mirrors the classification in
 * server/src/services/sourceHealthService.ts and
 * client/src/components/portfolio/holdingFreshness.ts, so the badge shown
 * here always matches what an exported report would say for the same row.
 */
export default function FreshnessBadge({ status, ageSeconds, compact = true }: FreshnessBadgeProps) {
  const display = FRESHNESS_DISPLAY[status] ?? FRESHNESS_DISPLAY.unknown;
  const ageLabel = formatFreshnessAge(ageSeconds);
  const label = ageLabel ? `${display.label} · ${ageLabel}` : display.label;

  return <StatusBadge variant={display.variant} label={label} compact={compact} />;
}