/**
 * Tests for the admin-only vault registry update workflow.
 *
 * Covers:
 *  - GET /api/admin/vaults/registry — lists current registry entries
 *  - POST /api/admin/vaults/:vaultId/registry — admin can update, non-admin cannot
 *  - Updates are captured by the audit trail
 *  - Invalid input is rejected with 400
 */

import request from "supertest";
import { createApp } from "../app";
import { resetAuditLog, getAuditLogs } from "../middleware/audit";

jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([]),
  getYieldDataWithCacheStatus: jest.fn().mockResolvedValue({
    data: [],
    cacheStatus: "MISS",
  }),
}));

jest.mock("../services/freezeService", () => ({
  freezeService: { isFrozen: jest.fn().mockReturnValue(false) },
}));

const app = createApp();
const ADMIN_TOKEN = "Bearer mock-admin-token";
const USER_TOKEN = "Bearer mock-user-token";

beforeEach(() => {
  resetAuditLog();
});

describe("GET /api/admin/vaults/registry", () => {
  it("returns the current registry entries for an admin", async () => {
    const res = await request(app)
      .get("/api/admin/vaults/registry")
      .set("Authorization", ADMIN_TOKEN);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.vaults)).toBe(true);
    expect(res.body.vaults.some((v: { vaultId: string }) => v.vaultId === "usdc")).toBe(true);
  });

  it("rejects a non-admin caller (403)", async () => {
    const res = await request(app)
      .get("/api/admin/vaults/registry")
      .set("Authorization", USER_TOKEN);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/admin/vaults/:vaultId/registry", () => {
  it("applies an update as an admin and returns the updated entry", async () => {
    const res = await request(app)
      .post("/api/admin/vaults/usdc/registry")
      .set("Authorization", ADMIN_TOKEN)
      .send({ status: "PAUSED" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.vault.status).toBe("PAUSED");
    expect(res.body.vault.updatedBy).toBe("admin-123");
  });

  it("rejects a non-admin caller (403) without applying the change", async () => {
    const res = await request(app)
      .post("/api/admin/vaults/usdc/registry")
      .set("Authorization", USER_TOKEN)
      .send({ status: "PAUSED" });

    expect(res.status).toBe(403);

    const check = await request(app)
      .get("/api/admin/vaults/registry")
      .set("Authorization", ADMIN_TOKEN);
    const usdc = check.body.vaults.find((v: { vaultId: string }) => v.vaultId === "usdc");
    expect(usdc.status).not.toBe("PAUSED");
  });

  it("rejects an invalid status with 400", async () => {
    const res = await request(app)
      .post("/api/admin/vaults/usdc/registry")
      .set("Authorization", ADMIN_TOKEN)
      .send({ status: "NOT_A_STATUS" });

    expect(res.status).toBe(400);
  });

  it("records the update in the audit trail", async () => {
    await request(app)
      .post("/api/admin/vaults/usdc/registry")
      .set("Authorization", ADMIN_TOKEN)
      .send({ status: "DEPRECATED" });

    const logs = await getAuditLogs({ action: "UPDATE_VAULT_REGISTRY" });
    const entry = logs[0];
    expect(entry).toBeDefined();
    expect(entry?.resourceId).toBe("usdc");
    expect(entry?.hash).toBeDefined();
  });
});
