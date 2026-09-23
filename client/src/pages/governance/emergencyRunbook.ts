/**
 * Emergency Mode Operator Runbook — data & progress logic.
 *
 * Defines the pause → verify → notify → resume checklist and a pure function
 * that derives each step's state from the current pause/health status. Pure
 * and framework-free so it can be unit tested without rendering.
 *
 * The runbook is guidance only: it never executes privileged actions. See
 * docs/EMERGENCY_RUNBOOK.md.
 */

export type RunbookStepId = "pause" | "verify" | "notify" | "resume";

export interface RunbookReference {
  label: string;
  /** Doc anchor or read-only status-check path for this step. */
  href: string;
}

export interface RunbookStep {
  id: RunbookStepId;
  title: string;
  description: string;
  reference: RunbookReference;
  /** Label of the privileged action this step describes (rendered disabled). */
  actionLabel: string;
}

const RUNBOOK_DOC = "/docs/EMERGENCY_RUNBOOK.md";

export const EMERGENCY_RUNBOOK_STEPS: RunbookStep[] = [
  {
    id: "pause",
    title: "Pause",
    description:
      "Halt new deposits and strategy execution to contain the incident.",
    reference: { label: "Runbook: Pause", href: `${RUNBOOK_DOC}#pause` },
    actionLabel: "Pause protocol",
  },
  {
    id: "verify",
    title: "Verify",
    description:
      "Confirm the pause took effect and establish what is actually wrong.",
    reference: { label: "Health check", href: "/api/health" },
    actionLabel: "Re-run verification",
  },
  {
    id: "notify",
    title: "Notify",
    description:
      "Communicate status to users and stakeholders and record the timeline.",
    reference: { label: "Runbook: Notify", href: `${RUNBOOK_DOC}#notify` },
    actionLabel: "Mark stakeholders notified",
  },
  {
    id: "resume",
    title: "Resume",
    description:
      "Return to normal operation only after the root cause is fixed and verified.",
    reference: { label: "Runbook: Resume", href: `${RUNBOOK_DOC}#resume` },
    actionLabel: "Resume protocol",
  },
];

export type RunbookPhase = "nominal" | "incident";
export type RunbookStepState = "complete" | "current" | "upcoming";

export interface EmergencyStatus {
  isPaused: boolean;
  healthy: boolean;
}

export interface RunbookStepProgress {
  id: RunbookStepId;
  state: RunbookStepState;
}

export interface RunbookProgress {
  phase: RunbookPhase;
  steps: RunbookStepProgress[];
}

/**
 * Derive checklist progress from the current pause/health status.
 *
 * - `nominal` phase (running and healthy): no active incident; every step is
 *   upcoming.
 * - `incident` phase: steps are evaluated sequentially. A step is `complete`
 *   when its goal is objectively met, `current` for the first incomplete step,
 *   and `upcoming` otherwise. `notify` is a manual acknowledgement and is never
 *   auto-completed.
 */
export function deriveRunbookProgress(status: EmergencyStatus): RunbookProgress {
  const phase: RunbookPhase =
    !status.isPaused && status.healthy ? "nominal" : "incident";

  const complete: Record<RunbookStepId, boolean> = {
    pause: status.isPaused,
    verify: status.isPaused && status.healthy,
    notify: false,
    resume: false,
  };

  let currentAssigned = false;
  const steps: RunbookStepProgress[] = EMERGENCY_RUNBOOK_STEPS.map((step) => {
    if (complete[step.id]) {
      return { id: step.id, state: "complete" };
    }
    if (phase === "incident" && !currentAssigned) {
      currentAssigned = true;
      return { id: step.id, state: "current" };
    }
    return { id: step.id, state: "upcoming" };
  });

  return { phase, steps };
}

// ── Runbook State Persistence ──────────────────────────────────────────

const RUNBOOK_STORAGE_KEY = "stellar_yield_runbook_state";

export interface RunbookPersistedState {
  acknowledgedSteps: RunbookStepId[];
  incidentStartedAt: string | null;
  lastUpdatedAt: string;
  failedStepAttempts: Record<RunbookStepId, number>;
}

export function createEmptyPersistedState(): RunbookPersistedState {
  return {
    acknowledgedSteps: [],
    incidentStartedAt: null,
    lastUpdatedAt: new Date().toISOString(),
    failedStepAttempts: {} as Record<RunbookStepId, number>,
  };
}

export function loadRunbookState(
  storage: Storage | null,
): RunbookPersistedState {
  if (!storage) return createEmptyPersistedState();
  try {
    const raw = storage.getItem(RUNBOOK_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as RunbookPersistedState;
  } catch {
    // corrupted storage — reset
  }
  return createEmptyPersistedState();
}

export function saveRunbookState(
  storage: Storage | null,
  state: RunbookPersistedState,
): void {
  if (!storage) return;
  try {
    storage.setItem(RUNBOOK_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage full or unavailable — silently fail
  }
}

export function acknowledgeStep(
  state: RunbookPersistedState,
  stepId: RunbookStepId,
): RunbookPersistedState {
  if (state.acknowledgedSteps.includes(stepId)) return state;
  return {
    ...state,
    acknowledgedSteps: [...state.acknowledgedSteps, stepId],
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function recordStepFailure(
  state: RunbookPersistedState,
  stepId: RunbookStepId,
): RunbookPersistedState {
  const attempts = (state.failedStepAttempts[stepId] ?? 0) + 1;
  return {
    ...state,
    failedStepAttempts: { ...state.failedStepAttempts, [stepId]: attempts },
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function startIncident(
  state: RunbookPersistedState,
): RunbookPersistedState {
  return {
    ...state,
    incidentStartedAt: state.incidentStartedAt ?? new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function resetRunbookState(
  state: RunbookPersistedState,
): RunbookPersistedState {
  return {
    ...createEmptyPersistedState(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function deriveRunWithPersistence(
  status: EmergencyStatus,
  persisted: RunbookPersistedState,
): RunbookProgress & { persisted: RunbookPersistedState } {
  const base = deriveRunbookProgress(status);

  const steps = base.steps.map((step) => {
    if (persisted.acknowledgedSteps.includes(step.id) && step.state !== "complete") {
      return { ...step, state: "complete" as RunbookStepState };
    }
    return step;
  });

  let currentAssigned = false;
  const reconciled = steps.map((step) => {
    if (step.state === "complete") return step;
    if (base.phase === "incident" && !currentAssigned) {
      currentAssigned = true;
      return { ...step, state: "current" as RunbookStepState };
    }
    return { ...step, state: "upcoming" as RunbookStepState };
  });

  return { phase: base.phase, steps: reconciled, persisted };
}
