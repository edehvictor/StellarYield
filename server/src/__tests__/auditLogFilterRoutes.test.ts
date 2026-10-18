/**
 * Route tests for audit-log filtering by wallet, action and date range (#1406).
 *
 * Mounts the real admin router (and the real audit store) behind a fake admin
 * user, so the tests cover query parsing, filtering, pagination and export
 * end to end without booting the whole app.
 */

import express, { Request, Response } from "express";
import request from "supertest";

import adminRouter from "../routes/admin";
import { createAuditEntry, resetAuditLog } from "../middleware/audit";

// Keep the JSONL append and the Prisma write out of the test run.
jest.mock("fs/promises", () => ({
  __esModule: true,
  default: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockRejectedValue(new Error("ENOENT")),
    appendFile: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock("@prisma/client", () => {
  class PrismaClient {
    criticalActionAuditLog = { create: jest.fn().mockResolvedValue({}) };
    $connect = jest.fn();
    $disconnect = jest.fn();
  }
  return { PrismaClient, Prisma: {} };
});

// A cap small enough to exercise the export-truncation path.
jest.mock("../utils/auditFilters", () => ({
  ...jest.requireActual("../utils/auditFilters"),
  AUDIT_EXPORT_MAX_ROWS: 5,
}));

const ADMIN_WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const USER_WALLET = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function buildApp(role: string | null = "ADMIN") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role) (req as unknown as { user: unknown }).user = { id: "admin-1", role };
    next();
  });
  app.use("/api/admin", adminRouter);
  return app;
}

const app = buildApp();

interface SeedEntry {
  timestamp: string;
  action?: string;
  userId?: string;
  resource?: string;
  resourceId?: string;
  changes?: Record<string, unknown>;
}

let seeded = 0;

async function seed(entry: SeedEntry) {
  seeded += 1;
  return createAuditEntry(
    {
      method: "POST",
      path: "/api/admin/test",
      headers: { "user-agent": "jest" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as Request,
    { statusCode: 200 } as Response,
    {
      id: `entry-${String(seeded).padStart(4, "0")}`,
      userId: "admin-1",
      action: "UPDATE_VAULT_PARAMETERS",
      resource: "VAULT",
      ...entry,
    },
  );
}

const ids = (body: { data: Array<{ id: string }> }) => body.data.map((entry) => entry.id);

beforeEach(() => {
  resetAuditLog();
  seeded = 0;
});

describe("GET /api/admin/audit-logs — filters", () => {
  async function seedScenario() {
    return {
      a: await seed({ timestamp: "2025-03-01T09:00:00.000Z", action: "ADMIN_ACTION_CONFIRMED", userId: ADMIN_WALLET }),
      b: await seed({ timestamp: "2025-03-01T18:30:00.000Z", action: "UPDATE_VAULT_PARAMETERS", resourceId: USER_WALLET }),
      c: await seed({
        timestamp: "2025-03-02T12:00:00.000Z",
        action: "ADMIN_ACTION_CANCELLED",
        changes: { after: { walletAddress: USER_WALLET } },
      }),
      d: await seed({ timestamp: "2025-03-05T00:00:00.000Z", action: "ADMIN_ACTION_CONFIRMED" }),
    };
  }

  it("returns every entry, newest first, when no filter is given", async () => {
    const e = await seedScenario();

    const res = await request(app).get("/api/admin/audit-logs").expect(200);

    expect(ids(res.body)).toEqual([e.d.id, e.c.id, e.b.id, e.a.id]);
    expect(res.body.filters).toEqual({});
    expect(res.body.pagination).toEqual({ nextCursor: null, hasMore: false, limit: 20 });
  });

  it("filters by wallet: the acting identity, the target resource, and wallets inside changes", async () => {
    const e = await seedScenario();

    const asActor = await request(app).get(`/api/admin/audit-logs?wallet=${ADMIN_WALLET}`).expect(200);
    const asTarget = await request(app).get(`/api/admin/audit-logs?wallet=${USER_WALLET}`).expect(200);

    expect(ids(asActor.body)).toEqual([e.a.id]);
    expect(ids(asTarget.body)).toEqual([e.c.id, e.b.id]);
    expect(asTarget.body.filters.wallet).toBe(USER_WALLET);
  });

  it("matches the wallet case-insensitively and echoes the normalised value", async () => {
    const e = await seedScenario();

    const res = await request(app)
      .get(`/api/admin/audit-logs?wallet=${ADMIN_WALLET.toLowerCase()}`)
      .expect(200);

    expect(ids(res.body)).toEqual([e.a.id]);
    expect(res.body.filters.wallet).toBe(ADMIN_WALLET);
  });

  it("returns an empty page for a valid wallet with no activity", async () => {
    await seedScenario();
    const idle = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";

    const res = await request(app).get(`/api/admin/audit-logs?wallet=${idle}`).expect(200);

    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.hasMore).toBe(false);
  });

  it("filters by a single action, case-insensitively", async () => {
    const e = await seedScenario();

    const res = await request(app)
      .get("/api/admin/audit-logs?action=admin_action_confirmed")
      .expect(200);

    expect(ids(res.body)).toEqual([e.d.id, e.a.id]);
  });

  it.each([
    ["comma-separated", "action=ADMIN_ACTION_CANCELLED,UPDATE_VAULT_PARAMETERS"],
    ["repeated", "action=ADMIN_ACTION_CANCELLED&action=UPDATE_VAULT_PARAMETERS"],
  ])("filters by several actions (%s)", async (_label, query) => {
    const e = await seedScenario();

    const res = await request(app).get(`/api/admin/audit-logs?${query}`).expect(200);

    expect(ids(res.body)).toEqual([e.c.id, e.b.id]);
    expect(res.body.filters.actions).toEqual(["ADMIN_ACTION_CANCELLED", "UPDATE_VAULT_PARAMETERS"]);
  });

  it("includes the whole of a date-only endDate", async () => {
    const e = await seedScenario();

    const res = await request(app)
      .get("/api/admin/audit-logs?startDate=2025-03-01&endDate=2025-03-01")
      .expect(200);

    // 09:00 and 18:30 on Mar 1; a midnight-bounded endDate would drop 18:30.
    expect(ids(res.body)).toEqual([e.b.id, e.a.id]);
  });

  it("applies a date-time range with an offset", async () => {
    const e = await seedScenario();

    const res = await request(app)
      .get("/api/admin/audit-logs")
      .query({ startDate: "2025-03-01T20:00:00+02:00", endDate: "2025-03-02T14:00:00+02:00" })
      .expect(200);

    // 18:00Z .. 12:00Z next day  → entries b (18:30Z) and c (12:00Z).
    expect(ids(res.body)).toEqual([e.c.id, e.b.id]);
  });

  it("combines wallet, action and date range with AND", async () => {
    const e = await seedScenario();

    const res = await request(app)
      .get("/api/admin/audit-logs")
      .query({
        wallet: USER_WALLET,
        action: "ADMIN_ACTION_CANCELLED",
        startDate: "2025-03-02",
        endDate: "2025-03-02",
      })
      .expect(200);

    expect(ids(res.body)).toEqual([e.c.id]);
  });

  it("ignores blank filter fields, as an unfilled form submits them", async () => {
    await seedScenario();

    const res = await request(app)
      .get("/api/admin/audit-logs?wallet=&action=&startDate=&endDate=")
      .expect(200);

    expect(res.body.data).toHaveLength(4);
  });

  it("keeps the filters applied while paging with a cursor", async () => {
    await seedScenario();
    await seed({ timestamp: "2025-03-06T00:00:00.000Z", action: "ADMIN_ACTION_CONFIRMED" });

    const first = await request(app)
      .get("/api/admin/audit-logs?action=ADMIN_ACTION_CONFIRMED&limit=2")
      .expect(200);
    const second = await request(app)
      .get(`/api/admin/audit-logs?action=ADMIN_ACTION_CONFIRMED&limit=2&cursor=${first.body.pagination.nextCursor}`)
      .expect(200);

    expect(first.body.pagination.hasMore).toBe(true);
    expect(second.body.pagination.hasMore).toBe(false);
    const all = [...ids(first.body), ...ids(second.body)];
    expect(all).toHaveLength(3);
    expect(new Set(all).size).toBe(3);
    for (const entry of [...first.body.data, ...second.body.data]) {
      expect(entry.action).toBe("ADMIN_ACTION_CONFIRMED");
    }
  });
});

describe("GET /api/admin/audit-logs — invalid filters", () => {
  it.each([
    ["an invalid wallet", "wallet=not-a-wallet", "INVALID_WALLET", "wallet"],
    ["an invalid action", "action=%3Cscript%3E", "INVALID_ACTION", "action"],
    ["an unparseable startDate", "startDate=yesterday", "INVALID_DATE", "startDate"],
    ["an unparseable endDate", "endDate=2025-02-30", "INVALID_DATE", "endDate"],
    ["a date-time without a zone", "startDate=2025-03-01T10:00:00", "INVALID_DATE", "startDate"],
    ["an inverted range", "startDate=2025-03-02&endDate=2025-03-01", "INVALID_DATE_RANGE", "startDate"],
  ])("answers 400 with a stable error for %s", async (_label, query, code, field) => {
    await seed({ timestamp: "2025-03-01T09:00:00.000Z" });

    const res = await request(app).get(`/api/admin/audit-logs?${query}`).expect(400);

    expect(res.body).toMatchObject({ error: code, details: { field } });
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message).not.toMatch(/Invalid Date|NaN/);
    expect(res.body).not.toHaveProperty("data");
  });

  it("no longer answers an unparseable date with a silently empty page", async () => {
    await seed({ timestamp: "2025-03-01T09:00:00.000Z" });

    const res = await request(app).get("/api/admin/audit-logs?startDate=garbage");

    expect(res.status).toBe(400);
  });

  it("still rejects a non-admin caller before validating anything", async () => {
    // The admin router answers 403 for both a non-admin and an anonymous caller.
    await request(buildApp("VIEWER")).get("/api/admin/audit-logs?wallet=bad").expect(403);
    await request(buildApp(null)).get("/api/admin/audit-logs?wallet=bad").expect(403);
  });
});

describe("GET /api/admin/audit-logs/export — filters", () => {
  const csvRows = (text: string) => text.split("\n").slice(1);

  it("exports only the entries that match the filters", async () => {
    await seed({ timestamp: "2025-03-01T09:00:00.000Z", action: "A", userId: ADMIN_WALLET });
    await seed({ timestamp: "2025-03-02T09:00:00.000Z", action: "B", userId: ADMIN_WALLET });
    await seed({ timestamp: "2025-03-03T09:00:00.000Z", action: "A", userId: "someone-else" });

    const res = await request(app)
      .get(`/api/admin/audit-logs/export?wallet=${ADMIN_WALLET}&action=A`)
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(csvRows(res.text)).toHaveLength(1);
    expect(res.text).toContain(ADMIN_WALLET);
    expect(res.headers).not.toHaveProperty("x-audit-export-truncated");
  });

  it("rejects an invalid filter with the same 400 as the list endpoint", async () => {
    const res = await request(app).get("/api/admin/audit-logs/export?wallet=oops").expect(400);

    expect(res.body).toMatchObject({ error: "INVALID_WALLET", details: { field: "wallet" } });
  });

  it("exports more than the default 100-row page", async () => {
    // Uses the real cap of 5 from the mock above: 4 rows fit, none are dropped.
    for (let i = 0; i < 4; i += 1) {
      await seed({ timestamp: `2025-03-0${i + 1}T09:00:00.000Z` });
    }

    const res = await request(app).get("/api/admin/audit-logs/export").expect(200);

    expect(csvRows(res.text)).toHaveLength(4);
  });

  it("flags a truncated export instead of silently dropping rows", async () => {
    for (let i = 0; i < 7; i += 1) {
      await seed({ timestamp: `2025-03-0${i + 1}T09:00:00.000Z` });
    }

    const res = await request(app).get("/api/admin/audit-logs/export").expect(200);

    expect(csvRows(res.text)).toHaveLength(5);
    expect(res.headers["x-audit-export-truncated"]).toBe("true");
  });
});
