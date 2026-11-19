/**
 * Strategy Comparison Configuration Snapshot & Fingerprint Route Tests (#1918)
 *
 * Validates:
 * 1. GET /api/strategies/config-snapshot returns the active immutable configuration fingerprint.
 * 2. POST /api/strategies/compare verifies fingerprints and rejects stale snapshots with 409 STALE_STRATEGY_CONFIG.
 * 3. GET /api/strategies/leaderboard invalidates cache when the active configuration changes.
 * 4. GET /api/yields stamps responses with X-Strategy-Config-Fingerprint and rejects stale fingerprints.
 * 5. State and balances are preserved on failure; safe retry succeeds with refreshed fingerprint.
 */
import request from "supertest";
import express from "express";

// Mock services that router touches
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
jest.mock("../services/protocolFailoverService", () => ({
  failoverRegistry: {
    apply: jest.fn((strategies) => ({
      included: strategies,
      excluded: [],
      evaluations: [],
      decisions: [],
    })),
    excludedProtocols: jest.fn(() => []),
    recentDecisions: jest.fn(() => []),
  },
}));
jest.mock("../services/yieldReliabilityService", () => ({
  yieldReliabilityEngine: {
    calculateReliabilityScore: jest.fn(() =>
      Promise.resolve({
        status: "healthy",
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

import strategiesRouter, {
  setActiveComparisonConfig,
  resetActiveComparisonConfig,
  getActiveComparisonConfig,
} from "../routes/strategies";
import yieldsRouter from "../routes/yields";
import {
  DEFAULT_STRATEGY_COMPARISON_CONFIG,
  computeStrategyComparisonConfigFingerprint,
} from "../../../shared/types/strategyComparisonConfigFingerprint";

const app = express();
app.use(express.json());
app.use("/api/strategies", strategiesRouter);
app.use("/api/yields", yieldsRouter);

describe("Strategy Comparison Configuration Hardening (#1918)", () => {
  beforeEach(() => {
    resetActiveComparisonConfig();
  });

  afterEach(() => {
    resetActiveComparisonConfig();
  });

  describe("GET /api/strategies/config-snapshot", () => {
    it("returns immutable configuration snapshot and deterministic fingerprint", async () => {
      const res = await request(app).get("/api/strategies/config-snapshot");

      expect(res.status).toBe(200);
      expect(res.headers["x-strategy-config-fingerprint"]).toBeDefined();
      expect(res.body.configFingerprint).toHaveLength(64);
      expect(res.body.shortFingerprint).toMatch(/^scf-[0-9a-f]{6}…[0-9a-f]{4}$/);
      expect(res.body.config).toEqual(
        expect.objectContaining({
          supportedProtocols: expect.arrayContaining(["Blend", "Soroswap", "DeFindex"]),
          schemaVersion: "1.0.0",
        }),
      );
    });
  });

  describe("POST /api/strategies/compare", () => {
    it("1. Normal operation: compares strategies successfully with matching fingerprint", async () => {
      const { fingerprint } = computeStrategyComparisonConfigFingerprint(
        DEFAULT_STRATEGY_COMPARISON_CONFIG,
      );

      const res = await request(app)
        .post("/api/strategies/compare")
        .send({
          expectedConfigFingerprint: fingerprint,
          strategyIds: ["blend", "soroswap"],
        });

      expect(res.status).toBe(200);
      expect(res.body.configFingerprint).toBe(fingerprint);
      expect(res.body.strategies).toHaveLength(2);
      expect(res.body.strategies.map((s: { id: string }) => s.id)).toEqual(["blend", "soroswap"]);
    });

    it("2. Stale rejection: rejects comparison when configuration fingerprint mismatches", async () => {
      const staleFingerprint = "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567";

      const res = await request(app)
        .post("/api/strategies/compare")
        .send({
          expectedConfigFingerprint: staleFingerprint,
          strategyIds: ["blend"],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("STALE_STRATEGY_CONFIG");
      expect(res.body.isRecoverable).toBe(true);
      expect(res.body.currentFingerprint).toBeDefined();
      expect(res.body.error).toContain("stale");
    });

    it("3. Dynamic config drift: invalidates snapshot when protocols or rules change", async () => {
      const initialFp = computeStrategyComparisonConfigFingerprint(
        DEFAULT_STRATEGY_COMPARISON_CONFIG,
      ).fingerprint;

      // Update active configuration (e.g. governance added a new protocol)
      setActiveComparisonConfig({
        ...DEFAULT_STRATEGY_COMPARISON_CONFIG,
        supportedProtocols: ["Blend", "Soroswap", "DeFindex", "Phoenix"],
      });

      const res = await request(app)
        .post("/api/strategies/compare")
        .send({
          expectedConfigFingerprint: initialFp,
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("STALE_STRATEGY_CONFIG");
      expect(res.body.currentFingerprint).not.toBe(initialFp);
    });

    it("4. Safe retry: subsequent comparison succeeds after refreshing to new fingerprint", async () => {
      const initialFp = computeStrategyComparisonConfigFingerprint(
        DEFAULT_STRATEGY_COMPARISON_CONFIG,
      ).fingerprint;

      // Drift configuration
      setActiveComparisonConfig({
        ...DEFAULT_STRATEGY_COMPARISON_CONFIG,
        schemaVersion: "1.1.0",
      });

      // Attempt 1: Fails with stale error
      const failRes = await request(app)
        .post("/api/strategies/compare")
        .send({ expectedConfigFingerprint: initialFp });
      expect(failRes.status).toBe(409);

      // Client queries fresh snapshot
      const snapshotRes = await request(app).get("/api/strategies/config-snapshot");
      const freshFp = snapshotRes.body.configFingerprint;
      expect(freshFp).not.toBe(initialFp);

      // Attempt 2: Retries with fresh fingerprint, succeeds
      const retryRes = await request(app)
        .post("/api/strategies/compare")
        .send({ expectedConfigFingerprint: freshFp });

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.configFingerprint).toBe(freshFp);
    });
  });

  describe("GET /api/strategies/leaderboard - Cache Invalidation", () => {
    it("invalidates in-memory leaderboard cache when configuration fingerprint changes", async () => {
      const res1 = await request(app).get("/api/strategies/leaderboard");
      expect(res1.status).toBe(200);
      const fp1 = res1.body.configFingerprint;

      // Change config
      setActiveComparisonConfig({
        ...DEFAULT_STRATEGY_COMPARISON_CONFIG,
        schemaVersion: "1.0.1",
      });

      const res2 = await request(app).get("/api/strategies/leaderboard");
      expect(res2.status).toBe(200);
      const fp2 = res2.body.configFingerprint;

      expect(fp1).not.toBe(fp2);
    });
  });

  describe("GET /api/yields - Header & Staleness Hardening", () => {
    it("stamps yield responses with X-Strategy-Config-Fingerprint header", async () => {
      const res = await request(app).get("/api/yields");
      expect(res.status).toBe(200);
      expect(res.headers["x-strategy-config-fingerprint"]).toBeDefined();
    });

    it("rejects request with 409 when expectedConfigFingerprint query is stale", async () => {
      const staleFp = "1111111111111111111111111111111111111111111111111111111111111111";
      const res = await request(app).get(`/api/yields?expectedConfigFingerprint=${staleFp}`);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("STALE_STRATEGY_CONFIG");
      expect(res.body.currentFingerprint).toBeDefined();
    });

    it("rejects request with 409 when if-match-config header is stale", async () => {
      const staleFp = "1111111111111111111111111111111111111111111111111111111111111111";
      const res = await request(app)
        .get("/api/yields")
        .set("if-match-config", staleFp);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("STALE_STRATEGY_CONFIG");
    });
  });
});
