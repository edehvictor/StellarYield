import { describe, expect, it, vi } from "vitest";
import {
  commitYieldDisplaySnapshot,
  toYieldCurveDisplayPayload,
  type CommittedYieldDisplayState,
} from "../yieldDisplayOperation";
import { YieldDisplayOperationManager } from "../../../../../shared/types/yieldDataDisplayOperation";
import type { ProjectionAssumptions, YieldCurveResult } from "../types";

const assumptions: ProjectionAssumptions = {
  principalUsd: 10_000,
  compounding: "daily",
  feeDragPct: 1,
  allocations: [
    { id: "blend", label: "Blend", apyPct: 6.5, weightPct: 100 },
  ],
};

const projection = {
  horizon: "90d",
  horizonDays: 90,
  blendedApyPct: 6.5,
  netApyPct: 5.5,
  scenarios: {} as YieldCurveResult["scenarios"],
};

const emptyState: CommittedYieldDisplayState = { result: null, replayed: false };

describe("yield display snapshot commits", () => {
  it("builds a stable payload from the displayed assumptions", () => {
    const first = toYieldCurveDisplayPayload("90d", assumptions);
    const second = toYieldCurveDisplayPayload("90d", {
      ...assumptions,
      allocations: [...assumptions.allocations].reverse(),
    });
    expect(first).toEqual(second);
  });

  it("commits a normal snapshot and returns the operation identity", () => {
    const manager = new YieldDisplayOperationManager();
    const committed = commitYieldDisplaySnapshot({
      horizon: "90d",
      assumptions,
      currentState: emptyState,
      manager,
      execute: () => projection,
    });

    expect(committed.state.result).toBe(projection);
    expect(committed.state.effect?.type).toBe("YIELD_CURVE_SNAPSHOT_COMMITTED");
    expect(manager.getOperation(committed.identity.operationId)?.status).toBe("committed");
  });

  it("preserves the previous snapshot and balances when validation fails", () => {
    const manager = new YieldDisplayOperationManager();
    const execute = vi.fn(() => projection);
    const previous: CommittedYieldDisplayState = {
      result: projection,
      replayed: false,
      effect: undefined,
      identity: undefined,
    };
    const invalid = {
      ...assumptions,
      allocations: [{ id: "blend", label: "Blend", apyPct: 6.5, weightPct: 40 }],
    };

    const failed = commitYieldDisplaySnapshot({
      horizon: "90d",
      assumptions: invalid,
      currentState: previous,
      manager,
      execute,
    });

    expect(failed.state.result).toBe(projection);
    expect(failed.state.errorCode).toBe("YIELD_DISPLAY_VALIDATION_FAILED");
    expect(failed.state.error).toMatch(/sum to 100/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves state on execution failure and safely retries with the same identity", () => {
    const manager = new YieldDisplayOperationManager();
    const execute = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("projection unavailable");
      })
      .mockImplementation(() => projection);
    const options = {
      horizon: "90d" as const,
      assumptions,
      currentState: emptyState,
      manager,
      execute,
    };

    const failed = commitYieldDisplaySnapshot(options);
    expect(failed.state.result).toBeNull();
    expect(failed.state.errorCode).toBe("YIELD_DISPLAY_EXECUTION_FAILED");

    const retried = commitYieldDisplaySnapshot({
      ...options,
      previousIdentity: failed.identity,
    });
    expect(retried.identity.operationId).toBe(failed.identity.operationId);
    expect(retried.state.result).toBe(projection);
    expect(retried.state.effect).toBeDefined();

    const duplicate = commitYieldDisplaySnapshot({
      ...options,
      currentState: retried.state,
      previousIdentity: retried.identity,
    });
    expect(duplicate.outcome.replayed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("creates a new identity when assumptions change", () => {
    const manager = new YieldDisplayOperationManager();
    const first = commitYieldDisplaySnapshot({
      horizon: "90d",
      assumptions,
      currentState: emptyState,
      manager,
      execute: () => projection,
    });
    const changed = commitYieldDisplaySnapshot({
      horizon: "30d",
      assumptions,
      currentState: first.state,
      previousIdentity: first.identity,
      manager,
      execute: () => projection,
    });

    expect(changed.identity.operationId).not.toBe(first.identity.operationId);
    expect(changed.outcome.replayed).toBeFalsy();
  });
});
