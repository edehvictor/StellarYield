/**
 * Tests for admin audit confirmation / cancellation flows.
 *
 * Covers:
 *  - POST /api/admin/confirm  — successful admin action creates an audit record
 *  - POST /api/admin/cancel   — cancelled action creates a record with no changes
 *  - Audit logs are filterable by action type (ADMIN_ACTION_CONFIRMED / CANCELLED)
 *  - Cancelled records do NOT carry a changes field
 *  - confirmationText is stored on confirmed records
 *  - Input validation rejects missing required fields
 *  - Auth guard rejects non-admin callers
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

// ── Helpers ───────────────────────────────────────────────────────────────

function confirmReq(body: Record<string, unknown>) {
  return request(app)
    .post("/api/admin/confirm")
    .set("Authorization", ADMIN_TOKEN)
    .send(body);
}

function cancelReq(body: Record<string, unknown>) {
  return request(app)
    .post("/api/admin/cancel")
    .set("Authorization", ADMIN_TOKEN)
    .send(body);
}

// ── Setup / teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  resetAuditLog();
});

// ── Auth guard ────────────────────────────────────────────────────────────

describe("auth guard", () => {
  it("rejects /confirm without a token (403)", async () => {
    const res = await request(app)
      .post("/api/admin/confirm")
      .send({ actionType: "X", resource: "Y", confirmationText: "ok" });
    expect(res.status).toBe(403);
  });

  it("rejects /confirm with a non-admin token (403)", async () => {
    const res = await request(app)
      .post("/api/admin/confirm")
      .set("Authorization", USER_TOKEN)
      .send({ actionType: "X", resource: "Y", confirmationText: "ok" });
    expect(res.status).toBe(403);
  });

  it("rejects /cancel without a token (403)", async () => {
    const res = await request(app)
      .post("/api/admin/cancel")
      .send({ actionType: "X", resource: "Y" });
    expect(res.status).toBe(403);
  });
});

// ── POST /api/admin/confirm ───────────────────────────────────────────────

describe("POST /api/admin/confirm", () => {
  it("returns 200 and creates an audit record for a successful confirmation", async () => {
    const res = await confirmReq({
      actionType: "UPDATE_TREASURY_FEE",
      resource: "TREASURY",
      resourceId: "treasury-1",
      confirmationText: "I confirm changing the fee from 10 bps to 15 bps.",
      changes: { feeBps: 15 },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.auditId).toBe("string");
    expect(typeof res.body.timestamp).toBe("string");
  });

  it("stores the audit record with action ADMIN_ACTION_CONFIRMED", async () => {
    await confirmReq({
      actionType: "UPDATE_GOVERNANCE_PARAM",
      resource: "GOVERNANCE",
      confirmationText: "Confirm governance update.",
    });

    const logs = await getAuditLogs({ action: "ADMIN_ACTION_CONFIRMED" });
    expect(logs.length).toBe(1);
    expect(logs[0].action).toBe("ADMIN_ACTION_CONFIRMED");
  });

  it("stores the confirmationText on the audit record", async () => {
    const text = "I confirm updating campaign budget to $5000.";
    await confirmReq({
      actionType: "UPDATE_CAMPAIGN",
      resource: "CAMPAIGN",
      resourceId: "camp-42",
      confirmationText: text,
      changes: { budget: 5000 },
    });

    const logs = await getAuditLogs({ action: "ADMIN_ACTION_CONFIRMED" });
    expect(logs[0].confirmationText).toBe(text);
  });

  it("stores the changes payload on the audit record", async () => {
    await confirmReq({
      actionType: "UPDATE_PROTOCOL_PARAM",
      resource: "PROTOCOL",
      confirmationText: "Confirm.",
      changes: { maxTvl: 1_000_000 },
    });

    const logs = await getAuditLogs({ action: "ADMIN_ACTION_CONFIRMED" });
    expect(logs[0].changes).toEqual({ maxTvl: 1_000_000 });
  });

  it("stores the resourceId when provided", async () => {
    await confirmReq({
      actionType: "UPDATE_TREASURY_FEE",
      resource: "TREASURY",
      resourceId: "vault-xyz",
      confirmationText: "Confirm.",
    });

    const logs = await getAuditLogs({ action: "ADMIN_ACTION_CONFIRMED" });
    expect(logs[0].resourceId).toBe("vault-xyz");
  });

  it("does NOT set cancelled=true on a confirmed record", async () => {
    await confirmReq({
      actionType: "UPDATE_TREASURY_FEE",
      resource: "TREASURY",
      confirmationText: "Confirm.",
    });

    const logs = await getAuditLogs({ action: "ADMIN_ACTION_CONFIRMED" });
    expect(logs[0].cancelled).toBeUndefined();
  });

  it("returns 400 when actionType is missing", async () => {
    const res = await confirmReq({
      resource: "TREASURY",
      confirmationText: "Confirm.",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when resource is missing", async () => {
    const res = await confirmReq({
      actionType: "UPDATE_TREASURY_FEE",
      confirmationText: "Confirm.",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when confirmationText is missing", async () => {
    const res = await confirmReq({
      actionType: "UPDATE_TREASURY_FEE",
      resource: "TREASURY",
    });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/admin/cancel ────────────────────────────────────────────────

describe("POST /api/admin/cancel", () => {
  it("returns 200 and creates an audit record for a cancellation", async () => {
    const res = await cancelReq({
      actionType: "UPDATE_TREASURY_FEE",
      resource: "TREASURY",
      cancellationReason: "Admin changed mind.",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.auditId).toBe("string");
  });

  it("stores the audit record with action ADMIN_ACTION_CANCELLED", async () => {
    await cancelReq({
      actionType: "UPDATE_GOVERNANCE_PARAM",
      resource: "GOVERNANCE",
    });

    const logs = await getAuditLogs({ action: "ADMIN_ACTION_CANCELLED" });
    expect(logs.length).toBe(1);
    expect(logs[0].action).toBe("ADMIN_ACTION_CANCELLED");
  });

  it("sets cancelled=true on the record", async () => {
    await cancelReq({
      actionType: "UPDATE_TREASURY_FEE",
      resource: "TREASURY",
    });

    const logs = await getAuditLogs({ action: "ADMIN_ACTION_CANCELLED" });
    expect(logs[0].cancelled).toBe(true);
  });

  it("does NOT store a changes field on a cancelled record", async () => {
    await cancelReq({
      actionType: "UPDATE_PROTOCOL_PARAM",
      resource: "PROTOCOL",
      cancellationReason: "Decided against it.",
    });

    const logs = await getAuditLogs({ action: "ADMIN_ACTION_CANCELLED" });
    expect(logs[0].changes).toBeUndefined();
  });

  it("stores the cancellationReason in confirmationText prefixed with CANCELLED:", async () => {
    await cancelReq({
      actionType: "UPDATE_CAMPAIGN",
      resource: "CAMPAIGN",
      cancellationReason: "Budget not approved.",
    });

    const logs = await getAuditLogs({ action: "ADMIN_ACTION_CANCELLED" });
    expect(logs[0].confirmationText).toMatch(/CANCELLED:/);
    expect(logs[0].confirmationText).toMatch(/Budget not approved/);
  });

  it("returns 400 when actionType is missing", async () => {
    const res = await cancelReq({ resource: "TREASURY" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when resource is missing", async () => {
    const res = await cancelReq({ actionType: "UPDATE_TREASURY_FEE" });
    expect(res.status).toBe(400);
  });
});

// ── Filter by action type ─────────────────────────────────────────────────

describe("GET /api/admin/audit-logs — filter by action type", () => {
  beforeEach(async () => {
    // Seed one confirmed and one cancelled record
    await confirmReq({
      actionType: "UPDATE_TREASURY_FEE",
      resource: "TREASURY",
      confirmationText: "Confirm.",
    });
    await cancelReq({
      actionType: "UPDATE_GOVERNANCE_PARAM",
      resource: "GOVERNANCE",
      cancellationReason: "Reverted.",
    });
  });

  it("returns only ADMIN_ACTION_CONFIRMED when filtered by that action", async () => {
    const res = await request(app)
      .get("/api/admin/audit-logs?action=ADMIN_ACTION_CONFIRMED")
      .set("Authorization", ADMIN_TOKEN);

    expect(res.status).toBe(200);
    const entries = res.body.data as Array<{ action: string }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.action === "ADMIN_ACTION_CONFIRMED")).toBe(true);
  });

  it("returns only ADMIN_ACTION_CANCELLED when filtered by that action", async () => {
    const res = await request(app)
      .get("/api/admin/audit-logs?action=ADMIN_ACTION_CANCELLED")
      .set("Authorization", ADMIN_TOKEN);

    expect(res.status).toBe(200);
    const entries = res.body.data as Array<{ action: string }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.action === "ADMIN_ACTION_CANCELLED")).toBe(true);
  });

  it("returns both types when no action filter is applied", async () => {
    const res = await request(app)
      .get("/api/admin/audit-logs")
      .set("Authorization", ADMIN_TOKEN);

    expect(res.status).toBe(200);
    const actions = (res.body.data as Array<{ action: string }>).map(
      (e) => e.action,
    );
    expect(actions).toContain("ADMIN_ACTION_CONFIRMED");
    expect(actions).toContain("ADMIN_ACTION_CANCELLED");
  });

  it("returns empty data when filtering by an action that produced no records", async () => {
    const res = await request(app)
      .get("/api/admin/audit-logs?action=NONEXISTENT_ACTION")
      .set("Authorization", ADMIN_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});
