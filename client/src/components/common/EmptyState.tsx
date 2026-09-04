import type { ReactNode } from "react";
import type { EmptyStateCopy } from "../../utils/emptyStateCopy";

/**
 * Reusable empty-state component that provides a consistent look and feel
 * across analytics, dashboard, chart, and vault panels.
 *
 * Follows the existing `glass-panel` convention (centred icon → heading →
 * description → optional action).
 */
export interface EmptyStateProps {
  /** Icon rendered above the title. Recommended: a 48 px lucide icon. */
  icon?: ReactNode;
  /** Heading text (sentence case, no trailing period). */
  title: string;
  /** One-sentence description below the title. */
  description?: string;
  /** Optional primary action button. */
  action?: {
    label: string;
    onClick: () => void;
    /** While the action is in progress (e.g. loading / refreshing). */
    loading?: boolean;
  };
  /** HTML `data-testid` attribute for automated tests. */
  testId?: string;
}

export default function EmptyState({
  icon,
  title,
  description,
  action,
  testId,
}: EmptyStateProps) {
  return (
    <div className="text-center py-12" data-testid={testId}>
      {icon && <div className="mb-4 flex justify-center">{icon}</div>}
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      {description && (
        <p className="text-gray-400 mb-4">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="btn-primary inline-flex items-center gap-2"
          disabled={action.loading}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * Convenience factory that accepts an `EmptyStateCopy` object directly.
 * Keeps call-sites DRY when pairing copy constants with the component.
 */
export function EmptyStateFromCopy({
  copy,
  icon,
  action,
  testId,
}: {
  copy: EmptyStateCopy;
  icon?: ReactNode;
  action?: EmptyStateProps["action"];
  testId?: string;
}) {
  return (
    <EmptyState
      icon={icon}
      title={copy.title}
      description={copy.description}
      action={action}
      testId={testId}
    />
  );
}
