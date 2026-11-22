/**
 * Regression tests for GET /api/yields — stale configuration snapshot handling.
 *
 * Covers:
 *  - Normal operation: response includes X-Config-Version header with a
 *    non-empty SHA-256 hex string.
 *  - Stale data: entries whose reliability score is below 0.5 freshness are
 *    flagged with isStale=true and carry a human-readable warning.
 *  - Failure safety: when the yield service throws, existing state is
 *    preserved (no crash, error response does not echo internal details).
 *  - Config fingerprint stability: X-Config-Version is deterministic across
 *    consecutive calls to the same live configuration.
 */

import express from "express";
import request from "supertest";
import yieldsRouter from "../routes/yields";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetYieldDataWithCacheStatus = jest.fn();
const mockCalculateReliabilityScore = jest.fn();
const mockCalculateNetYield = jest.fn();
const mockGetFeeHistory = jest.fn();
const mockGetAssetConfigVersion = jest.fn(() => "deadbeef".repeat(8)); // 64-char hex

jest.mock("../services/yieldService", () => ({
  getYieldDataWithCacheStatus: (...args: unknown[]) =>
    mockGetYieldDataWithCacheStatus(...args),
  getYieldParityReport: jest.fn().mockResolvedValue({
    inParity: true,
    feed: [],
    summary: { positions: [] },
  }),
  CURRENT_YIELDS_TTL_SECONDS: 300,
}));

jest.mock("../services/yieldReliabilityService", () => ({
  yieldReliabilityEngine: {
    calculateReliabilityScore: (...args: unknown[]) =>
      mockCalculateReliabilityScore(...args),
  },
}));

jest.mock("../services/netYieldEngine", () => ({
  calculateNetYield: (...args: unknown[]) => mockCalculateNetYield(...args),
}));

jest.mock("../services/protocolFeeHistoryService", () => ({
  getFeeHistory: (...args: unknown[]) => mockGetFeeHistory(...args),
}));

jest.mock("../services/zapQuote", () => ({
  getAssetConfigVersion: () => mockGetAssetConfigVersion(),
}));

jest.mock("../services/opportunityRankingService", () => ({
  OpportunityRankingService: {
    rankOpportunities: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock("../utils/yieldNormalization", () => ({
  formatParityReport: jest.fn(() => ({ summary: "ok" })),
}));

// ── Test app ──────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/yields", yieldsRouter);
  return app;
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

function freshReliabilityScore(overrides: Record<string, unknown> = {}) {
  return {
    status: "high",
    metrics: { freshness: 0.95 },
    signals: {
      lastSuccessfulFetch: new Date(Date.now() - 60_000).toISOString(),
    },
    ...overrides,
  };
}

function staleReliabilityScore() {
  return {
    status: "medium",
    metrics: { freshness: 0.3 },
    signals: {
      // 35 minutes ago — beyond the 30-minute stale window
      lastSuccessfulFetch: new Date(Date.now() - 35 * 60_000).toISOString(),
    },
  };
}

function mockYieldEntry(name: string) {
  return {
    protocolName: name,
    totalApy: 5.5,
    apy: 5.0,
    rewardApy: 0.5,
    netApy: 4.8,
    tvl: 1_000_000,
    source: "api",
    fetchedAt: new Date().toISOString(),
    managementFeeBps: 50,
    performanceFeeBps: 10,
  };
}

function defaultNetYield() {
  return {
    netApy: 4.8,
    feeDragApy: 0.2,
    assumptions: {},
    sensitivity: {},
    feeAttribution: {},
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/yields — config fingerprint header", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCalculateNetYield.mockReturnValue(defaultNetYield());
    mockGetFeeHistory.mockReturnValue([]);
  });

  it("includes a non-empty X-Config-Version header on a successful response", async () => {
    mockGetYieldDataWithCacheStatus.mockResolvedValue({
      data: [mockYieldEntry("Blend")],
      cacheStatus: "HIT",
    });
    mockCalculateReliabilityScore.mockResolvedValue(freshReliabilityScore());

    const app = buildApp();
    const res = await request(app).get("/api/yields");

    expect(res.status).toBe(200);
    expect(res.headers["x-config-version"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("X-Config-Version is the same value across two consecutive calls to the same config", async () => {
    mockGetYieldDataWithCacheStatus.mockResolvedValue({
      data: [mockYieldEntry("Soroswap")],
      cacheStatus: "HIT",
    });
    mockCalculateReliabilityScore.mockResolvedValue(freshReliabilityScore());

    const app = buildApp();
    const res1 = await request(app).get("/api/yields");
    const res2 = await request(app).get("/api/yields");

    expect(res1.headers["x-config-version"]).toBe(res2.headers["x-config-version"]);
  });
});

describe("GET /api/yields — normal operation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCalculateNetYield.mockReturnValue(defaultNetYield());
    mockGetFeeHistory.mockReturnValue([]);
  });

  it("returns 200 with an array payload", async () => {
    mockGetYieldDataWithCacheStatus.mockResolvedValue({
      data: [mockYieldEntry("Blend")],
      cacheStatus: "HIT",
    });
    mockCalculateReliabilityScore.mockResolvedValue(freshReliabilityScore());

    const res = await request(buildApp()).get("/api/yields");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it("sets isStale=false and no staleness warning for a fresh entry", async () => {
    mockGetYieldDataWithCacheStatus.mockResolvedValue({
      data: [mockYieldEntry("Blend")],
      cacheStatus: "MISS",
    });
    mockCalculateReliabilityScore.mockResolvedValue(freshReliabilityScore());

    const res = await request(buildApp()).get("/api/yields");

    expect(res.body[0].isStale).toBe(false);
    const staleWarning = (res.body[0].warnings as string[]).find((w: string) =>
      w.includes("stale"),
    );
    expect(staleWarning).toBeUndefined();
  });

  it("forwards the X-Cache-Status header from the yield service", async () => {
    mockGetYieldDataWithCacheStatus.mockResolvedValue({
      data: [],
      cacheStatus: "HIT",
    });

    const res = await request(buildApp()).get("/api/yields");

    expect(res.headers["x-cache-status"]).toBe("HIT");
  });
});

describe("GET /api/yields — stale data handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCalculateNetYield.mockReturnValue(defaultNetYield());
    mockGetFeeHistory.mockReturnValue([]);
  });

  it("sets isStale=true when freshness score is below 0.5", async () => {
    mockGetYieldDataWithCacheStatus.mockResolvedValue({
      data: [mockYieldEntry("Blend")],
      cacheStatus: "HIT",
    });
    mockCalculateReliabilityScore.mockResolvedValue(staleReliabilityScore());

    const res = await request(buildApp()).get("/api/yields");

    expect(res.status).toBe(200);
    expect(res.body[0].isStale).toBe(true);
  });

  it("includes a human-readable stale warning when isStale=true", async () => {
    mockGetYieldDataWithCacheStatus.mockResolvedValue({
      data: [mockYieldEntry("Blend")],
      cacheStatus: "HIT",
    });
    mockCalculateReliabilityScore.mockResolvedValue(staleReliabilityScore());

    const res = await request(buildApp()).get("/api/yields");

    const warnings = res.body[0].warnings as string[];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.toLowerCase().includes("stale"))).toBe(true);
  });

  it("sets isStale=true when last fetch was more than 30 minutes ago", async () => {
    mockGetYieldDataWithCacheStatus.mockResolvedValue({
      data: [mockYieldEntry("Phoenix")],
      cacheStatus: "HIT",
    });
    // Freshness metric is fine but fetch time is old
    mockCalculateReliabilityScore.mockResolvedValue(
      freshReliabilityScore({
        signals: {
          lastSuccessfulFetch: new Date(Date.now() - 35 * 60_000).toISOString(),
        },
      }),
    );

    const res = await request(buildApp()).get("/api/yields");

    expect(res.body[0].isStale).toBe(true);
  });

  it("preserves existing APY and balance fields even when the entry is stale", async () => {
    const entry = mockYieldEntry("Blend");
    mockGetYieldDataWithCacheStatus.mockResolvedValue({
      data: [entry],
      cacheStatus: "HIT",
    });
    mockCalculateReliabilityScore.mockResolvedValue(staleReliabilityScore());

    const res = await request(buildApp()).get("/api/yields");

    // Core yield data must survive unchanged even though isStale=true
    expect(res.body[0].protocolName).toBe("Blend");
    expect(res.body[0].totalApy).toBe(entry.totalApy);
    expect(res.body[0].tvl).toBe(entry.tvl);
  });
});

describe("GET /api/yields — failure safety", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 500 and does not expose internal error details when yield service throws", async () => {
    mockGetYieldDataWithCacheStatus.mockRejectedValue(
      new Error("DB connection lost — internal detail"),
    );

    const res = await request(buildApp()).get("/api/yields");

    expect(res.status).toBe(500);
    // The raw internal error message must not leak to the client
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("DB connection lost");
  });
});
