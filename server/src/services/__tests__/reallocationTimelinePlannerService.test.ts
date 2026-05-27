import {
  cancelReallocationPlan,
  createReallocationPlan,
  resetReallocationPlanStore,
  setReallocationPlanStatus,
  updateReallocationPlan,
} from "../reallocationTimelinePlannerService";

describe("reallocationTimelinePlannerService", () => {
  beforeEach(() => {
    resetReallocationPlanStore();
  });

  const input = {
    planName: "Gradual Shift",
    sourceVault: "Vault-A",
    destinationVaults: ["Vault-B", "Vault-C"],
    totalCapitalUsd: 500000,
    steps: [
      {
        scheduledAt: "2026-05-01T00:00:00.000Z",
        allocations: { "Vault-A": 70, "Vault-B": 20, "Vault-C": 10 },
        expectedFeeUsd: 200,
        expectedRecoveryHours: 12,
      },
    ],
  };

  it("creates draft plans", () => {
    const plan = createReallocationPlan(input);
    expect(plan.status).toBe("draft");
    expect(plan.steps[0].stepId).toContain("step-1");
  });

  it("updates plans", () => {
    const plan = createReallocationPlan(input);
    const updated = updateReallocationPlan(plan.planId, { planName: "Updated Name" });
    expect(updated.planName).toBe("Updated Name");
  });

  it("supports pause and resume", () => {
    const plan = createReallocationPlan(input);
    const paused = setReallocationPlanStatus(plan.planId, "paused");
    const resumed = setReallocationPlanStatus(plan.planId, "ready");
    expect(paused.status).toBe("paused");
    expect(resumed.status).toBe("ready");
  });

  it("supports cancellation", () => {
    const plan = createReallocationPlan(input);
    const cancelled = cancelReallocationPlan(plan.planId);
    expect(cancelled.status).toBe("cancelled");
  });
});
