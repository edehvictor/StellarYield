export type PlannerStatus = "draft" | "paused" | "cancelled" | "ready";

export interface VaultAllocationStep {
  stepId: string;
  scheduledAt: string;
  allocations: Record<string, number>;
  expectedFeeUsd: number;
  expectedRecoveryHours: number;
}

export interface ReallocationPlanInput {
  planName: string;
  sourceVault: string;
  destinationVaults: string[];
  totalCapitalUsd: number;
  steps: Omit<VaultAllocationStep, "stepId">[];
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

export function updateReallocationPlan(planId: string, updater: Partial<Pick<ReallocationPlan, "planName" | "steps">>): ReallocationPlan {
  const current = plans.get(planId);
  if (!current) throw new Error("Plan not found.");
  if (current.status === "cancelled") throw new Error("Cancelled plans cannot be updated.");

  const nextSteps = updater.steps
    ? updater.steps.map((step, index) => ({ ...step, stepId: step.stepId ?? buildStepId(index) }))
    : current.steps;

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
