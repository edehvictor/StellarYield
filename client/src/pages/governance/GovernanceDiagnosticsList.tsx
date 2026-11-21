import { AlertTriangle, Info } from "lucide-react";
import {
  getGovernanceStageLabel,
  type GovernanceDiagnostic,
} from "../../../../shared/types/governanceDiagnostic";

interface GovernanceDiagnosticsListProps {
  diagnostics: readonly GovernanceDiagnostic[];
}

/**
 * Renders privacy-safe governance diagnostics: the failed stage, a stable
 * code, a plain-language summary, and the single next action to take.
 */
export default function GovernanceDiagnosticsList({
  diagnostics,
}: GovernanceDiagnosticsListProps) {
  if (diagnostics.length === 0) return null;

  return (
    <div
      role="alert"
      aria-label="Governance diagnostics"
      className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 space-y-2"
    >
      <p className="text-xs font-medium text-amber-300 uppercase tracking-wide">
        Governance diagnostics
      </p>
      <ul className="space-y-2">
        {diagnostics.map((diagnostic) => (
          <li
            key={`${diagnostic.code}-${diagnostic.stage}`}
            className="text-xs text-gray-300"
          >
            <p className="flex items-center gap-1.5 font-medium text-amber-200">
              {diagnostic.severity === "info" ? (
                <Info className="w-3.5 h-3.5 shrink-0" aria-hidden />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden />
              )}
              {getGovernanceStageLabel(diagnostic.stage)} · {diagnostic.code}
            </p>
            <p className="mt-0.5">{diagnostic.summary}</p>
            <p className="mt-0.5 text-gray-400">Next: {diagnostic.remediation}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
