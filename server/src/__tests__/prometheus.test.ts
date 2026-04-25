/**
 * Tests for the Prometheus /metrics scrape endpoint.
 */
import request from "supertest";
import { createApp } from "../app";

// Stub heavy dependencies so tests run without real DB / Stellar
jest.mock("@prisma/client", () => {
  const mockPrisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    indexerState: { findFirst: jest.fn().mockResolvedValue({ lastLedger: 100 }) },
    vaultBalance: { count: jest.fn().mockResolvedValue(42) },
    userAlert: { findMany: jest.fn().mockResolvedValue([]) },
    $disconnect: jest.fn(),
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

// Isolate from alertsService Prisma calls
jest.mock("../services/alertsService", () => ({
  MAX_ALERTS_PER_USER: 20,
  createAlert: jest.fn(),
  listAlerts: jest.fn().mockResolvedValue([]),
  deleteAlert: jest.fn(),
  evaluateAlerts: jest.fn(),
}));

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk") as object;
  return {
    ...actual,
    Horizon: {
      Server: jest.fn(() => ({
        ledgers: () => ({
          limit: () => ({
            order: () => ({
              call: jest.fn().mockResolvedValue({ records: [{ sequence: 110 }] }),
            }),
          }),
        }),
      })),
    },
  };
});

jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([
    { protocolName: "Blend", apy: 6.5, tvl: 12_000_000, riskScore: 3, source: "stellar://blend", fetchedAt: new Date().toISOString() },
    { protocolName: "Soroswap", apy: 11.2, tvl: 4_500_000, riskScore: 5, source: "stellar://soroswap", fetchedAt: new Date().toISOString() },
  ]),
}));

describe("GET /metrics (Prometheus)", () => {
  const app = createApp();

  it("returns 404 without token in production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    delete process.env.METRICS_TOKEN;

    const res = await request(app).get("/metrics");
    expect(res.status).toBe(404);

    process.env.NODE_ENV = prev;
  });

  it("returns Prometheus text format in dev (no token required)", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    delete process.env.METRICS_TOKEN;

    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("stellaryield_tvl_usd");
    expect(res.text).toContain("stellaryield_apy_percent");
    expect(res.text).toContain("stellaryield_depositors_total");
    expect(res.text).toContain("stellaryield_db_pool_status");
    expect(res.text).toContain("stellaryield_indexer_lag_ledgers");

    process.env.NODE_ENV = prev;
  });

  it("exposes per-vault TVL labels", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    delete process.env.METRICS_TOKEN;

    const res = await request(app).get("/metrics");
    expect(res.text).toContain('vault="Blend"');
    expect(res.text).toContain('vault="Soroswap"');

    process.env.NODE_ENV = prev;
  });

  it("requires valid token when METRICS_TOKEN is set", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevToken = process.env.METRICS_TOKEN;
    process.env.NODE_ENV = "production";
    process.env.METRICS_TOKEN = "secret-token";

    const denied = await request(app).get("/metrics");
    expect(denied.status).toBe(404);

    const allowed = await request(app)
      .get("/metrics")
      .set("x-metrics-token", "secret-token");
    expect(allowed.status).toBe(200);

    process.env.NODE_ENV = prevEnv;
    if (prevToken) process.env.METRICS_TOKEN = prevToken;
    else delete process.env.METRICS_TOKEN;
  });

  it("accepts Bearer token in Authorization header", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.METRICS_TOKEN = "bearer-token";

    const res = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer bearer-token");
    expect(res.status).toBe(200);

    process.env.NODE_ENV = prevEnv;
    delete process.env.METRICS_TOKEN;
  });

  it("does not expose wallet addresses in output", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    delete process.env.METRICS_TOKEN;

    const res = await request(app).get("/metrics");
    // Stellar addresses start with G and are 56 chars — ensure none appear
    expect(res.text).not.toMatch(/G[A-Z0-9]{55}/);

    process.env.NODE_ENV = prev;
  });
});
