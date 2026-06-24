/**
 * Tests for the event-sourced strategy lifecycle audit service (#720).
 */

import { StrategyLifecycleAuditService } from "../services/strategyLifecycleAuditService";
import type {
  StrategyRecommendedEvent,
  StrategyQueuedEvent,
  StrategyRiskCheckedEvent,
  StrategyExecutedEvent,
  StrategyBlockedEvent,
  StrategySnapshottedEvent,
} from "../types/strategyLifecycleEvents";

let service: StrategyLifecycleAuditService;

const strategyId = "strat-001";
const now = new Date("2024-05-01T10:00:00Z");

const recommended: StrategyRecommendedEvent = {
  strategyId,
  timestamp: new Date(now.getTime()),
  type: "StrategyRecommended",
  recommendedBy: "optimizer-v2",
  rationale: "High APY opportunity detected",
  expectedApyBps: 645,
};

const queued: StrategyQueuedEvent = {
  strategyId,
  timestamp: new Date(now.getTime() + 1000),
  type: "StrategyQueued",
  queuePosition: 1,
  priority: "high",
};

const riskChecked: StrategyRiskCheckedEvent = {
  strategyId,
  timestamp: new Date(now.getTime() + 2000),
  type: "StrategyRiskChecked",
  riskScore: 42,
  passed: true,
  checkedBy: "risk-engine-v1",
};

const executed: StrategyExecutedEvent = {
  strategyId,
  timestamp: new Date(now.getTime() + 3000),
  type: "StrategyExecuted",
  executedBy: "executor-agent",
  executionDurationMs: 120,
  resultApyBps: 640,
};

const blocked: StrategyBlockedEvent = {
  strategyId,
  timestamp: new Date(now.getTime() + 3000),
  type: "StrategyBlocked",
  reason: "Exceeded risk threshold",
  blockedBy: "risk-engine-v1",
};

beforeEach(() => {
  service = new StrategyLifecycleAuditService();
});

// ------------------------------------------------------------------
// recordEvent + getHistory
// ------------------------------------------------------------------

describe("recordEvent + getHistory", () => {
  it("returns empty array for an unknown strategy", () => {
    expect(service.getHistory("unknown-strat")).toEqual([]);
  });

  it("records a single event and returns it in history", () => {
    service.recordEvent(recommended);
    const history = service.getHistory(strategyId);

    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("StrategyRecommended");
  });

  it("records multiple events in insertion order", () => {
    service.recordEvent(recommended);
    service.recordEvent(queued);
    service.recordEvent(riskChecked);
    service.recordEvent(executed);

    const history = service.getHistory(strategyId);

    expect(history).toHaveLength(4);
    expect(history.map((e) => e.type)).toEqual([
      "StrategyRecommended",
      "StrategyQueued",
      "StrategyRiskChecked",
      "StrategyExecuted",
    ]);
  });

  it("isolates events per strategy", () => {
    service.recordEvent({ ...recommended, strategyId: "strat-A" });
    service.recordEvent({ ...recommended, strategyId: "strat-B" });

    expect(service.getHistory("strat-A")).toHaveLength(1);
    expect(service.getHistory("strat-B")).toHaveLength(1);
  });

  it("getHistory returns a copy — mutations do not affect the log", () => {
    service.recordEvent(recommended);
    const history = service.getHistory(strategyId);
    history.pop();

    expect(service.getHistory(strategyId)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------
// reconstructPath
// ------------------------------------------------------------------

describe("reconstructPath", () => {
  it("returns empty array for unknown strategy", () => {
    expect(service.reconstructPath("ghost")).toEqual([]);
  });

  it("matches the recorded insertion order — successful path", () => {
    service.recordEvent(recommended);
    service.recordEvent(queued);
    service.recordEvent(riskChecked);
    service.recordEvent(executed);

    expect(service.reconstructPath(strategyId)).toEqual([
      "StrategyRecommended",
      "StrategyQueued",
      "StrategyRiskChecked",
      "StrategyExecuted",
    ]);
  });

  it("matches the recorded insertion order — blocked path", () => {
    service.recordEvent(recommended);
    service.recordEvent(riskChecked);
    service.recordEvent(blocked);

    expect(service.reconstructPath(strategyId)).toEqual([
      "StrategyRecommended",
      "StrategyRiskChecked",
      "StrategyBlocked",
    ]);
  });

  it("includes StrategySnapshotted when recorded", () => {
    const snapshotted: StrategySnapshottedEvent = {
      strategyId,
      timestamp: new Date(now.getTime() + 500),
      type: "StrategySnapshotted",
      snapshotId: "snap-001",
      snapshotHash: "abc123",
    };

    service.recordEvent(recommended);
    service.recordEvent(snapshotted);
    service.recordEvent(executed);

    expect(service.reconstructPath(strategyId)).toEqual([
      "StrategyRecommended",
      "StrategySnapshotted",
      "StrategyExecuted",
    ]);
  });
});

// ------------------------------------------------------------------
// isTraceable
// ------------------------------------------------------------------

describe("isTraceable", () => {
  it("returns false for an unknown strategy", () => {
    expect(service.isTraceable("ghost")).toBe(false);
  });

  it("returns false when only StrategyRecommended is recorded (no terminal event)", () => {
    service.recordEvent(recommended);

    expect(service.isTraceable(strategyId)).toBe(false);
  });

  it("returns false when StrategyExecuted exists but no StrategyRecommended", () => {
    service.recordEvent(executed);

    expect(service.isTraceable(strategyId)).toBe(false);
  });

  it("returns true for a complete successful path (recommended → ... → executed)", () => {
    service.recordEvent(recommended);
    service.recordEvent(queued);
    service.recordEvent(riskChecked);
    service.recordEvent(executed);

    expect(service.isTraceable(strategyId)).toBe(true);
  });

  it("returns true for a complete blocked path (recommended → risk-checked → blocked)", () => {
    service.recordEvent(recommended);
    service.recordEvent(riskChecked);
    service.recordEvent(blocked);

    expect(service.isTraceable(strategyId)).toBe(true);
  });

  it("returns true when both Executed and Blocked are present (edge case — re-run scenario)", () => {
    service.recordEvent(recommended);
    service.recordEvent(blocked);
    service.recordEvent(recommended);
    service.recordEvent(executed);

    expect(service.isTraceable(strategyId)).toBe(true);
  });
});

// ------------------------------------------------------------------
// listTrackedStrategies
// ------------------------------------------------------------------

describe("listTrackedStrategies", () => {
  it("returns empty list when no events recorded", () => {
    expect(service.listTrackedStrategies()).toHaveLength(0);
  });

  it("returns all tracked strategy IDs", () => {
    service.recordEvent({ ...recommended, strategyId: "strat-X" });
    service.recordEvent({ ...recommended, strategyId: "strat-Y" });

    const ids = service.listTrackedStrategies();
    expect(ids).toHaveLength(2);
    expect(ids).toContain("strat-X");
    expect(ids).toContain("strat-Y");
  });
});

// ------------------------------------------------------------------
// reset
// ------------------------------------------------------------------

describe("reset", () => {
  it("clears all recorded events", () => {
    service.recordEvent(recommended);
    service.reset();

    expect(service.getHistory(strategyId)).toHaveLength(0);
    expect(service.listTrackedStrategies()).toHaveLength(0);
  });
});
