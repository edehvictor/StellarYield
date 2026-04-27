import request from "supertest";
import { createApp } from "../app";

// All mocks are self-contained inside the factories — jest.mock() is hoisted
// above ALL variable declarations, so any outer `const` would be in the
// temporal dead zone when the factory runs.

jest.mock("@prisma/client", () => {
  // Singleton instance: health.ts calls `new PrismaClient()` once at module
  // load, so we always return the same object and mutate it per test.
  const instance = {
    $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
    indexerState: {
      findFirst: jest.fn().mockResolvedValue({ id: "singleton", lastLedger: 1000 }),
    },
  };
  return { PrismaClient: jest.fn(() => instance) };
});

jest.mock("@stellar/stellar-sdk", () => ({
  // Networks must be present so relayer.ts (imported via app.ts) can
  // access StellarSdk.Networks.TESTNET without throwing at module load time.
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
  // Horizon.Server is instantiated per-request inside checkHorizon(), so
  // mockImplementationOnce on the constructor works fine here.
  Horizon: {
    Server: jest.fn().mockImplementation(() => ({
      ledgers: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        call: jest.fn().mockResolvedValue({ records: [{ sequence: 1010 }] }),
      }),
    })),
  },
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getNetwork: jest.fn().mockResolvedValue({ passphrase: "Test SDF Network ; September 2015" }),
    })),
  },
}));

// Helpers to reach the singleton prisma instance created at module load.
function getPrismaInstance() {
  // PrismaClient was called exactly once (by health.ts at import time).
  // mock.results[0].value is the object returned by that call.
  const { PrismaClient } = jest.requireMock("@prisma/client") as {
    PrismaClient: jest.Mock;
  };
  return PrismaClient.mock.results[0].value as {
    $queryRaw: jest.Mock;
    indexerState: { findFirst: jest.Mock };
  };
}

describe("GET /api/health", () => {
  const app = createApp();

  beforeEach(() => {
    const prisma = getPrismaInstance();
    prisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    prisma.indexerState.findFirst.mockResolvedValue({ id: "singleton", lastLedger: 1000 });

    const { Horizon, rpc } = jest.requireMock("@stellar/stellar-sdk") as {
      Horizon: { Server: jest.Mock };
      rpc: { Server: jest.Mock };
    };
    Horizon.Server.mockImplementation(() => ({
      ledgers: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        call: jest.fn().mockResolvedValue({ records: [{ sequence: 1010 }] }),
      }),
    }));
    rpc.Server.mockImplementation(() => ({
      getNetwork: jest.fn().mockResolvedValue({ passphrase: "Test SDF Network ; September 2015" }),
    }));
  });

  it("returns 200 with all components up when healthy", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.database).toBe("up");
    expect(res.body.horizon).toBe("up");
    expect(res.body.sorobanRpc).toBe("up");
    expect(res.body.indexer).toBe("up");
    expect(res.body.timestamp).toBeDefined();
  });

  it("returns 503 when database is down", async () => {
    getPrismaInstance().$queryRaw.mockRejectedValueOnce(new Error("Connection refused"));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.database).toBe("down");
  });

  it("returns 503 when horizon is unreachable", async () => {
    const { Horizon } = jest.requireMock("@stellar/stellar-sdk") as {
      Horizon: { Server: jest.Mock };
    };
    Horizon.Server.mockImplementationOnce(() => ({
      ledgers: () => ({
        limit: () => ({
          order: () => ({
            call: jest.fn().mockRejectedValue(new Error("timeout")),
          }),
        }),
      }),
    }));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.horizon).toBe("down");
  });

  it("reports indexer warning when lag exceeds threshold", async () => {
    // latestLedger = 1010 (default), syncedLedger = 900 → lag 110 > 50
    getPrismaInstance().indexerState.findFirst.mockResolvedValueOnce({
      id: "singleton",
      lastLedger: 900,
    });
    const res = await request(app).get("/api/health");
    expect(res.body.indexer).toBe("warning");
    expect(res.body.indexerLag).toBeGreaterThanOrEqual(50);
  });

  it("includes latestLedger and syncedLedger fields", async () => {
    const res = await request(app).get("/api/health");
    expect(typeof res.body.latestLedger).toBe("number");
    expect(typeof res.body.syncedLedger).toBe("number");
  });
});
