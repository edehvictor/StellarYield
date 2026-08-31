export type PlannerStatus = "draft" | "paused" | "cancelled" | "ready";

export interface VaultAllocationStep {
  stepId: string;
  scheduledAt: string;
  allocations: Record<string, number>;
  expectedFeeUsd: number;
  expectedRecoveryHours: number;
}

/**
 * The kind of timeline constraint violated by a plan.
 *
 * - `overlapping_windows`: a later step starts before an earlier step's
 *   execution window (scheduledAt + expectedRecoveryHours) has closed.
 * - `unsafe_sequencing`: steps are not in non-decreasing chronological
 *   order, so a later step would execute before an earlier one.
 */
export type TimelineConflictKind = "overlapping_windows" | "unsafe_sequencing";

/**
 * A single detected timeline conflict between two plan steps.
 * `stepIndex`/`otherIndex` are 0-based positions in the steps array;
 * `stepId`/`otherStepId` are populated once step ids have been assigned
 * (i.e. on persisted plans).
 */
export interface TimelineConflict {
  kind: TimelineConflictKind;
  /** 0-based index of the first step involved in the conflict. */
  stepIndex: number;
  /** stepId of the first step involved, when available. */
  stepId?: string;
  /** 0-based index of the second step involved. */
  otherIndex: number;
  /** stepId of the second step involved, when available. */
  otherStepId?: string;
  message: string;
}

/**
 * Typed error raised when a plan violates timeline constraints.
 * Carries the full list of detected conflicts so callers can surface
 * them to the planner UI instead of relying on the message text.
 */
export class ReallocationTimelineError extends Error {
  constructor(
    public readonly code: TimelineConflictKind,
    public readonly conflicts: TimelineConflict[],
  ) {
    super(
      `Reallocation plan rejected: ${conflicts
        .map((c) => c.message)
        .join(" ")}`.trim(),
    );
    this.name = "ReallocationTimelineError";
  }
}

/**
 * A step as supplied by callers: `stepId` is optional on input and is
 * assigned when the plan is persisted.
 */
export type ReallocationStepInput = Omit<VaultAllocationStep, "stepId"> & {
  stepId?: string;
};

export interface ReallocationPlanInput {
  planName: string;
  sourceVault: string;
  destinationVaults: string[];
  totalCapitalUsd: number;
  steps: ReallocationStepInput[];
}

export interface ReallocationPlan {
  planId: string;
  status: PlannerStatus;
  createdAt: string;
  updatedAt: string;
  planName: string;
  sourceVault: string;
  destinationVaults: string[];
  totalCapitalUsd: number;
  steps: VaultAllocationStep[];
  safetyNotice: string;
}

const plans = new Map<string, ReallocationPlan>();

function buildStepId(index: number): string {
  return `step-${index + 1}-${Math.random().toString(16).slice(2, 8)}`;
}

/** Milliseconds in one hour. */
const HOUR_MS = 60 * 60 * 1000;

/** Timestamp (ms) at which a step's execution window closes. */
function windowEndMs(scheduledAt: string, expectedRecoveryHours: number): number {
  return new Date(scheduledAt).getTime() + expectedRecoveryHours * HOUR_MS;
}

/**
 * Detect timeline conflicts across a set of steps.
 *
 * Validates two sequencing constraints:
 *
 * 1. **Chronological order** — steps must be listed in non-decreasing
 *    `scheduledAt` order; a step scheduled before a previously listed step
 *    is unsafe sequencing.
 * 2. **Non-overlapping execution windows** — a step's execution window
 *    spans `[scheduledAt, scheduledAt + expectedRecoveryHours)`. A later
 *    step may start exactly when the previous window closes (back-to-back),
 *    but starting before the window closes is an overlap.
 *
 * @param steps - Steps to inspect (step ids optional).
 * @returns All conflicts found, in deterministic (index) order. Empty when safe.
 */
export function findTimelineConflicts(
  steps: Array<Pick<VaultAllocationStep, "scheduledAt" | "expectedRecoveryHours"> & { stepId?: string }>,
): TimelineConflict[] {
  const conflicts: TimelineConflict[] = [];

  for (let i = 0; i < steps.length - 1; i++) {
    const current = steps[i];
    const next = steps[i + 1];
    const currentStart = new Date(current.scheduledAt).getTime();
    const nextStart = new Date(next.scheduledAt).getTime();

    if (nextStart < currentStart) {
      conflicts.push({
        kind: "unsafe_sequencing",
        stepIndex: i,
        stepId: current.stepId,
        otherIndex: i + 1,
        otherStepId: next.stepId,
        message:
          `Step ${i + 1} is scheduled (${current.scheduledAt}) after step ${i + 2} (${next.scheduledAt}); ` +
          `steps must execute in chronological order.`,
      });
      continue;
    }

    const currentEnd = windowEndMs(current.scheduledAt, current.expectedRecoveryHours);
    if (nextStart < currentEnd) {
      conflicts.push({
        kind: "overlapping_windows",
        stepIndex: i,
        stepId: current.stepId,
        otherIndex: i + 1,
        otherStepId: next.stepId,
        message:
          `Step ${i + 1} execution window (${current.scheduledAt}, +${current.expectedRecoveryHours}h) ` +
          `overlaps step ${i + 2} start (${next.scheduledAt}); schedule the next step at or after ` +
          `the previous step's recovery window closes.`,
      });
    }
  }

  return conflicts;
}

/**
 * Surface any timeline conflicts for a plan input without creating it.
 * Useful for pre-flight checks in the planner UI.
 */
export function detectReallocationPlanConflicts(input: ReallocationPlanInput): TimelineConflict[] {
  return findTimelineConflicts(input.steps);
}

function validatePlanInput(input: ReallocationPlanInput): void {
  if (!input.steps.length) {
    throw new Error("At least one staged step is required.");
  }
  for (const step of input.steps) {
    const total = Object.values(step.allocations).reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 100) > 0.01) {
      throw new Error("Each step allocation must sum to 100%.");
    }
  }

  const conflicts = findTimelineConflicts(input.steps);
  if (conflicts.length > 0) {
    throw new ReallocationTimelineError(conflicts[0].kind, conflicts);
  }
}

export function createReallocationPlan(input: ReallocationPlanInput): ReallocationPlan {
  validatePlanInput(input);

  const now = new Date().toISOString();
  const plan: ReallocationPlan = {
    planId: `plan-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    planName: input.planName,
    sourceVault: input.sourceVault,
    destinationVaults: input.destinationVaults,
    totalCapitalUsd: input.totalCapitalUsd,
    steps: input.steps.map((step, index) => ({ ...step, stepId: buildStepId(index) })),
    safetyNotice: "Planning only: no movement executes until explicit live confirmation.",
  };

  plans.set(plan.planId, plan);
  return plan;
}

export function updateReallocationPlan(
  planId: string,
  updater: Partial<Pick<ReallocationPlan, "planName"> & { steps: ReallocationStepInput[] }>,
): ReallocationPlan {
  const current = plans.get(planId);
  if (!current) throw new Error("Plan not found.");
  if (current.status === "cancelled") throw new Error("Cancelled plans cannot be updated.");

  const nextSteps = updater.steps
    ? updater.steps.map((step, index) => ({ ...step, stepId: step.stepId ?? buildStepId(index) }))
    : current.steps;

  if (updater.steps) {
    const conflicts = findTimelineConflicts(nextSteps);
    if (conflicts.length > 0) {
      throw new ReallocationTimelineError(conflicts[0].kind, conflicts);
    }
  }

  const next: ReallocationPlan = {
    ...current,
    planName: updater.planName ?? current.planName,
    steps: nextSteps,
    updatedAt: new Date().toISOString(),
  };

  plans.set(planId, next);
  return next;
}

export function setReallocationPlanStatus(planId: string, status: PlannerStatus): ReallocationPlan {
  const current = plans.get(planId);
  if (!current) throw new Error("Plan not found.");
  const next = { ...current, status, updatedAt: new Date().toISOString() };
  plans.set(planId, next);
  return next;
}

export function getReallocationPlan(planId: string): ReallocationPlan | null {
  return plans.get(planId) ?? null;
}

export function cancelReallocationPlan(planId: string): ReallocationPlan {
  return setReallocationPlanStatus(planId, "cancelled");
}

export function resetReallocationPlanStore(): void {
  plans.clear();
}
