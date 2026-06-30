/**
 * Route tests: GET /api/strategies/:strategyId/lifecycle (#34)
 */

import request from "supertest";
import express from "express";

// Mock all services that the strategies router imports before loading the router.
jest.mock("../services/strategyLifecycleAuditService", () => ({
  strategyLifecycleAuditService: {
    getHistory: jest.fn(),
    getCorrelationSummary: jest.fn(),
    isTraceable: jest.fn(),
  },
}));
jest.mock("../services/strategySnapshotVersioningService", () => ({
  strategySnapshotVersioningService: { previewRollback: jest.fn() },
}));
jest.mock("../services/riskAdjustedYieldService", () => ({
  rankStrategies: jest.fn(() => []),
  filterByTimeWindow: jest.fn((s: unknown[]) => s),
}));
jest.mock("../services/protocolFailoverService", () => ({
  failoverRegistry: {
    apply: jest.fn(() => ({ included: [], excluded: [], evaluations: [], decisions: [] })),
    excludedProtocols: jest.fn(() => []),
    recentDecisions: jest.fn(() => []),
  },
}));
jest.mock("../services/yieldReliabilityService", () => ({
  yieldReliabilityEngine: {
    calculateReliabilityScore: jest.fn(() =>
      Promise.resolve({
        status: "high",
        metrics: { freshness: 1, historicalUptime: 1 },
        signals: { lastSuccessfulFetch: new Date().toISOString(), consecutiveFailures: 0 },
      }),
    ),
  },
}));
jest.mock("../services/strategyRotationService", () => ({
  rotationRegistry: { current: jest.fn(() => null), recentDecisions: jest.fn(() => []) },
}));
jest.mock("../services/exportService", () => ({
  exportService: { generateSnapshotBundle: jest.fn(() => Promise.resolve({})) },
}));
jest.mock("../config/protocols", () => ({ PROTOCOLS: [] }));
jest.mock("../utils/riskScoring", () => ({ calculateRiskScore: jest.fn(() => ({ score: 5 })) }));

// eslint-disable-next-line import/first
import strategiesRouter from "../routes/strategies";

const app = express();
app.use(express.json());
app.use("/api/strategies", strategiesRouter);

const { strategyLifecycleAuditService: mockSvc } = require("../services/strategyLifecycleAuditService");

const sampleEvents = [
  {
    id: "evt-1",
    strategyId: "strat-001",
    correlationId: "corr-abc",
    actor: "optimizer",
    timestamp: new Date("2025-01-15T10:00:00Z").toISOString(),
    type: "StrategyRecommended",
    recommendedBy: "optimizer",
    rationale: "High APY",
    expectedApyBps: 600,
  },
  {
    id: "evt-2",
    strategyId: "strat-001",
    correlationId: "corr-abc",
    actor: "executor",
    timestamp: new Date("2025-01-15T10:01:00Z").toISOString(),
    type: "StrategyExecuted",
    executedBy: "executor",
    executionDurationMs: 100,
    resultApyBps: 590,
    transactionHash: "0xabc",
    filledPercentage: 100,
  },
];

beforeEach(() => jest.clearAllMocks());

describe("GET /api/strategies/:strategyId/lifecycle", () => {
  it("returns 200 with full history (no correlationId filter)", async () => {
    mockSvc.getHistory.mockReturnValue(sampleEvents);
    mockSvc.isTraceable.mockReturnValue(true);

    const res = await request(app).get("/api/strategies/strat-001/lifecycle");

    expect(res.status).toBe(200);
    expect(res.body.strategyId).toBe("strat-001");
    expect(res.body.total).toBe(2);
    expect(res.body.isTraceable).toBe(true);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(Array.isArray(res.body.path)).toBe(true);
    expect(res.body.path).toContain("StrategyRecommended");
    expect(res.body.path).toContain("StrategyExecuted");
  });

  it("scopes by correlationId when query param provided", async () => {
    mockSvc.getCorrelationSummary.mockReturnValue({
      correlationId: "corr-abc",
      strategyId: "strat-001",
      events: sampleEvents,
      path: ["StrategyRecommended", "StrategyExecuted"],
      isComplete: true,
    });
    mockSvc.isTraceable.mockReturnValue(true);

    const res = await request(app)
      .get("/api/strategies/strat-001/lifecycle?correlationId=corr-abc");

    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe("corr-abc");
    expect(res.body.isComplete).toBe(true);
    expect(mockSvc.getCorrelationSummary).toHaveBeenCalledWith("corr-abc");
  });

  it("filters correlationId results to the requested strategyId only", async () => {
    const mixedEvents = [
      ...sampleEvents,
      {
        id: "evt-x",
        strategyId: "strat-other",
        correlationId: "corr-abc",
        actor: "x",
        timestamp: new Date().toISOString(),
        type: "StrategyQueued",
        queueEntryId: "qe-x",
        queuePosition: 2,
        priority: "low",
      },
    ];
    mockSvc.getCorrelationSummary.mockReturnValue({
      correlationId: "corr-abc",
      strategyId: "strat-001",
      events: mixedEvents,
      path: [],
      isComplete: false,
    });
    mockSvc.isTraceable.mockReturnValue(false);

    const res = await request(app)
      .get("/api/strategies/strat-001/lifecycle?correlationId=corr-abc");

    expect(res.status).toBe(200);
    expect(
      res.body.events.every((e: { strategyId: string }) => e.strategyId === "strat-001"),
    ).toBe(true);
  });

  it("returns 200 with empty events for unknown strategyId", async () => {
    mockSvc.getHistory.mockReturnValue([]);
    mockSvc.isTraceable.mockReturnValue(false);

    const res = await request(app).get("/api/strategies/no-such-strategy/lifecycle");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.events).toEqual([]);
  });

  it("isTraceable flag reflects service response", async () => {
    mockSvc.getHistory.mockReturnValue(sampleEvents);
    mockSvc.isTraceable.mockReturnValue(false);

    const res = await request(app).get("/api/strategies/strat-001/lifecycle");

    expect(res.body.isTraceable).toBe(false);
  });
});
