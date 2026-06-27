import { resetAuditLog, getAuditLogs, createAuditEntry } from "../middleware/audit";
import { parsePaginationLimit, PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from "../types/pagination";

function makeReq() {
  return { method: "GET", path: "/test", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;
}
function makeRes() {
  return { statusCode: 200, send: () => {} } as any;
}

async function seedEntries(count: number) {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    await createAuditEntry(makeReq(), makeRes(), {
      action: `ACTION_${i}`,
      resource: "test-resource",
    });
  }
}

beforeEach(() => {
  resetAuditLog();
});

describe("Cursor pagination for audit endpoints", () => {
  describe("parsePaginationLimit", () => {
    it("returns default for undefined input", () => {
      expect(parsePaginationLimit(undefined)).toBe(PAGINATION_DEFAULT_LIMIT);
    });

    it("returns default for non-numeric string", () => {
      expect(parsePaginationLimit("abc")).toBe(PAGINATION_DEFAULT_LIMIT);
    });

    it("returns default for zero", () => {
      expect(parsePaginationLimit(0)).toBe(PAGINATION_DEFAULT_LIMIT);
    });

    it("returns default for negative", () => {
      expect(parsePaginationLimit(-5)).toBe(PAGINATION_DEFAULT_LIMIT);
    });

    it("clamps to max limit", () => {
      expect(parsePaginationLimit(500)).toBe(PAGINATION_MAX_LIMIT);
    });

    it("floors fractional values", () => {
      expect(parsePaginationLimit(7.9)).toBe(7);
    });

    it("accepts valid numbers", () => {
      expect(parsePaginationLimit(25)).toBe(25);
    });
  });

  describe("cursor-based page traversal", () => {
    beforeEach(async () => {
      await seedEntries(30);
    });

    it("first page returns correct number of results without cursor", async () => {
      const page = await getAuditLogs({ limit: 10 });
      expect(page).toHaveLength(10);
    });

    it("second page starts after the cursor entry", async () => {
      const first = await getAuditLogs({ limit: 10 });
      const lastId = first[first.length - 1].id;
      const second = await getAuditLogs({ limit: 10, cursor: lastId });

      expect(second).toHaveLength(10);
      const firstIds = new Set(first.map((e) => e.id));
      for (const entry of second) {
        expect(firstIds.has(entry.id)).toBe(false);
      }
    });

    it("traverses all entries without duplicates or gaps", async () => {
      const allIds: string[] = [];
      let cursor: string | undefined;

      for (let i = 0; i < 10; i++) {
        const page = await getAuditLogs({ limit: 10, cursor });
        if (page.length === 0) break;
        allIds.push(...page.map((e) => e.id));
        cursor = page[page.length - 1].id;
      }

      expect(allIds).toHaveLength(30);
      expect(new Set(allIds).size).toBe(30);
    });

    it("returns empty array when cursor points past last item", async () => {
      const all = await getAuditLogs({ limit: 100 });
      const lastId = all[all.length - 1].id;
      const next = await getAuditLogs({ limit: 10, cursor: lastId });
      expect(next).toHaveLength(0);
    });
  });

  describe("invalid cursor handling", () => {
    beforeEach(async () => {
      await seedEntries(5);
    });

    it("degrades to first page for unknown cursor", async () => {
      const page = await getAuditLogs({ limit: 5, cursor: "nonexistent-id" });
      expect(page).toHaveLength(5);
    });

    it("degrades to first page for empty string cursor", async () => {
      const page = await getAuditLogs({ limit: 5, cursor: "" });
      expect(page).toHaveLength(5);
    });
  });

  describe("stable ordering", () => {
    it("maintains deterministic order for same-timestamp entries", async () => {
      await seedEntries(5);
      const first = await getAuditLogs({ limit: 100 });
      const second = await getAuditLogs({ limit: 100 });
      expect(first.map((e) => e.id)).toEqual(second.map((e) => e.id));
    });
  });

  describe("filter + pagination combination", () => {
    beforeEach(async () => {
      for (let i = 0; i < 15; i++) {
        await createAuditEntry(makeReq(), makeRes(), {
          action: i % 2 === 0 ? "READ" : "WRITE",
          resource: "vault",
        });
      }
    });

    it("paginated results respect action filter", async () => {
      const page = await getAuditLogs({ limit: 5, action: "READ" });
      for (const entry of page) {
        expect(entry.action).toBe("READ");
      }
    });
  });
});
