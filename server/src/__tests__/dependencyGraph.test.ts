import request from "supertest";
import express from "express";
import healthRouter from "../routes/health";
import {
  buildServiceDependencyGraph,
  SERVICE_TOPOLOGY,
  DEPENDENCY_EDGES_SPEC,
} from "../monitoring/dependencyGraph";
import {
  evaluateDependencyGraphAlerts,
  resetDependencyAlertState,
  getDependencyAlertHistory,
} from "../services/healthScoreChangeAlert";

// ── Mocks ────────────────────────────────────────────────────────────────────

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

const app = express();
app.use("/health", healthRouter);

describe("Service Dependency Graph Engine", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetDependencyAlertState();
    mockQueryRaw.mockResolvedValue([{}]);
    mockHorizonCall.mockResolvedValue({ records: [{ sequence: 500 }] });
    mockRpcGetNetwork.mockResolvedValue({ passphrase: "Test SDF Network ; September 2015" });
    mockIndexerFindFirst.mockResolvedValue({ lastLedger: 500 });
    mockPing.mockResolvedValue("PONG");
  });

  describe("Graph Construction & Topology", () => {
    it("includes all 7 core services in the topology", () => {
      const graph = buildServiceDependencyGraph({});
      const nodeIds = graph.nodes.map((n) => n.id);

      expect(nodeIds).toContain("database");
      expect(nodeIds).toContain("cache");
      expect(nodeIds).toContain("horizon");
      expect(nodeIds).toContain("sorobanRpc");
      expect(nodeIds).toContain("indexer");
      expect(nodeIds).toContain("queues");
      expect(nodeIds).toContain("api");
      expect(graph.nodes).toHaveLength(7);
    });

    it("correctly models dependencies and dependents for each service", () => {
      const graph = buildServiceDependencyGraph({});
      const indexerNode = graph.nodes.find((n) => n.id === "indexer");
      const dbNode = graph.nodes.find((n) => n.id === "database");
      const apiNode = graph.nodes.find((n) => n.id === "api");
      const queuesNode = graph.nodes.find((n) => n.id === "queues");

      expect(indexerNode?.dependencies).toEqual(expect.arrayContaining(["database", "horizon", "sorobanRpc"]));
      expect(dbNode?.dependents).toEqual(expect.arrayContaining(["indexer", "queues", "api"]));
      expect(queuesNode?.dependencies).toEqual(expect.arrayContaining(["cache", "database", "sorobanRpc"]));
      expect(apiNode?.dependencies).toEqual(expect.arrayContaining(["database", "cache", "horizon", "sorobanRpc", "indexer"]));
    });

    it("marks all edges as healthy when all services are up", () => {
      const graph = buildServiceDependencyGraph({});
      expect(graph.edges.length).toBeGreaterThan(0);
      for (const edge of graph.edges) {
        expect(edge.status).toBe("healthy");
      }
      expect(graph.summary.overallStatus).toBe("healthy");
      expect(graph.summary.rootCauses).toEqual([]);
      expect(graph.summary.affectedServices).toEqual([]);
    });
  });

  describe("Partial Outage: Database Down", () => {
    it("identifies database as root cause and computes downstream blast radius", () => {
      const graph = buildServiceDependencyGraph({
        database: {
          status: "down",
          errorCode: "DB_UNREACHABLE",
          hint: "Check Postgres",
        },
      });

      expect(graph.summary.overallStatus).toBe("outage");
      expect(graph.summary.rootCauses).toContain("database");

      // Transitive dependents of database: indexer, queues, api
      expect(graph.summary.blastRadius.database).toEqual(expect.arrayContaining(["indexer", "queues", "api"]));

      // Downstream nodes are marked as degraded and impacted by database
      const indexer = graph.nodes.find((n) => n.id === "indexer");
      const queues = graph.nodes.find((n) => n.id === "queues");
      const api = graph.nodes.find((n) => n.id === "api");

      expect(indexer?.isDegraded).toBe(true);
      expect(indexer?.impactedBy).toContain("database");
      expect(queues?.isDegraded).toBe(true);
      expect(queues?.impactedBy).toContain("database");
      expect(api?.isDegraded).toBe(true);
      expect(api?.impactedBy).toContain("database");

      // Edges pointing to database should be broken
      const brokenEdges = graph.edges.filter((e) => e.to === "database");
      expect(brokenEdges.length).toBeGreaterThan(0);
      for (const edge of brokenEdges) {
        expect(edge.status).toBe("broken");
      }
    });
  });

  describe("Partial Outage: Horizon Down", () => {
    it("identifies horizon as root cause affecting indexer and API", () => {
      const graph = buildServiceDependencyGraph({
        horizon: {
          status: "down",
          errorCode: "HORIZON_UNREACHABLE",
        },
      });

      expect(graph.summary.rootCauses).toEqual(["horizon"]);
      expect(graph.summary.blastRadius.horizon).toEqual(expect.arrayContaining(["indexer", "api"]));

      const indexer = graph.nodes.find((n) => n.id === "indexer");
      expect(indexer?.isDegraded).toBe(true);
      expect(indexer?.impactedBy).toContain("horizon");

      // Redis cache should NOT be affected by Horizon outage
      const cache = graph.nodes.find((n) => n.id === "cache");
      expect(cache?.isDegraded).toBe(false);
      expect(cache?.impactedBy).toEqual([]);
    });
  });

  describe("Partial Outage: Redis / Cache Down", () => {
    it("identifies cache as root cause affecting queues and API", () => {
      const graph = buildServiceDependencyGraph({
        cache: {
          status: "down",
          errorCode: "CACHE_UNREACHABLE",
        },
      });

      expect(graph.summary.rootCauses).toContain("cache");
      expect(graph.summary.blastRadius.cache).toEqual(expect.arrayContaining(["queues", "api"]));

      const queues = graph.nodes.find((n) => n.id === "queues");
      expect(queues?.isDegraded).toBe(true);
      expect(queues?.impactedBy).toContain("cache");
    });
  });

  describe("Degraded Dependency: Indexer Lag", () => {
    it("identifies indexer lag as warning without breaking upstream infrastructure", () => {
      const graph = buildServiceDependencyGraph({
        indexer: {
          status: "warning",
          errorCode: "INDEXER_LAG",
          lagLedgers: 120,
          hint: "Indexer 120 ledgers behind",
        },
      });

      expect(graph.summary.overallStatus).toBe("degraded");
      expect(graph.summary.rootCauses).toEqual(["indexer"]);
      expect(graph.summary.blastRadius.indexer).toEqual(expect.arrayContaining(["api"]));

      const db = graph.nodes.find((n) => n.id === "database");
      expect(db?.status).toBe("up");
      expect(db?.isDegraded).toBe(false);

      const edgesToIndexer = graph.edges.filter((e) => e.to === "indexer");
      for (const edge of edgesToIndexer) {
        expect(edge.status).toBe("degraded");
      }
    });
  });

  describe("Multi-Outage: Database Down AND Horizon Down", () => {
    it("handles multiple simultaneous root causes and aggregates affected services", () => {
      const graph = buildServiceDependencyGraph({
        database: { status: "down", errorCode: "DB_DOWN" },
        horizon: { status: "down", errorCode: "HORIZON_DOWN" },
      });

      expect(graph.summary.rootCauses).toEqual(expect.arrayContaining(["database", "horizon"]));
      expect(graph.summary.overallStatus).toBe("outage");

      const api = graph.nodes.find((n) => n.id === "api");
      expect(api?.impactedBy).toEqual(expect.arrayContaining(["database", "horizon"]));
    });
  });

  describe("Dependency Health Alerts", () => {
    it("generates alerts when a service transitions from up to down", () => {
      // Baseline healthy graph
      const healthyGraph = buildServiceDependencyGraph({});
      evaluateDependencyGraphAlerts(healthyGraph);

      // Transition to database down
      const outageGraph = buildServiceDependencyGraph({
        database: { status: "down", errorCode: "DB_UNREACHABLE" },
      });
      const alerts = evaluateDependencyGraphAlerts(outageGraph);

      expect(alerts.length).toBeGreaterThan(0);
      const dbAlert = alerts.find((a) => a.serviceId === "database");
      expect(dbAlert).toBeDefined();
      expect(dbAlert?.previousStatus).toBe("up");
      expect(dbAlert?.currentStatus).toBe("down");
      expect(dbAlert?.isRootCause).toBe(true);

      const history = getDependencyAlertHistory();
      expect(history.length).toBeGreaterThan(0);
    });
  });
});

describe("GET /health/graph & GET /health/dependencies integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryRaw.mockResolvedValue([{}]);
    mockHorizonCall.mockResolvedValue({ records: [{ sequence: 200 }] });
    mockRpcGetNetwork.mockResolvedValue({ passphrase: "Test SDF Network ; September 2015" });
    mockIndexerFindFirst.mockResolvedValue({ lastLedger: 200 });
    mockPing.mockResolvedValue("PONG");
  });

  it("GET /health/dependencies includes graph field in response", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("graph");
    expect(res.body.graph).toHaveProperty("nodes");
    expect(res.body.graph).toHaveProperty("edges");
    expect(res.body.graph).toHaveProperty("summary");
    expect(res.body.graph.summary.overallStatus).toBe("healthy");
  });

  it("GET /health/graph returns 200 with graph data when healthy", async () => {
    const res = await request(app).get("/health/graph");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.graph.nodes).toHaveLength(7);
    expect(res.body.graph.summary.healthyServices).toBe(7);
  });

  it("GET /health/graph returns 503 when core dependency is down", async () => {
    mockQueryRaw.mockRejectedValue(new Error("Connection refused"));
    mockIndexerFindFirst.mockRejectedValue(new Error("Connection refused"));

    const res = await request(app).get("/health/graph");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.graph.summary.rootCauses).toContain("database");
    expect(res.body.graph.summary.overallStatus).toBe("outage");
  });
});
