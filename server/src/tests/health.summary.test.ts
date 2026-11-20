/**
 * Tests for GET /health/summary (#1375)
 *
 * Covers healthy, degraded (slow DB, elevated indexer lag), and unavailable
 * states, plus latency tier classification and the indexer lag fields.
 */

import request from "supertest";
import express from "express";
import healthRouter from "../routes/health";

// ── Mocks ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-var
var mockQueryRaw = jest.fn();
// eslint-disable-next-line no-var
var mockIndexerFindFirst = jest.fn();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    indexerState: { findFirst: (...args: unknown[]) => mockIndexerFindFirst(...args) },
  })),
}));

// eslint-disable-next-line no-var
var mockHorizonCall = jest.fn();
// eslint-disable-next-line no-var
var mockRpcGetNetwork = jest.fn();
jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        ledgers: () => ({
          limit: () => ({ order: () => ({ call: mockHorizonCall }) }),
        }),
      })),
    },
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getNetwork: mockRpcGetNetwork,
      })),
    },
  };
});

// eslint-disable-next-line no-var
var mockPing = jest.fn();
jest.mock("ioredis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    ping: mockPing,
    quit: jest.fn().mockResolvedValue("OK"),
    on: jest.fn(),
    status: "ready",
  })),
}));

// ── App setup ────────────────────────────────────────────────────────────────

const app = express();
app.use("/health", healthRouter);

beforeEach(() => {
  jest.clearAllMocks();
  // Default: everything healthy
  mockQueryRaw.mockResolvedValue([{}]);
  mockHorizonCall.mockResolvedValue({ records: [{ sequence: 1000 }] });
  mockRpcGetNetwork.mockResolvedValue({ passphrase: "Test SDF Network ; September 2015" });
  mockIndexerFindFirst.mockResolvedValue({ lastLedger: 998 });
  mockPing.mockResolvedValue("PONG");
  // Remove DATABASE_URL so the DB probe doesn't short-circuit to misconfigured
  process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
});

// ── Response shape ────────────────────────────────────────────────────────────

describe("GET /health/summary — response shape", () => {
  it("returns a body with status, database, indexer, and checkedAt", async () => {
    const res = await request(app).get("/health/summary");
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("database");
    expect(res.body).toHaveProperty("indexer");
    expect(res.body).toHaveProperty("checkedAt");
  });

  it("database entry has required fields", async () => {
    const res = await request(app).get("/health/summary");
    const db = res.body.database;
    expect(db).toHaveProperty("status");
    expect(db).toHaveProperty("latencyTier");
    expect(db).toHaveProperty("checkedAt");
    expect(db).toHaveProperty("errorCode");
    expect(db).toHaveProperty("retryable");
  });

  it("indexer entry has required fields including syncedLedger and lagLedgers", async () => {
    const res = await request(app).get("/health/summary");
    const idx = res.body.indexer;
    expect(idx).toHaveProperty("status");
    expect(idx).toHaveProperty("latencyTier");
    expect(idx).toHaveProperty("checkedAt");
    expect(idx).toHaveProperty("errorCode");
    expect(idx).toHaveProperty("retryable");
    expect(idx).toHaveProperty("syncedLedger");
    expect(idx).toHaveProperty("lagLedgers");
  });
});

// ── Healthy path ──────────────────────────────────────────────────────────────

describe("GET /health/summary — healthy", () => {
  it("returns 200 with status healthy when DB and indexer are up", async () => {
    const res = await request(app).get("/health/summary");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.database.status).toBe("healthy");
    expect(res.body.indexer.status).toBe("healthy");
  });

  it("indexer lagLedgers is small when synced close to head", async () => {
    // horizon = 1000, indexer = 998 → lag = 2
    const res = await request(app).get("/health/summary");
    expect(res.body.indexer.lagLedgers).toBe(2);
    expect(res.body.indexer.syncedLedger).toBe(998);
  });

  it("latencyTier is fast for sub-millisecond mock responses", async () => {
    const res = await request(app).get("/health/summary");
    expect(res.body.database.latencyTier).toBe("fast");
    expect(res.body.indexer.latencyTier).toBe("fast");
  });
});

// ── Degraded: elevated indexer lag ───────────────────────────────────────────

describe("GET /health/summary — indexer lagging", () => {
  it("returns 200 with status degraded when indexer lag >= 50", async () => {
    // lag = 1000 - 940 = 60 → INDEXER_LAG_ELEVATED
    mockIndexerFindFirst.mockResolvedValue({ lastLedger: 940 });
    const res = await request(app).get("/health/summary");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.indexer.status).toBe("degraded");
    expect(res.body.indexer.errorCode).toBe("INDEXER_LAG_ELEVATED");
    expect(res.body.indexer.lagLedgers).toBe(60);
    expect(typeof res.body.indexer.hint).toBe("string");
    expect(res.body.indexer.hint).toMatch(/lagging/i);
  });

  it("returns 503 with status unavailable when indexer lag >= 720", async () => {
    // lag = 1000 - 200 = 800 → INDEXER_LAG_EXCESSIVE
    mockIndexerFindFirst.mockResolvedValue({ lastLedger: 200 });
    const res = await request(app).get("/health/summary");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unavailable");
    expect(res.body.indexer.errorCode).toBe("INDEXER_LAG_EXCESSIVE");
    expect(res.body.indexer.hint).toMatch(/stalled/i);
  });
});

// ── Unavailable: database down ────────────────────────────────────────────────

describe("GET /health/summary — database unavailable", () => {
  it("returns 503 with status unavailable when DB is unreachable", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));
    const res = await request(app).get("/health/summary");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unavailable");
    expect(res.body.database.status).toBe("unavailable");
    expect(res.body.database.errorCode).toBe("DB_UNREACHABLE");
    expect(res.body.database.retryable).toBe(true);
    expect(res.body.database.hint).toMatch(/database/i);
  });

  it("database misconfigured when DATABASE_URL is missing", async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const res = await request(app).get("/health/summary");
    expect(res.status).toBe(503);
    expect(res.body.database.status).toBe("unavailable");
    expect(res.body.database.errorCode).toBe("DB_MISCONFIGURED");
    process.env.DATABASE_URL = original;
  });
});

// ── Unavailable: indexer state error ──────────────────────────────────────────

describe("GET /health/summary — indexer unavailable", () => {
  it("returns 503 when indexer state query fails", async () => {
    mockIndexerFindFirst.mockRejectedValue(new Error("db error"));
    const res = await request(app).get("/health/summary");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unavailable");
    expect(res.body.indexer.status).toBe("unavailable");
    expect(res.body.indexer.errorCode).toBe("INDEXER_STATE_UNREADABLE");
    expect(res.body.indexer.retryable).toBe(true);
  });
});

// ── Both components degraded ──────────────────────────────────────────────────

describe("GET /health/summary — both degraded", () => {
  it("returns 200 with status degraded when indexer lags but DB is healthy", async () => {
    mockIndexerFindFirst.mockResolvedValue({ lastLedger: 940 }); // lag=60
    const res = await request(app).get("/health/summary");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
  });
});
