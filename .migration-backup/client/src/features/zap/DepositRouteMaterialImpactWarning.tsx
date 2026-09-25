import { AlertTriangle, ShieldAlert, Ban } from "lucide-react";
import { useDepositImpact } from "./useDepositImpact";
import type { ImpactSeverity, QuoteSnapshot } from "./useDepositImpact";

export interface DepositRouteMaterialImpactWarningProps {
  amountUsd: number;
  slippageTolerance: number;
  isFallback: boolean;
  isStale: boolean;
  executionQualityScore?: number;
  materialImpact?: boolean;
  quote?: QuoteSnapshot;
  routeImpactThreshold?: number;
  blockStaleQuotes?: boolean;
}

const SEVERITY_STYLES: Record<
  Exclude<ImpactSeverity, "none">,
  { bg: string; border: string; title: string; titleColor: string; bodyColor: string }
> = {
  warning: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    title: "Deposit route may affect execution quality",
    titleColor: "text-amber-300",
    bodyColor: "text-amber-200/70",
  },
  critical: {
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    title: "High execution risk for this deposit route",
    titleColor: "text-red-300",
    bodyColor: "text-red-200/70",
  },
};

export default function DepositRouteMaterialImpactWarning({
  amountUsd,
  slippageTolerance,
  isFallback,
  isStale,
  executionQualityScore,
  materialImpact,
  quote,
  routeImpactThreshold,
  blockStaleQuotes,
}: DepositRouteMaterialImpactWarningProps) {
  const impact = useDepositImpact({
    amountUsd,
    slippageTolerance,
    isFallback,
    isStale,
    executionQualityScore,
    materialImpact,
    quote,
    routeImpactThreshold,
    blockStaleQuotes,
  });

  if (impact.severity === "none" && !impact.shouldBlock) return null;

  if (impact.shouldBlock) {
    return (
      <div
        className="flex items-start gap-2 p-3 rounded-lg border bg-red-500/10 border-red-500/30"
        role="alert"
        aria-live="assertive"
      >
        <Ban className="w-4 h-4 shrink-0 mt-0.5 text-red-300" />
        <div>
          <p className="text-sm font-medium text-red-300">Deposit blocked</p>
          <p className="mt-1 text-xs text-red-200/70">{impact.blockReason}</p>
        </div>
      </div>
    );
  }

  const styles = SEVERITY_STYLES[impact.severity as Exclude<ImpactSeverity, "none">];
  const Icon = impact.severity === "critical" ? ShieldAlert : AlertTriangle;

  return (
    <div
      className={`flex items-start gap-2 p-3 rounded-lg border ${styles.bg} ${styles.border}`}
      role="alert"
      aria-live="polite"
    >
      <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${styles.titleColor}`} />
      <div>
        <p className={`text-sm font-medium ${styles.titleColor}`}>{styles.title}</p>
        <ul className={`mt-1 space-y-0.5 text-xs ${styles.bodyColor}`}>
          {impact.reasons.map((reason) => (
            <li key={reason}>· {reason}</li>
          ))}
        </ul>
        {impact.severity === "critical" && (
          <p className="mt-1.5 text-xs text-red-300/80 font-medium">
            Review the route carefully. Deposit is not blocked but proceed with caution.
          </p>
        )}
      </div>
    </div>
  );
}
