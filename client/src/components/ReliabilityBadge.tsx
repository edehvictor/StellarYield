import React from 'react';

export type ReliabilityBadge = 'high' | 'moderate' | 'low';

interface Props {
  badge: ReliabilityBadge;
  reason?: string;
}

const CONFIG: Record<ReliabilityBadge, { label: string; className: string }> = {
  high:     { label: '✓ High Reliability',     className: 'bg-green-100 text-green-800 border-green-300' },
  moderate: { label: '~ Moderate Reliability', className: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
  // Low must be visually prominent — bold border, strong contrast
  low:      { label: '⚠ Low Reliability',      className: 'bg-red-100 text-red-900 border-red-500 font-bold ring-2 ring-red-400' },
};

export function ReliabilityBadgeComponent({ badge, reason }: Props) {
  const { label, className } = CONFIG[badge];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${className}`}
      title={reason}
      aria-label={`Yield reliability: ${label}${reason ? `. ${reason}` : ''}`}
    >
      {label}
    </span>
  );
}
