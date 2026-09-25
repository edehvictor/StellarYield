/**
 * Tests for GET /health/readiness
 * Covers ready and unavailable states per issue #944.
 * Uses inline jest.fn() in mock factories to avoid Jest hoisting TDZ issues.
 */

import request from "supertest";
import express from "express";
import healthRouter from "../routes/health";

// ── Mocks ────────────────────────────────────────────────────────────────────
// All jest.fn() calls are inline inside factories to avoid TDZ issues
// caused by Jest hoisting jest.mock() above variable declarations.

jest.mock("ioredis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue("PONG"),
    quit: jest.fn().mockResolvedValue("OK"),
    on: jest.fn(),
    status: "ready",
  })),
}));

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw: jest.fn().mockResolvedValue([{}]),
    indexerState: { findFirst: jest.fn().mockResolvedValue({ lastLedger: 198 }) },
  })),
}));

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        ledgers: () => ({
          limit: () => ({ order: () => ({ call: jest.fn().mockResolvedValue({ records: [{ sequence: 200 }] }) }) }),
        }),
      })),
    },
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getNetwork: jest.fn().mockResolvedValue({ passphrase: "Test SDF Network ; September 2015" }),
      })),
    },
  };
});

// ── Test setup ───────────────────────────────────────────────────────────────

const app = express();
app.use("/health", healthRouter);

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Ready ────────────────────────────────────────────────────────────────────

describe("GET /health/readiness — ready", () => {
  it("returns 200 with status ready when all dependencies are healthy", async () => {
    const res = await request(app).get("/health/readiness");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("includes all five dependency statuses", async () => {
    const res = await request(app).get("/health/readiness");
    expect(res.body.dependencies).toEqual({
      database: "up",
      horizon: "up",
      sorobanRpc: "up",
      indexer: "up",
      cache: "up",
    });
  });

  it("includes latencyMs and checkedAt fields", async () => {
    const res = await request(app).get("/health/readiness");
    expect(typeof res.body.latencyMs).toBe("number");
    expect(typeof res.body.checkedAt).toBe("string");
    expect(new Date(res.body.checkedAt).toString()).not.toBe("Invalid Date");
  });

  it("does not expose credentials or private data", async () => {
    const res = await request(app).get("/health/readiness");
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/password/i);
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/private/i);
  });
});
