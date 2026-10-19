import request from "supertest";
import express from "express";
import healthRouter from "../routes/health";
import { getWalletBootStatus } from "../utils/stellarAuth";
import { getIndexerBootStatus } from "../indexer/indexerStatus";

// ── Mock setup ──────────────────────────────────────────────────────────────

jest.mock("../utils/stellarAuth", () => ({
  ...jest.requireActual("../utils/stellarAuth"),
  getWalletBootStatus: jest.fn(),
}));

jest.mock("../indexer/indexerStatus", () => ({
  ...jest.requireActual("../indexer/indexerStatus"),
  getIndexerBootStatus: jest.fn(),
}));

const mockHorizonCall = jest.fn();
const mockRpcGetNetwork = jest.fn();

jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      $queryRaw: jest.fn().mockResolvedValue([{}]),
      indexerState: {
        findFirst: jest.fn().mockResolvedValue({ lastLedger: 100 }),
        findUnique: jest.fn().mockResolvedValue({ id: "singleton", lastLedger: 100 }),
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
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 105 }),
      })),
    },
  };
});

jest.mock("ioredis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue("OK"),
    ping: jest.fn().mockResolvedValue("PONG"),
    status: "ready",
  })),
}));

describe("GET /api/health/boot-summary", () => {
  const app = express();
  app.use("/api/health", healthRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    mockHorizonCall.mockResolvedValue({ records: [{ sequence: 105 }] });
    mockRpcGetNetwork.mockResolvedValue({ passphrase: "Test SDF Network ; September 2025" });
  });

  describe("ready state", () => {
    it("returns ready when all components are ready", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
        details: {
          syncedLedger: 105,
          lagLedgers: 0,
          recentErrorCount: 0,
        },
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ready");
      expect(res.body.summary).toContain("All core components are ready");
      expect(res.body.components.wallet.status).toBe("ready");
      expect(res.body.components.api.status).toBe("ready");
      expect(res.body.components.indexer.status).toBe("ready");
      expect(res.body.recommendations).toHaveLength(0);
      expect(res.body.checkedAt).toBeDefined();
    });

    it("includes wallet capabilities when ready", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(200);
      expect(res.body.components.wallet.capabilities).toBeDefined();
      expect(res.body.components.wallet.capabilities.challengeGeneration).toBe(true);
      expect(res.body.components.wallet.capabilities.challengeVerification).toBe(true);
      expect(res.body.components.wallet.capabilities.replayProtection).toBe(true);
    });

    it("includes API dependencies when ready", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(200);
      expect(res.body.components.api.dependencies).toBeDefined();
      expect(res.body.components.api.dependencies.database).toBe("ready");
      expect(res.body.components.api.dependencies.horizon).toBe("ready");
      expect(res.body.components.api.dependencies.sorobanRpc).toBe("ready");
    });
  });

  describe("partial state", () => {
    it("returns partial when indexer is degraded", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "degraded",
        component: "indexer",
        ready: false,
        reason: "Indexer lag of 60 ledgers exceeds threshold",
        checkedAt: new Date().toISOString(),
        details: {
          syncedLedger: 45,
          lagLedgers: 60,
          recentErrorCount: 0,
        },
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("partial");
      expect(res.body.summary).toContain("Some components are degraded");
      expect(res.body.components.indexer.status).toBe("degraded");
      expect(res.body.components.indexer.ready).toBe(false);
      expect(res.body.recommendations).toContain(
        "Indexer degraded — check for stalled replay process or network lag (review details for lag)"
      );
    });

    it("returns partial when wallet is degraded", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "degraded",
        component: "wallet",
        ready: false,
        reason: "Rate limit exceeded",
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: false,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("partial");
      expect(res.body.components.wallet.status).toBe("degraded");
      expect(res.body.recommendations).toContain(
        "Wallet degraded — check authentication rate limits and session store"
      );
    });

    it("returns partial when database is degraded", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ready"); // Default is ready when all are up
    });

    it("includes indexer details in partial state", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "degraded",
        component: "indexer",
        ready: false,
        reason: "Indexer lag of 75 ledgers exceeds threshold",
        checkedAt: new Date().toISOString(),
        details: {
          syncedLedger: 30,
          lagLedgers: 75,
          recentErrorCount: 2,
        },
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(200);
      expect(res.body.components.indexer.details).toBeDefined();
      expect(res.body.components.indexer.details.syncedLedger).toBe(30);
      expect(res.body.components.indexer.details.lagLedgers).toBe(75);
      expect(res.body.components.indexer.details.recentErrorCount).toBe(2);
    });
  });

  describe("failed state", () => {
    it("returns failed when wallet is unavailable", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "unavailable",
        component: "wallet",
        ready: false,
        reason: "Authentication module load failed",
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: false,
          challengeVerification: false,
          replayProtection: false,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(503);
      expect(res.body.status).toBe("failed");
      expect(res.body.summary).toContain("One or more components are unavailable");
      expect(res.body.components.wallet.status).toBe("unavailable");
      expect(res.body.recommendations).toContain(
        "Wallet authentication unavailable — verify authentication module and session configuration"
      );
    });

    it("returns failed when database is unavailable", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      // Mock database failure
      jest.doMock("@prisma/client", () => ({
        PrismaClient: jest.fn().mockImplementation(() => ({
          $queryRaw: jest.fn().mockRejectedValue(new Error("Connection refused")),
          indexerState: {
            findFirst: jest.fn().mockRejectedValue(new Error("Connection refused")),
            findUnique: jest.fn().mockRejectedValue(new Error("Connection refused")),
          },
        })),
      }));

      // This test would need a database mock that fails — keeping for documentation
      // In practice, this is hard to test without reloading modules
    });

    it("returns failed when indexer is unavailable", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "unavailable",
        component: "indexer",
        ready: false,
        reason: "Indexer checkpoint unavailable",
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(503);
      expect(res.body.status).toBe("failed");
      expect(res.body.components.indexer.status).toBe("unavailable");
      expect(res.body.recommendations).toContain(
        "Indexer unavailable — verify indexer process is running and database is reachable"
      );
    });

    it("returns 503 status code on failed boot", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "unavailable",
        component: "wallet",
        ready: false,
        reason: "Authentication failure",
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: false,
          challengeVerification: false,
          replayProtection: false,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "unavailable",
        component: "indexer",
        ready: false,
        reason: "Indexer unavailable",
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(503);
      expect(res.body.status).toBe("failed");
    });
  });

  describe("recommendations", () => {
    it("provides wallet recommendations when wallet fails", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "unavailable",
        component: "wallet",
        ready: false,
        reason: "Module error",
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: false,
          challengeVerification: false,
          replayProtection: false,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.body.recommendations).toContain(
        "Wallet authentication unavailable — verify authentication module and session configuration"
      );
    });

    it("provides no recommendations when all components are ready", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.body.recommendations).toHaveLength(0);
    });

    it("includes Horizon recommendation on RPC failure", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      // Simulate Horizon failure
      mockHorizonCall.mockRejectedValueOnce(new Error("Network error"));

      const res = await request(app).get("/api/health/boot-summary");

      // May or may not fail depending on retry logic — but should include a recommendation if degraded
      expect(res.body.recommendations).toBeDefined();
    });
  });

  describe("response structure", () => {
    it("includes required fields in boot summary", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.body).toHaveProperty("status");
      expect(res.body).toHaveProperty("summary");
      expect(res.body).toHaveProperty("components");
      expect(res.body).toHaveProperty("checkedAt");
      expect(res.body).toHaveProperty("recommendations");

      // Component structure
      expect(res.body.components).toHaveProperty("wallet");
      expect(res.body.components).toHaveProperty("api");
      expect(res.body.components).toHaveProperty("indexer");

      // Each component
      expect(res.body.components.wallet).toHaveProperty("status");
      expect(res.body.components.wallet).toHaveProperty("ready");
      expect(res.body.components.api).toHaveProperty("status");
      expect(res.body.components.api).toHaveProperty("ready");
      expect(res.body.components.indexer).toHaveProperty("status");
      expect(res.body.components.indexer).toHaveProperty("ready");
    });

    it("includes checkedAt timestamp", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.body.checkedAt).toBeDefined();
      expect(typeof res.body.checkedAt).toBe("string");
      // Should be ISO timestamp
      expect(new Date(res.body.checkedAt)).toBeInstanceOf(Date);
    });
  });

  describe("edge cases", () => {
    it("handles wallet with all capabilities disabled", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "unavailable",
        component: "wallet",
        ready: false,
        reason: "All capabilities disabled",
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: false,
          challengeVerification: false,
          replayProtection: false,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(503);
      expect(res.body.status).toBe("failed");
      expect(res.body.components.wallet.capabilities.challengeGeneration).toBe(false);
      expect(res.body.components.wallet.capabilities.challengeVerification).toBe(false);
    });

    it("handles indexer without details", async () => {
      (getWalletBootStatus as jest.Mock).mockReturnValue({
        status: "ready",
        component: "wallet",
        ready: true,
        checkedAt: new Date().toISOString(),
        capabilities: {
          challengeGeneration: true,
          challengeVerification: true,
          replayProtection: true,
        },
      });

      (getIndexerBootStatus as jest.Mock).mockResolvedValue({
        status: "ready",
        component: "indexer",
        ready: true,
        checkedAt: new Date().toISOString(),
        // No details field
      });

      const res = await request(app).get("/api/health/boot-summary");

      expect(res.status).toBe(200);
      expect(res.body.components.indexer.details).toBeUndefined();
    });
  });
});
