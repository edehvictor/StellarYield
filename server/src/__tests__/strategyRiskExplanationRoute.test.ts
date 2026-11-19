/**
 * Route tests: GET /api/strategies/:strategyId/risk-explanation (#1416)
 */
import request from "supertest";
import express from "express";

// Mock the services the strategies router imports but this route doesn't
// touch, so the module loads without requiring their real behavior.
// PROTOCOLS and riskScoring are deliberately left real.
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

import strategiesRouter from "../routes/strategies";
import { PROTOCOLS } from "../config/protocols";

const app = express();
app.use(express.json());
app.use("/api/strategies", strategiesRouter);

describe("GET /api/strategies/:strategyId/risk-explanation", () => {
  it("main path: returns score, label, summary, and per-factor reasons for a known strategy", async () => {
    const known = PROTOCOLS[0]!.protocolName.toLowerCase();

    const res = await request(app).get(`/api/strategies/${known}/risk-explanation`);

    expect(res.status).toBe(200);
    expect(res.body.strategyId).toBe(known);
    expect(typeof res.body.score).toBe("number");
    expect(["Low", "Medium", "High"]).toContain(res.body.label);
    expect(typeof res.body.summary).toBe("string");
    expect(res.body.factors).toHaveLength(3);
    expect(res.body.breakdown).toEqual(
      expect.objectContaining({ tvl: expect.any(Number), volatility: expect.any(Number), age: expect.any(Number) }),
    );
  });

  it("edge case: matching is case-insensitive", async () => {
    const known = PROTOCOLS[0]!.protocolName;
    const res = await request(app).get(`/api/strategies/${known.toUpperCase()}/risk-explanation`);
    expect(res.status).toBe(200);
  });

  it("failure state: an unknown strategy id returns a typed 404, not a raw exception", async () => {
    const res = await request(app).get("/api/strategies/does-not-exist/risk-explanation");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("STRATEGY_NOT_FOUND");
    expect(typeof res.body.message).toBe("string");
  });
});
