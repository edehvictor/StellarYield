/**
 * Unit tests for StrategyLifecycleAuditService (#34).
 *
 * Covers:
 *  - Static helpers (generateEventId, correlationId, hashPayload)
 *  - Complete execution path
 *  - Blocked-by-oracle path
 *  - Fallback-route path
 *  - Failed execution path
 *  - Replayed history query (correlationId scoped)
 */

import { StrategyLifecycleAuditService } from "../services/strategyLifecycleAuditService";
import type {
  StrategyRecommendedEvent,
  StrategyQueuedEvent,
  StrategyRiskCheckedEvent,
  OracleDecisionRecordedEvent,
  FallbackRouteSelectedEvent,
  StrategyExecutedEvent,
  StrategyExecutionFailedEvent,
  StrategyBlockedEvent,
  StrategySnapshottedEvent,
} from "../types/strategyLifecycleEvents";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const strategyId = "strat-001";
const correlationId = "corr-test-abc123";
const actor = "optimizer-v2";
const now = new Date("2025-01-15T10:00:00Z");

function makeRecommended(overrides: Partial<StrategyRecommendedEvent> = {}): StrategyRecommendedEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    strategyId,
    correlationId,
    actor,
    timestamp: new Date(now),
    type: "StrategyRecommended",
    recommendedBy: "optimizer-v2",
    rationale: "High APY detected in Blend protocol",
    expectedApyBps: 645,
    sourceDataHash: StrategyLifecycleAuditService.hashPayload({ apyBps: 645 }),
    ...overrides,
  };
}

const recommended = makeRecommended();

const queued: StrategyQueuedEvent = {
  id: "evt-q1",
  strategyId,
  correlationId,
  actor: "queue-service",
  timestamp: new Date(now.getTime() + 1_000),
  type: "StrategyQueued",
  queueEntryId: "qe-001",
  queuePosition: 1,
  priority: "high",
};

const riskChecked: StrategyRiskCheckedEvent = {
  id: "evt-r1",
  strategyId,
  correlationId,
  actor: "risk-engine-v1",
  timestamp: new Date(now.getTime() + 2_000),
  type: "StrategyRiskChecked",
  riskScore: 42,
  passed: true,
  checkedBy: "risk-engine-v1",
};

const oracleAllow: OracleDecisionRecordedEvent = {
  id: "evt-o1",
  strategyId,
  correlationId,
  actor: "oracle-sentinel",
  timestamp: new Date(now.getTime() + 3_000),
  type: "OracleDecisionRecorded",
  assetId: "XLM",
  oracleDecision: "ALLOW",
  oracleState: "FRESH",
  deviationPct: 0.8,
  ageMs: 5_000,
  reasons: [],
};

const oracleBlock: OracleDecisionRecordedEvent = {
  ...oracleAllow,
  id: "evt-o2",
  oracleDecision: "BLOCK",
  oracleState: "DEVIATED",
  deviationPct: 7.2,
  reasons: ["Price deviation 7.20% exceeds max 5%."],
};

const fallback: FallbackRouteSelectedEvent = {
  id: "evt-f1",
  strategyId,
  correlationId,
  actor: "failover-registry",
  timestamp: new Date(now.getTime() + 4_000),
  type: "FallbackRouteSelected",
  originalProtocol: "Blend",
  fallbackProtocol: "Soroswap",
  fallbackReason: "Blend is down",
};

const executed: StrategyExecutedEvent = {
  id: "evt-e1",
  strategyId,
  correlationId,
  actor: "executor-agent",
  timestamp: new Date(now.getTime() + 4_000),
  type: "StrategyExecuted",
  executedBy: "executor-agent",
  executionDurationMs: 120,
  resultApyBps: 640,
  transactionHash: "abc123def456",
  filledPercentage: 100,
};

const executionFailed: StrategyExecutionFailedEvent = {
  id: "evt-ef1",
  strategyId,
  correlationId,
  actor: "executor-agent",
  timestamp: new Date(now.getTime() + 4_000),
  type: "StrategyExecutionFailed",
  failureClass: "TRANSIENT",
  reason: "Network timeout during submission",
  attemptNumber: 1,
  willRetry: true,
};

const blocked: StrategyBlockedEvent = {
  id: "evt-b1",
  strategyId,
  correlationId,
  actor: "risk-engine-v1",
  timestamp: new Date(now.getTime() + 4_000),
  type: "StrategyBlocked",
  reason: "Oracle price deviation exceeded threshold",
  blockedBy: "oracle-sentinel",
};

const snapshotted: StrategySnapshottedEvent = {
  id: "evt-s1",
  strategyId,
  correlationId,
  actor: "snapshot-service",
  timestamp: new Date(now.getTime() + 5_000),
  type: "StrategySnapshotted",
  snapshotId: "snap-001",
  snapshotVersion: 3,
  snapshotHash: "sha256-hash-value",
  changeReason: "Post-execution snapshot",
};

let service: StrategyLifecycleAuditService;
beforeEach(() => { service = new StrategyLifecycleAuditService(); });

// ── Static helpers ────────────────────────────────────────────────────────────

describe("static helpers", () => {
  it("generateEventId has 'evt-' prefix", () => {
    expect(StrategyLifecycleAuditService.generateEventId()).toMatch(/^evt-/);
  });

  it("generateCorrelationId has 'corr-' prefix", () => {
    expect(StrategyLifecycleAuditService.generateCorrelationId()).toMatch(/^corr-/);
  });

  it("hashPayload returns 64-char hex", () => {
    expect(StrategyLifecycleAuditService.hashPayload({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashPayload is deterministic", () => {
    const p = { apyBps: 600 };
    expect(StrategyLifecycleAuditService.hashPayload(p)).toBe(
      StrategyLifecycleAuditService.hashPayload(p),
    );
  });

  it("hashPayload differs for different inputs", () => {
    expect(StrategyLifecycleAuditService.hashPayload({ a: 1 })).not.toBe(
      StrategyLifecycleAuditService.hashPayload({ a: 2 }),
    );
  });
});

// ── recordEvent + getHistory ──────────────────────────────────────────────────

describe("recordEvent + getHistory", () => {
  it("returns [] for unknown strategy", () => {
    expect(service.getHistory("unknown")).toEqual([]);
  });

  it("records a single event", () => {
    service.recordEvent(recommended);
    expect(service.getHistory(strategyId)).toHaveLength(1);
  });

  it("preserves correlationId", () => {
    service.recordEvent(recommended);
    expect(service.getHistory(strategyId)[0].correlationId).toBe(correlationId);
  });

  it("preserves actor", () => {
    service.recordEvent(recommended);
    expect(service.getHistory(strategyId)[0].actor).toBe(actor);
  });

  it("preserves sourceDataHash", () => {
    service.recordEvent(recommended);
    expect(service.getHistory(strategyId)[0].sourceDataHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records multiple events in insertion order", () => {
    [recommended, queued, riskChecked, executed].forEach((e) => service.recordEvent(e));
    expect(service.getHistory(strategyId).map((e) => e.type)).toEqual([
      "StrategyRecommended",
      "StrategyQueued",
      "StrategyRiskChecked",
      "StrategyExecuted",
    ]);
  });

  it("isolates events by strategyId", () => {
    service.recordEvent({ ...recommended, strategyId: "A" });
    service.recordEvent({ ...recommended, strategyId: "B" });
    expect(service.getHistory("A")).toHaveLength(1);
    expect(service.getHistory("B")).toHaveLength(1);
  });

  it("getHistory returns a copy — mutations don't affect the log", () => {
    service.recordEvent(recommended);
    service.getHistory(strategyId).pop();
    expect(service.getHistory(strategyId)).toHaveLength(1);
  });
});

// ── Complete execution path ───────────────────────────────────────────────────

describe("complete execution path", () => {
  beforeEach(() => {
    [recommended, queued, riskChecked, oracleAllow, executed, snapshotted].forEach(
      (e) => service.recordEvent(e),
    );
  });

  it("reconstructPath matches insertion order", () => {
    expect(service.reconstructPath(strategyId)).toEqual([
      "StrategyRecommended",
      "StrategyQueued",
      "StrategyRiskChecked",
      "OracleDecisionRecorded",
      "StrategyExecuted",
      "StrategySnapshotted",
    ]);
  });

  it("isTraceable returns true", () => {
    expect(service.isTraceable(strategyId)).toBe(true);
  });

  it("snapshot event carries version and changeReason", () => {
    const snap = service.getHistory(strategyId).find(
      (e) => e.type === "StrategySnapshotted",
    ) as StrategySnapshottedEvent;
    expect(snap.snapshotVersion).toBe(3);
    expect(snap.changeReason).toBe("Post-execution snapshot");
  });

  it("executed event carries transactionHash and filledPercentage", () => {
    const exec = service.getHistory(strategyId).find(
      (e) => e.type === "StrategyExecuted",
    ) as StrategyExecutedEvent;
    expect(exec.transactionHash).toBe("abc123def456");
    expect(exec.filledPercentage).toBe(100);
  });
});

// ── Blocked oracle path ───────────────────────────────────────────────────────

describe("blocked oracle path", () => {
  beforeEach(() => {
    [recommended, queued, riskChecked, oracleBlock, blocked].forEach(
      (e) => service.recordEvent(e),
    );
  });

  it("reconstructPath includes OracleDecisionRecorded and StrategyBlocked", () => {
    expect(service.reconstructPath(strategyId)).toContain("OracleDecisionRecorded");
    expect(service.reconstructPath(strategyId)).toContain("StrategyBlocked");
  });

  it("isTraceable returns true (blocked is terminal)", () => {
    expect(service.isTraceable(strategyId)).toBe(true);
  });

  it("oracle block event carries deviationPct and reasons", () => {
    const ev = service.getHistory(strategyId).find(
      (e) => e.type === "OracleDecisionRecorded",
    ) as OracleDecisionRecordedEvent;
    expect(ev.oracleDecision).toBe("BLOCK");
    expect(ev.deviationPct).toBe(7.2);
    expect(ev.reasons).toContain("Price deviation 7.20% exceeds max 5%.");
  });
});

// ── Fallback route path ───────────────────────────────────────────────────────

describe("fallback route path", () => {
  beforeEach(() => {
    [recommended, queued, riskChecked, oracleBlock, fallback, executed].forEach(
      (e) => service.recordEvent(e),
    );
  });

  it("path contains FallbackRouteSelected and StrategyExecuted", () => {
    const path = service.reconstructPath(strategyId);
    expect(path).toContain("FallbackRouteSelected");
    expect(path).toContain("StrategyExecuted");
  });

  it("isTraceable returns true", () => {
    expect(service.isTraceable(strategyId)).toBe(true);
  });

  it("fallback event carries original and fallback protocol", () => {
    const ev = service.getHistory(strategyId).find(
      (e) => e.type === "FallbackRouteSelected",
    ) as FallbackRouteSelectedEvent;
    expect(ev.originalProtocol).toBe("Blend");
    expect(ev.fallbackProtocol).toBe("Soroswap");
    expect(ev.fallbackReason).toBe("Blend is down");
  });
});

// ── Failed execution path ─────────────────────────────────────────────────────

describe("failed execution path", () => {
  it("StrategyExecutionFailed alone does not make chain traceable", () => {
    [recommended, queued, riskChecked, oracleAllow, executionFailed].forEach(
      (e) => service.recordEvent(e),
    );
    expect(service.isTraceable(strategyId)).toBe(false);
  });

  it("becomes traceable once StrategyBlocked follows failed attempts", () => {
    service.recordEvent(recommended);
    service.recordEvent(executionFailed);
    service.recordEvent({ ...executionFailed, id: "evt-ef2", attemptNumber: 2, willRetry: false });
    service.recordEvent(blocked);
    expect(service.isTraceable(strategyId)).toBe(true);
  });

  it("execution failure event carries failureClass, willRetry, attemptNumber", () => {
    service.recordEvent(executionFailed);
    const ev = service.getHistory(strategyId)[0] as StrategyExecutionFailedEvent;
    expect(ev.failureClass).toBe("TRANSIENT");
    expect(ev.willRetry).toBe(true);
    expect(ev.attemptNumber).toBe(1);
  });
});

// ── Replayed history query via correlationId ──────────────────────────────────

describe("replayed history query via correlationId", () => {
  const corrA = "corr-chain-A";
  const corrB = "corr-chain-B";
  const stratA = "strat-alpha";
  const stratB = "strat-beta";

  beforeEach(() => {
    service.recordEvent({ ...recommended, strategyId: stratA, correlationId: corrA });
    service.recordEvent({ ...executed, strategyId: stratA, correlationId: corrA });
    service.recordEvent({ ...recommended, strategyId: stratB, correlationId: corrB });
    service.recordEvent({ ...blocked, strategyId: stratB, correlationId: corrB });
  });

  it("getByCorrelationId returns only matching events", () => {
    const events = service.getByCorrelationId(corrA);
    expect(events.every((e) => e.correlationId === corrA)).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("getByCorrelationId returns events in timestamp order", () => {
    service.recordEvent({
      ...riskChecked,
      strategyId: stratA,
      correlationId: corrA,
      timestamp: new Date(now.getTime() + 500),
    });
    const events = service.getByCorrelationId(corrA);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp.getTime()).toBeGreaterThanOrEqual(
        events[i - 1].timestamp.getTime(),
      );
    }
  });

  it("getByCorrelationId returns [] for unknown correlationId", () => {
    expect(service.getByCorrelationId("does-not-exist")).toEqual([]);
  });

  it("getCorrelationSummary returns correct strategyId", () => {
    expect(service.getCorrelationSummary(corrA).strategyId).toBe(stratA);
  });

  it("getCorrelationSummary marks complete chain", () => {
    expect(service.getCorrelationSummary(corrA).isComplete).toBe(true);
    expect(service.getCorrelationSummary(corrB).isComplete).toBe(true);
  });

  it("getCorrelationSummary marks incomplete chain (no terminal event)", () => {
    const corrC = "corr-chain-C";
    service.recordEvent({ ...recommended, strategyId: "strat-gamma", correlationId: corrC });
    expect(service.getCorrelationSummary(corrC).isComplete).toBe(false);
  });

  it("getCorrelationSummary path matches recorded event types in order", () => {
    expect(service.getCorrelationSummary(corrA).path).toEqual([
      "StrategyRecommended",
      "StrategyExecuted",
    ]);
  });

  it("corrA events do not bleed into corrB summary", () => {
    const summaryB = service.getCorrelationSummary(corrB);
    expect(summaryB.events.every((e) => e.correlationId === corrB)).toBe(true);
  });
});

// ── listTrackedStrategies + reset ─────────────────────────────────────────────

describe("listTrackedStrategies", () => {
  it("returns [] when empty", () => {
    expect(service.listTrackedStrategies()).toHaveLength(0);
  });

  it("returns all tracked strategy IDs", () => {
    service.recordEvent({ ...recommended, strategyId: "X" });
    service.recordEvent({ ...recommended, strategyId: "Y" });
    const ids = service.listTrackedStrategies();
    expect(ids).toContain("X");
    expect(ids).toContain("Y");
  });
});

describe("reset", () => {
  it("clears all events and tracked strategies", () => {
    service.recordEvent(recommended);
    service.reset();
    expect(service.getHistory(strategyId)).toHaveLength(0);
    expect(service.listTrackedStrategies()).toHaveLength(0);
  });
});
