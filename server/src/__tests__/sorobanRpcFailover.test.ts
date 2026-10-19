import request from "supertest";
import { createApp } from "../app";
import {
  SorobanRpcFailoverService,
  SorobanRpcFailoverError,
} from "../services/sorobanRpcFailoverService";
import {
  SorobanRpcAlertService,
  type SorobanRpcAlert,
} from "../services/sorobanRpcAlertService";
import {
  sorobanRpcFailoverCounter,
  sorobanRpcEndpointStatusGauge,
} from "../monitoring/prometheus";

describe("Soroban RPC Failover Service & Alert Hooks", () => {
  let failoverService: SorobanRpcFailoverService;
  let alertService: SorobanRpcAlertService;

  const mockEndpoints = {
    primaryUrl: "https://rpc-primary.stellar.org",
    fallbackUrls: [
      "https://rpc-secondary.stellar.org",
      "https://rpc-tertiary.stellar.org",
    ],
    failureThreshold: 2,
    timeoutMs: 100,
  };

  beforeEach(() => {
    alertService = new SorobanRpcAlertService(10_000);
    failoverService = new SorobanRpcFailoverService(mockEndpoints);
  });

  describe("Main path execution", () => {
    it("successfully executes operation on primary endpoint and tracks healthy metrics", async () => {
      const mockResult = { networkPassphrase: "Test SDF Network" };
      const operation = jest.fn().mockResolvedValue(mockResult);

      const result = await failoverService.executeWithFailover(operation);

      expect(result).toEqual(mockResult);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(failoverService.getActiveEndpoint()).toBe(mockEndpoints.primaryUrl);
      expect(failoverService.getActivePriority()).toBe(0);

      const endpoints = failoverService.getEndpoints();
      const primary = endpoints.find((e) => e.url === mockEndpoints.primaryUrl);
      expect(primary?.status).toBe("healthy");
      expect(primary?.consecutiveFailures).toBe(0);
      expect(primary?.totalRequests).toBe(1);
      expect(primary?.totalSuccesses).toBe(1);
      expect(failoverService.getTotalFailovers()).toBe(0);
    });
  });

  describe("Edge Case 1: Primary endpoint outage with automatic failover", () => {
    it("fails over to secondary endpoint when primary fails and emits alert hook", async () => {
      const receivedAlerts: SorobanRpcAlert[] = [];
      alertService.registerHook("test-listener", (alert) => {
        receivedAlerts.push(alert);
      });

      // Inject custom alert service into failover service for this test
      const operation = jest
        .fn()
        .mockRejectedValueOnce(new Error("Connection refused: ECONNREFUSED"))
        .mockResolvedValueOnce({ status: "success-on-secondary" });

      const result = await failoverService.executeWithFailover(operation);

      expect(result).toEqual({ status: "success-on-secondary" });
      expect(operation).toHaveBeenCalledTimes(2);
      expect(failoverService.getActiveEndpoint()).toBe(mockEndpoints.fallbackUrls[0]);
      expect(failoverService.getActivePriority()).toBe(1);
      expect(failoverService.getTotalFailovers()).toBe(1);

      const recentFailovers = failoverService.getRecentFailovers();
      expect(recentFailovers).toHaveLength(1);
      expect(recentFailovers[0].fromEndpoint).toBe(mockEndpoints.primaryUrl);
      expect(recentFailovers[0].toEndpoint).toBe(mockEndpoints.fallbackUrls[0]);
      expect(recentFailovers[0].reason).toContain("ECONNREFUSED");
    });
  });

  describe("Edge Case 2: All endpoints down with typed error handling", () => {
    it("throws typed SorobanRpcFailoverError without raw crash and dispatches critical alert", async () => {
      const operation = jest.fn().mockRejectedValue(new Error("RPC node down 503"));

      await expect(
        failoverService.executeWithFailover(operation, { maxRetries: 3 }),
      ).rejects.toThrow(SorobanRpcFailoverError);

      try {
        await failoverService.executeWithFailover(operation, { maxRetries: 3 });
      } catch (err: unknown) {
        const rpcErr = err as SorobanRpcFailoverError;
        expect(rpcErr.name).toBe("SorobanRpcFailoverError");
        expect(rpcErr.code).toBe("ALL_SOROBAN_RPC_ENDPOINTS_DOWN");
        expect(rpcErr.message).toBe(
          "All Soroban RPC endpoints are currently unavailable. Failover exhausted.",
        );
        expect(rpcErr.endpointErrors.length).toBeGreaterThan(0);
        expect(rpcErr.retryable).toBe(true);
      }

      const snapshot = failoverService.getStatusSnapshot();
      expect(snapshot.status).toBe("all_down");
    });
  });

  describe("Edge Case 3: Primary recovery and failback", () => {
    it("probes recovered primary node and gracefully restores active traffic", async () => {
      // Manually simulate active on secondary
      await failoverService.manualFailover(
        mockEndpoints.fallbackUrls[0],
        "Testing recovery",
      );
      expect(failoverService.getActiveEndpoint()).toBe(mockEndpoints.fallbackUrls[0]);

      // Mock checkEndpointHealth on primary to return healthy
      jest.spyOn(failoverService, "checkEndpointHealth").mockResolvedValue({
        healthy: true,
        latencyMs: 42,
      });

      await failoverService.probeAndRecover();

      expect(failoverService.getActiveEndpoint()).toBe(mockEndpoints.primaryUrl);
      expect(failoverService.getActivePriority()).toBe(0);

      const endpoints = failoverService.getEndpoints();
      const primary = endpoints.find((e) => e.url === mockEndpoints.primaryUrl);
      expect(primary?.status).toBe("healthy");
      expect(primary?.lastRecoveredAt).not.toBeNull();
    });
  });

  describe("Edge Case 4: Alert Hook System & Throttling", () => {
    it("registers and unregisters alert hooks correctly", async () => {
      let callCount = 0;
      const unregister = alertService.registerHook("counter", () => {
        callCount++;
      });

      await alertService.dispatchAlert(
        {
          severity: "WARNING",
          eventType: "ENDPOINT_DEGRADED",
          message: "Degraded node",
          reason: "Slow responses",
          consecutiveFailures: 1,
          totalFailovers: 0,
        },
        true,
      );

      expect(callCount).toBe(1);

      unregister();

      await alertService.dispatchAlert(
        {
          severity: "WARNING",
          eventType: "ENDPOINT_DEGRADED",
          message: "Degraded node again",
          reason: "Slow responses",
          consecutiveFailures: 2,
          totalFailovers: 0,
        },
        true,
      );

      expect(callCount).toBe(1);
    });

    it("throttles duplicate alerts within cooldown window", async () => {
      const throttledAlertService = new SorobanRpcAlertService(60_000);
      let count = 0;
      throttledAlertService.registerHook("throttle-check", () => {
        count++;
      });

      const alertPayload = {
        severity: "HIGH" as const,
        eventType: "FAILOVER_TRIGGERED" as const,
        message: "Failover 1",
        reason: "Node unreachable",
        consecutiveFailures: 1,
        totalFailovers: 1,
        fromEndpoint: "https://rpc1.stellar.org",
      };

      const first = await throttledAlertService.dispatchAlert(alertPayload);
      const second = await throttledAlertService.dispatchAlert(alertPayload);

      expect(first).not.toBeNull();
      expect(second).toBeNull(); // Throttled
      expect(count).toBe(1);
    });
  });

  describe("API Endpoints (/api/rpc)", () => {
    const app = createApp();

    it("GET /api/rpc/status returns full status snapshot", async () => {
      const res = await request(app).get("/api/rpc/status");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("activeEndpoint");
      expect(res.body).toHaveProperty("endpoints");
      expect(res.body).toHaveProperty("totalFailovers");
      expect(res.body).toHaveProperty("recentFailovers");
      expect(res.body).toHaveProperty("recentAlerts");
      expect(Array.isArray(res.body.endpoints)).toBe(true);
    });

    it("GET /api/rpc/health returns 200 and healthy", async () => {
      const res = await request(app).get("/api/rpc/health");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status");
      expect(res.body).toHaveProperty("activeEndpoint");
    });

    it("POST /api/rpc/failover triggers manual failover", async () => {
      const res = await request(app)
        .post("/api/rpc/failover")
        .send({ reason: "Integration test manual switch" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty("activeEndpoint");
      expect(res.body).toHaveProperty("previousEndpoint");
    });

    it("POST /api/rpc/reset resets failover metrics", async () => {
      const res = await request(app).post("/api/rpc/reset");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.snapshot.totalFailovers).toBe(0);
    });

    it("GET /api/rpc/alerts returns alert history list", async () => {
      const res = await request(app).get("/api/rpc/alerts");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("alerts");
      expect(res.body).toHaveProperty("total");
    });
  });
});
