import React from 'react';

export type StatusVariant = 'success' | 'warning' | 'danger' | 'neutral';

interface StatusBadgeProps {
  variant?: StatusVariant;
  label: string;
  compact?: boolean;
  className?: string;
}

const VARIANT_CLASSES: Record<StatusVariant, string> = {
  success: 'bg-[#3EAC75]/10 text-[#3EAC75] border-[#3EAC75]/20',
  warning: 'bg-[#F5A623]/10 text-[#F5A623] border-[#F5A623]/20',
  danger: 'bg-[#FF5E5E]/10 text-[#FF5E5E] border-[#FF5E5E]/20',
  neutral: 'bg-white/5 text-gray-300 border-white/10',
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  variant = 'neutral',
  label,
  compact = false,
  className = '',
}) => {
  const padding = compact ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';

  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-flex items-center gap-2 font-semibold rounded-full border ${padding} ${VARIANT_CLASSES[variant]} ${className}`}
    >
      <span className="sr-only">Status:</span>
      <span aria-hidden className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: 'currentColor', opacity: 0.9 }} />
      <span>{label}</span>
    </span>
  );
};

export default StatusBadge;
