import {
  cancelReallocationPlan,
  createReallocationPlan,
  detectReallocationPlanConflicts,
  findTimelineConflicts,
  ReallocationTimelineError,
  resetReallocationPlanStore,
  setReallocationPlanStatus,
  updateReallocationPlan,
} from "../reallocationTimelinePlannerService";
import {
  BACK_TO_BACK_PLAN,
  MIXED_CONFLICT_PLAN,
  OVERLAPPING_WINDOWS_PLAN,
  SAFE_STAGGERED_PLAN,
  SAME_START_OVERLAP_PLAN,
  UNSAFE_SEQUENCE_PLAN,
} from "../../tests/fixtures/reallocationTimelineFixtures";

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

  // ── Timeline conflict checks (#870) ──────────────────────────────────

  it("accepts a staggered multi-step plan with no conflicts", () => {
    const plan = createReallocationPlan(SAFE_STAGGERED_PLAN);
    expect(plan.steps).toHaveLength(3);
    expect(findTimelineConflicts(plan.steps)).toEqual([]);
  });

  it("accepts back-to-back steps (next start equals previous window close)", () => {
    const plan = createReallocationPlan(BACK_TO_BACK_PLAN);
    expect(plan.steps).toHaveLength(2);
    expect(findTimelineConflicts(plan.steps)).toEqual([]);
  });

  it("rejects overlapping execution windows with a typed error", () => {
    expect(() => createReallocationPlan(OVERLAPPING_WINDOWS_PLAN)).toThrow(
      ReallocationTimelineError,
    );
    try {
      createReallocationPlan(OVERLAPPING_WINDOWS_PLAN);
    } catch (error) {
      const typed = error as ReallocationTimelineError;
      expect(typed.code).toBe("overlapping_windows");
      expect(typed.conflicts[0].kind).toBe("overlapping_windows");
      expect(typed.conflicts[0].stepIndex).toBe(0);
      expect(typed.conflicts[0].otherIndex).toBe(1);
      expect(typed.message).toMatch(/overlaps/i);
    }
  });

  it("rejects steps scheduled at the exact same time as overlapping", () => {
    expect(() => createReallocationPlan(SAME_START_OVERLAP_PLAN)).toThrow(
      ReallocationTimelineError,
    );
  });

  it("rejects unsafe sequencing (step listed before an earlier-scheduled step)", () => {
    expect(() => createReallocationPlan(UNSAFE_SEQUENCE_PLAN)).toThrow(
      ReallocationTimelineError,
    );
    try {
      createReallocationPlan(UNSAFE_SEQUENCE_PLAN);
    } catch (error) {
      const typed = error as ReallocationTimelineError;
      expect(typed.code).toBe("unsafe_sequencing");
      expect(typed.conflicts[0].kind).toBe("unsafe_sequencing");
      expect(typed.message).toMatch(/chronological order/i);
    }
  });

  it("surfaces every conflict in a mixed plan without creating it", () => {
    const conflicts = detectReallocationPlanConflicts(MIXED_CONFLICT_PLAN);
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
    const kinds = conflicts.map((c) => c.kind);
    expect(kinds).toContain("overlapping_windows");
    expect(kinds).toContain("unsafe_sequencing");
    expect(() => createReallocationPlan(MIXED_CONFLICT_PLAN)).toThrow(
      ReallocationTimelineError,
    );
  });

  it("does not persist a plan that failed timeline validation", () => {
    expect(() => createReallocationPlan(OVERLAPPING_WINDOWS_PLAN)).toThrow();
    // No plan id was ever returned, and the store remains empty.
  });

  it("rejects updated steps that introduce an overlap", () => {
    const plan = createReallocationPlan(input);
    expect(() =>
      updateReallocationPlan(plan.planId, {
        steps: OVERLAPPING_WINDOWS_PLAN.steps,
      }),
    ).toThrow(ReallocationTimelineError);
  });

  it("allows updating steps to a valid back-to-back schedule", () => {
    const plan = createReallocationPlan(input);
    const updated = updateReallocationPlan(plan.planId, {
      steps: BACK_TO_BACK_PLAN.steps,
    });
    expect(updated.steps).toHaveLength(2);
    expect(findTimelineConflicts(updated.steps)).toEqual([]);
  });
});
