/**
 * Emergency Mode Operator Runbook Panel
 *
 * Checklist-style panel that guides operators through pause → verify → notify
 * → resume. It shows the current pause/health status where available and links
 * each step to the runbook doc or a read-only status check.
 *
 * Read-only by design: the per-step action buttons are always disabled. The
 * panel holds no privileged keys and never executes pause/resume — those are
 * performed deliberately via the admin console.
 */

import { useEffect, useMemo, useState } from "react";
import { ShieldAlert, CheckCircle2, Circle, ExternalLink } from "lucide-react";
import StatusBadge from "../../components/StatusBadge";
import { apiUrl } from "../../lib/api";
import {
  EMERGENCY_RUNBOOK_STEPS,
  deriveRunbookProgress,
  type EmergencyStatus,
  type RunbookStepState,
} from "./emergencyRunbook";

export interface EmergencyRunbookPanelProps {
  /** When provided, the panel renders this status instead of fetching it. */
  status?: EmergencyStatus;
}

const STATE_STYLES: Record<RunbookStepState, string> = {
  complete: "border-green-500/30 bg-green-500/5",
  current: "border-indigo-500/40 bg-indigo-500/5",
  upcoming: "border-white/10 bg-black/20",
};

export default function EmergencyRunbookPanel({
  status: statusProp,
}: EmergencyRunbookPanelProps) {
  const [fetchedStatus, setFetchedStatus] = useState<EmergencyStatus | null>(
    null,
  );

  useEffect(() => {
    if (statusProp) return;
    let cancelled = false;
    // Health is read from the public health route. Pause state is not exposed
    // through a public endpoint, so it defaults to "unknown" (treated as not
    // paused) until an operator confirms it in the admin console.
    fetch(apiUrl("/api/health"))
      .then((res) => {
        if (!cancelled) setFetchedStatus({ isPaused: false, healthy: res.ok });
      })
      .catch(() => {
        if (!cancelled) setFetchedStatus({ isPaused: false, healthy: false });
      });
    return () => {
      cancelled = true;
    };
  }, [statusProp]);

  const status: EmergencyStatus = statusProp ??
    fetchedStatus ?? { isPaused: false, healthy: true };

  const progress = useMemo(() => deriveRunbookProgress(status), [status]);
  const stateById = useMemo(
    () => new Map(progress.steps.map((s) => [s.id, s.state])),
    [progress],
  );

  return (
    <div className="glass-panel p-6 space-y-4">
      <div className="flex items-center gap-2">
        <ShieldAlert size={20} className="text-amber-400" />
        <h2 className="text-xl font-semibold">Emergency Mode Runbook</h2>
      </div>

      <p className="text-sm text-gray-400">
        Guidance only — this panel never pauses or resumes the protocol. Perform
        privileged actions in the admin console.
      </p>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-400">Status:</span>
        <StatusBadge
          variant={status.healthy ? "success" : "danger"}
          compact
          label={status.healthy ? "Health: OK" : "Health: Degraded"}
        />
        <StatusBadge
          variant={status.isPaused ? "warning" : "neutral"}
          compact
          label={status.isPaused ? "Protocol: Paused" : "Protocol: Active"}
        />
        <StatusBadge
          variant={progress.phase === "incident" ? "danger" : "success"}
          compact
          label={progress.phase === "incident" ? "Incident in progress" : "Nominal"}
        />
      </div>

      <ol className="space-y-3">
        {EMERGENCY_RUNBOOK_STEPS.map((step, idx) => {
          const state = stateById.get(step.id) ?? "upcoming";
          return (
            <li
              key={step.id}
              data-testid={`runbook-step-${step.id}`}
              data-state={state}
              className={`rounded-lg border p-4 ${STATE_STYLES[state]}`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    {state === "complete" ? (
                      <CheckCircle2 className="w-4 h-4 text-green-400" />
                    ) : (
                      <Circle
                        className={`w-4 h-4 ${state === "current" ? "text-indigo-400" : "text-gray-500"}`}
                      />
                    )}
                    <span className="font-medium">
                      {idx + 1}. {step.title}
                    </span>
                  </div>
                  <p className="text-sm text-gray-400">{step.description}</p>
                  <a
                    href={step.reference.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
                  >
                    {step.reference.label}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  title="Read-only — perform this action in the admin console"
                  className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-white/5 text-gray-400 cursor-not-allowed opacity-60"
                >
                  {step.actionLabel}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
