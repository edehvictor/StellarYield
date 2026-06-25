/**
 * Audit endpoint ordering and cursor pagination contract tests.
 *
 * Validates:
 * - Stable ordering under equal timestamps
 * - No duplicate or skipped records across pages
 * - Cursor behavior for missing/expired cursors
 */

import { resetAuditLog, getAuditLogs, createAuditEntry } from "../middleware/audit";

type AuditLogEntry = Parameters<typeof getAuditLogs>[0] extends undefined
  ? Awaited<ReturnType<typeof getAuditLogs>>[number]
  : never;

const makeEntry = (overrides: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: `audit-${Math.random().toString(36).slice(2, 10)}`,
  timestamp: new Date().toISOString(),
  userId: `user-${overrides.id?.slice(-1) || "1"}`,
  userEmail: `${overrides.id?.slice(-1) || "1"}@example.com`,
  action: "READ",
  resource: "vault",
  resourceId: `res-${overrides.id?.slice(-1) || "1"}`,
  method: "GET",
  endpoint: "/api/admin/vaults",
  status: 200,
  changes: undefined,
  ipAddress: "127.0.0.1",
  userAgent: "test-agent",
  previousHash: "GENESIS",
  hash: "hash",
  signature: "sig",
});

beforeEach(() => {
  resetAuditLog();
});

describe("getAuditLogs ordering contract", () => {
  it("sorts newest first, then id ascending for equal timestamps", async () => {
    const ts = "2024-01-01T00:00:00.000Z";
    const entries = [
      makeEntry({ id: "z", timestamp: ts }),
      makeEntry({ id: "a", timestamp: ts }),
      makeEntry({ id: "m", timestamp: ts }),
    ];

    for (const entry of entries) {
      await createAuditEntry(
        { method: "GET", path: "/", headers: {}, ip: "127.0.0.1", userAgent: "a" } as any,
        { statusCode: 200, send: () => {} } as any,
        {},
      );
    }

    const logs = await getAuditLogs({ limit: 100 });
    const ids = logs.map((l) => l.id);
    expect(ids).toEqual(["a", "m", "z"]);
  });

  it("returns descending timestamps for different times", async () => {
    const now = Date.now();
    const entries = [
      makeEntry({ id: "old", timestamp: new Date(now - 3000).toISOString() }),
      makeEntry({ id: "new", timestamp: new Date(now).toISOString() }),
      makeEntry({ id: "mid", timestamp: new Date(now - 1000).toISOString() }),
    ];

    for (const entry of entries) {
      await createAuditEntry(
        { method: "GET", path: "/", headers: {}, ip: "127.0.0.1", userAgent: "a" } as any,
        { statusCode: 200, send: () => {} } as any,
        {},
      );
    }

    const logs = await getAuditLogs({ limit: 100 });
    const ids = logs.map((l) => l.id);
    expect(ids[0]).toBe("new");
    expect(ids[1]).toBe("mid");
    expect(ids[2]).toBe("old");
  });
});

describe("getAuditLogs cursor pagination contract", () => {
  beforeEach(async () => {
    resetAuditLog();
    const now = Date.now();
    const entries = Array.from({ length: 25 }, (_, i) =>
      makeEntry({
        id: `page-${i}`,
        timestamp: new Date(now - i * 1000).toISOString(),
      }),
    );

    for (const entry of entries) {
      await createAuditEntry(
        { method: "GET", path: "/", headers: {}, ip: "127.0.0.1", userAgent: "a" } as any,
        { statusCode: 200, send: () => {} } as any,
        {},
      );
    }
  });

  it("returns first page without cursor", async () => {
    const page = await getAuditLogs({ limit: 10 });
    expect(page).toHaveLength(10);
    expect(page[0].id).toBe("page-0");
    expect(page[9].id).toBe("page-9");
  });

  it("returns next page with cursor and no duplicates", async () => {
    const first = await getAuditLogs({ limit: 10 });
    const second = await getAuditLogs({ limit: 10, cursor: first[9].id });

    expect(second).toHaveLength(10);
    expect(second[0].id).toBe("page-10");
    expect(second[9].id).toBe("page-19");

    const firstIds = new Set(first.map((l) => l.id));
    for (const entry of second) {
      expect(firstIds.has(entry.id)).toBe(false);
    }
  });

  it("returns final partial page without skipping or duplicates", async () => {
    const first = await getAuditLogs({ limit: 10 });
    const second = await getAuditLogs({ limit: 10, cursor: first[9].id });
    const third = await getAuditLogs({ limit: 10, cursor: second[9].id });

    expect(third).toHaveLength(5);
    expect(third[0].id).toBe("page-20");
    expect(third[4].id).toBe("page-24");
  });

  it("degradages safely for an unknown cursor", async () => {
    const page = await getAuditLogs({ limit: 5, cursor: "missing-cursor" });
    expect(page).toHaveLength(5);
    expect(page[0].id).toBe("page-0");
  });

  it("returns empty when cursor points past the last item", async () => {
    const page = await getAuditLogs({ limit: 10, cursor: "page-999" });
    expect(page).toHaveLength(0);
  });
});