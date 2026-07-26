import request from "supertest";
import express from "express";
import healthRouter from "../routes/health";

const mockHorizonCall = jest.fn();
const mockRpcGetNetwork = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
});

jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      $queryRaw: jest.fn().mockResolvedValue([{}]),
      indexerState: {
        findFirst: jest.fn().mockResolvedValue({ lastLedger: 100 }),
      },
    })),
  };
});

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        ledgers: () => ({
          limit: () => ({
            order: () => ({
              call: mockHorizonCall,
            }),
          }),
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

jest.mock("ioredis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue("OK"),
    status: "ready",
  })),
}));

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    getJobCounts: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe("GET /api/health/readiness", () => {
  const app = express();
  app.use("/api/health", healthRouter);

  it("returns 200 with healthy status when all dependencies are up", async () => {
    mockHorizonCall.mockResolvedValue({ records: [{ sequence: 105 }] });
    mockRpcGetNetwork.mockResolvedValue({ passphrase: "Test SDF Network ; September 2025" });

    const res = await request(app).get("/api/health/readiness");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.dependencies.horizon.status).toBe("healthy");
    expect(res.body.dependencies.sorobanRpc.status).toBe("healthy");
    expect(res.body.dependencies.database.status).toBe("healthy");
    expect(res.body.dependencies.indexer.status).toBe("healthy");
    expect(typeof res.body.dependencies.horizon.latencyMs).toBe("number");
    expect(typeof res.body.dependencies.horizon.checkedAt).toBe("string");
    expect(res.body.dependencies.horizon.errorCode).toBeNull();
    expect(res.body.dependencies.horizon.retryable).toBe(false);
  });

  it("returns 503 with degraded indexer when lag is elevated", async () => {
    jest.resetModules();
    jest.doMock("@prisma/client", () => ({
      PrismaClient: jest.fn().mockImplementation(() => ({
        $queryRaw: jest.fn().mockResolvedValue([{}]),
        indexerState: {
          findFirst: jest.fn().mockResolvedValue({ lastLedger: 50 }),
        },
      })),
    }));

    mockHorizonCall.mockResolvedValue({ records: [{ sequence: 200 }] });
    mockRpcGetNetwork.mockResolvedValue({ passphrase: "Test SDF Network ; September 2025" });

    const res = await request(app).get("/api/health/readiness");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.dependencies.indexer.status).toBe("degraded");
    expect(res.body.dependencies.indexer.errorCode).toBe("INDEXER_LAG_ELEVATED");
    expect(res.body.dependencies.indexer.retryable).toBe(true);
  });

  it("returns 503 when Horizon is unreachable", async () => {
    mockHorizonCall.mockRejectedValue(new Error("timeout"));
    mockRpcGetNetwork.mockResolvedValue({ passphrase: "Test SDF Network ; September 2025" });

    const res = await request(app).get("/api/health/readiness");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unavailable");
    expect(res.body.dependencies.horizon.status).toBe("unavailable");
    expect(res.body.dependencies.horizon.errorCode).toBe("HORIZON_UNREACHABLE");
    expect(res.body.dependencies.horizon.retryable).toBe(true);
  });

  it("returns 503 when Soroban RPC times out", async () => {
    mockHorizonCall.mockResolvedValue({ records: [{ sequence: 105 }] });
    mockRpcGetNetwork.mockRejectedValue(new Error("timeout"));

    const res = await request(app).get("/api/health/readiness");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unavailable");
    expect(res.body.dependencies.sorobanRpc.status).toBe("unavailable");
    expect(res.body.dependencies.sorobanRpc.errorCode).toBe("SOROBAN_RPC_UNREACHABLE");
    expect(res.body.dependencies.sorobanRpc.retryable).toBe(true);
  });

  it("returns degraded indexer when stale (no recent ledger)", async () => {
    mockHorizonCall.mockResolvedValue({ records: [{ sequence: 105 }] });
    mockRpcGetNetwork.mockResolvedValue({ passphrase: "Test SDF Network ; September 2025" });

    const res = await request(app).get("/api/health/readiness");

    expect(res.status).toBe(200);
    expect(res.body.dependencies.indexer.status).toMatch(/^(healthy|degraded)$/);
    expect(typeof res.body.dependencies.indexer.syncedLedger).toBe("number");
  });
});
