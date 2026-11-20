import request from "supertest";
import { createApp } from "../app";
import {
  dryRunRouterUpgrade,
  isValidSorobanAddress,
  sanitizeRpcError,
} from "../services/routerUpgradeService";

describe("Router Upgrade Service & API", () => {
  const app = createApp();

  const VALID_CANDIDATE = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const CURRENT_ROUTER = "CBJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJD2KM";

  describe("isValidSorobanAddress", () => {
    it("accepts valid 56-char base32 contract IDs starting with C", () => {
      expect(isValidSorobanAddress(VALID_CANDIDATE)).toBe(true);
      expect(isValidSorobanAddress(CURRENT_ROUTER)).toBe(true);
    });

    it("rejects invalid addresses", () => {
      expect(isValidSorobanAddress("")).toBe(false);
      expect(isValidSorobanAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVGUN")).toBe(false); // G address, not C
      expect(isValidSorobanAddress("C123")).toBe(false); // too short
      expect(isValidSorobanAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM123")).toBe(false); // too long
      expect(isValidSorobanAddress("invalid-string")).toBe(false);
    });
  });

  describe("sanitizeRpcError", () => {
    it("maps contract not found errors to stable CONTRACT_NOT_FOUND", () => {
      const sanitized = sanitizeRpcError(new Error("HostError: contract not found on ledger"));
      expect(sanitized.code).toBe("CONTRACT_NOT_FOUND");
      expect(sanitized.message).toContain("not found");
      expect(sanitized.remediation).toBeDefined();
    });

    it("maps missing entrypoint/method to INTERFACE_MISMATCH", () => {
      const sanitized = sanitizeRpcError(new Error("no such method 'swap' exported by contract"));
      expect(sanitized.code).toBe("INTERFACE_MISMATCH");
      expect(sanitized.message).toContain("interface");
      expect(sanitized.remediation).toContain("swap");
    });

    it("maps execution reverts/host panics to SIMULATION_REVERTED", () => {
      const sanitized = sanitizeRpcError(new Error("HostError: Error(WasmVm, Trap)"));
      expect(sanitized.code).toBe("SIMULATION_REVERTED");
      expect(sanitized.message).toContain("reverted");
      expect(sanitized.remediation).toBeDefined();
    });

    it("maps network timeouts and connection issues to RPC_UNAVAILABLE", () => {
      const sanitized = sanitizeRpcError(new Error("fetch failed: ECONNREFUSED 127.0.0.1:8000"));
      expect(sanitized.code).toBe("RPC_UNAVAILABLE");
      expect(sanitized.remediation).toContain("SOROBAN_RPC_URL");
    });
  });

  describe("dryRunRouterUpgrade service logic", () => {
    it("rejects empty candidate router address", async () => {
      const res = await dryRunRouterUpgrade({
        candidateRouterAddress: "",
      });

      expect(res.success).toBe(false);
      expect(res.status).toBe("BLOCKED");
      expect(res.error?.code).toBe("EMPTY_ADDRESS");
      expect(res.checks[0].passed).toBe(false);
    });

    it("rejects malformed contract address", async () => {
      const res = await dryRunRouterUpgrade({
        candidateRouterAddress: "not-a-valid-c-address",
      });

      expect(res.success).toBe(false);
      expect(res.status).toBe("BLOCKED");
      expect(res.error?.code).toBe("INVALID_ADDRESS_FORMAT");
      expect(res.checks.some((c) => c.id === "address_format" && !c.passed)).toBe(true);
    });

    it("rejects identical router address upgrade", async () => {
      const res = await dryRunRouterUpgrade({
        candidateRouterAddress: CURRENT_ROUTER,
        currentRouterAddress: CURRENT_ROUTER,
      });

      expect(res.success).toBe(false);
      expect(res.status).toBe("BLOCKED");
      expect(res.error?.code).toBe("IDENTICAL_ROUTER");
      expect(res.checks.some((c) => c.id === "different_address" && !c.passed)).toBe(true);
    });

    it("succeeds with mock simulation enabled", async () => {
      const res = await dryRunRouterUpgrade({
        candidateRouterAddress: VALID_CANDIDATE,
        currentRouterAddress: CURRENT_ROUTER,
        mockSimulate: true,
        testAmountStroops: "10000000",
      });

      expect(res.success).toBe(true);
      expect(res.status).toBe("READY");
      expect(res.checks.length).toBeGreaterThanOrEqual(4);
      expect(res.checks.every((c) => c.passed)).toBe(true);
      expect(res.simulation?.expectedAmountOutStroops).toBe("9800000");
      expect(res.simulation?.simulatedCpuInstructions).toBeGreaterThan(0);
      expect(res.error).toBeUndefined();
    });
  });

  describe("POST /api/router-upgrade/dry-run API endpoint", () => {
    it("returns 400 for empty address", async () => {
      const res = await request(app)
        .post("/api/router-upgrade/dry-run")
        .send({ candidateRouterAddress: "" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("EMPTY_ADDRESS");
      expect(res.body.status).toBe("BLOCKED");
    });

    it("returns 400 for invalid address format", async () => {
      const res = await request(app)
        .post("/api/router-upgrade/dry-run")
        .send({ candidateRouterAddress: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVGUN" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("INVALID_ADDRESS_FORMAT");
    });

    it("returns 400 when candidate is identical to current router", async () => {
      const res = await request(app)
        .post("/api/router-upgrade/dry-run")
        .send({
          candidateRouterAddress: CURRENT_ROUTER,
          currentRouterAddress: CURRENT_ROUTER,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("IDENTICAL_ROUTER");
    });

    it("returns 200 with READY status and simulation metrics on successful dry-run", async () => {
      const res = await request(app)
        .post("/api/router-upgrade/dry-run")
        .send({
          candidateRouterAddress: VALID_CANDIDATE,
          currentRouterAddress: CURRENT_ROUTER,
          mockSimulate: true,
          testAmountStroops: "5000000",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe("READY");
      expect(res.body.checks).toBeInstanceOf(Array);
      expect(res.body.simulation.expectedAmountOutStroops).toBe("4900000");
    });

    it("returns 400 for non-object body", async () => {
      const res = await request(app)
        .post("/api/router-upgrade/dry-run")
        .send(["not an object"]);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_REQUEST");
    });
  });

  describe("GET /api/router-upgrade/status", () => {
    it("returns router status configuration", async () => {
      const res = await request(app).get("/api/router-upgrade/status");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("activeRouterAddress");
      expect(res.body).toHaveProperty("network");
      expect(res.body).toHaveProperty("rpcConfigured");
      expect(res.body).toHaveProperty("timestamp");
    });
  });
});
