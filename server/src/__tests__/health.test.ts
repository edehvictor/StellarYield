import request from "supertest";
import express from "express";
import healthRouter from "../routes/health";

// ── Queue health mocks ──────────────────────────────────────────────────────

const mockGetJobCounts = jest.fn();
const mockQueueClose = jest.fn().mockResolvedValue(undefined);

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation((name: string) => ({
    name,
    getJobCounts: mockGetJobCounts,
    close: mockQueueClose,
  })),
}));

jest.mock("ioredis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue("OK"),
    status: "ready",
  })),
}));

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

const mockCall = jest.fn();
jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        ledgers: () => ({
          limit: () => ({
            order: () => ({
              call: mockCall
            })
          })
        })
      }))
    }
  };
});

describe("GET /api/health", () => {
  const app = express();
  app.use("/api/health", healthRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_HORIZON_TIMEOUT_MS = "100";
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 10, failed: 0, delayed: 0 });
  });

  afterEach(() => {
    delete process.env.STELLAR_HORIZON_TIMEOUT_MS;
  });

  it("returns 200 when healthy", async () => {
    mockCall.mockResolvedValue({ records: [{ sequence: 105 }] });
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.horizon).toBe("up");
  });

  it("returns 503 and degraded horizon on timeout", async () => {
    mockCall.mockImplementation(() => {
      return new Promise((resolve) => setTimeout(resolve, 200));
    });
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(503);
    expect(response.body.horizon).toBe("down");
  });
});

describe("GET /api/health/queues", () => {
  const app = express();
  app.use("/api/health", healthRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with healthy overall status when all queues are within thresholds", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 2, active: 1, completed: 50, failed: 0, delayed: 0 });

    const res = await request(app).get("/api/health/queues");

    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBe("healthy");
    expect(Array.isArray(res.body.queues)).toBe(true);
    expect(res.body.queues.length).toBe(6);
  });

  it("returns 200 with warning status when failed jobs exceed threshold", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 99, delayed: 0 });

    const res = await request(app).get("/api/health/queues");

    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBe("warning");
    for (const entry of res.body.queues) {
      expect(entry.status).toBe("warning");
      expect(entry.warnings.some((w: string) => w.includes("failed jobs"))).toBe(true);
    }
  });

  it("returns 200 with warning status when delayed jobs exceed threshold", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 99 });

    const res = await request(app).get("/api/health/queues");

    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBe("warning");
    for (const entry of res.body.queues) {
      expect(entry.warnings.some((w: string) => w.includes("delayed jobs"))).toBe(true);
    }
  });

  it("returns 503 when a queue fails to return counts", async () => {
    mockGetJobCounts.mockRejectedValue(new Error("Redis unavailable"));

    const res = await request(app).get("/api/health/queues");

    expect(res.status).toBe(503);
    expect(res.body.overallStatus).toBe("error");
    for (const entry of res.body.queues) {
      expect(entry.status).toBe("error");
    }
  });

  it("response includes all five count fields per queue entry", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 3, active: 1, completed: 20, failed: 0, delayed: 2 });

    const res = await request(app).get("/api/health/queues");

    expect(res.status).toBe(200);
    for (const entry of res.body.queues) {
      expect(typeof entry.counts.waiting).toBe("number");
      expect(typeof entry.counts.active).toBe("number");
      expect(typeof entry.counts.completed).toBe("number");
      expect(typeof entry.counts.failed).toBe("number");
      expect(typeof entry.counts.delayed).toBe("number");
    }
  });

  it("response includes a timestamp", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });

    const res = await request(app).get("/api/health/queues");

    expect(typeof res.body.timestamp).toBe("string");
    expect(new Date(res.body.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("each queue entry includes the queue name", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });

    const res = await request(app).get("/api/health/queues");

    const names = res.body.queues.map((q: { name: string }) => q.name);
    expect(names).toContain("liquidation");
    expect(names).toContain("compound");
    expect(names).toContain("rebalance-execution");
  });
});

describe("GET /api/health/startup", () => {
  const app = express();
  app.use("/api/health", healthRouter);

  const originalEnvValues: Record<string, string | undefined> = {};

  beforeAll(() => {
    originalEnvValues.NODE_ENV = process.env.NODE_ENV;
    originalEnvValues.DATABASE_URL = process.env.DATABASE_URL;
    originalEnvValues.MONGODB_URI = process.env.MONGODB_URI;
    originalEnvValues.RELAYER_SECRET_KEY = process.env.RELAYER_SECRET_KEY;
    originalEnvValues.SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL;
    originalEnvValues.STELLAR_HORIZON_URL = process.env.STELLAR_HORIZON_URL;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    const keys = ["NODE_ENV", "DATABASE_URL", "MONGODB_URI", "RELAYER_SECRET_KEY", "SOROBAN_RPC_URL", "STELLAR_HORIZON_URL"];
    for (const key of keys) {
      const val = originalEnvValues[key];
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it("returns 200 and healthy when all required env vars are set", async () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgres://localhost:5432/db";
    process.env.MONGODB_URI = "mongodb://localhost:27017/db";
    process.env.RELAYER_SECRET_KEY = "SAH2_SECRET";
    process.env.SOROBAN_RPC_URL = "https://soroban.example.com";
    process.env.STELLAR_HORIZON_URL = "https://horizon.example.com";

    const response = await request(app).get("/api/health/startup");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("healthy");
    expect(response.body.capabilities.database).toBe("operational");
    expect(response.body.capabilities.mongodb).toBe("operational");
    expect(response.body.capabilities.feeBumpRelayer).toBe("operational");
    expect(response.body.capabilities.sorobanRpc).toBe("operational");
    expect(response.body.capabilities.horizonRpc).toBe("operational");
    expect(response.body.errors).toEqual([]);
    expect(response.body.warnings).toEqual([]);
  });

  it("returns 200 and degraded in development when optional vars are missing", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.DATABASE_URL;
    delete process.env.MONGODB_URI;
    delete process.env.RELAYER_SECRET_KEY;
    delete process.env.SOROBAN_RPC_URL;
    delete process.env.STELLAR_HORIZON_URL;

    const response = await request(app).get("/api/health/startup");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("degraded");
    expect(response.body.capabilities.database).toBe("disabled");
    expect(response.body.capabilities.mongodb).toBe("disabled");
    expect(response.body.capabilities.feeBumpRelayer).toBe("disabled");
    expect(response.body.capabilities.sorobanRpc).toBe("fallback");
    expect(response.body.capabilities.horizonRpc).toBe("fallback");
    expect(response.body.warnings.length).toBeGreaterThan(0);
    expect(response.body.errors).toEqual([]);
  });

  it("returns 503 and failed in production when required vars are missing", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    delete process.env.MONGODB_URI;
    delete process.env.METRICS_TOKEN;

    const response = await request(app).get("/api/health/startup");
    expect(response.status).toBe(503);
    expect(response.body.status).toBe("failed");
    expect(response.body.errors.length).toBeGreaterThan(0);
  });
});
