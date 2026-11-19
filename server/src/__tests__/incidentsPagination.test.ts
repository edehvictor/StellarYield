import request from "supertest";
import express from "express";
import incidentsRouter from "../routes/incidents";
import { encodeTimelineCursor } from "../types/pagination";

// ---------------------------------------------------------------------------
// Prisma mock — a compound (startedAt, id) cursor, mirroring the real
// `OR: [{ startedAt: { lt } }, { startedAt: eq, id: { lt } }]` query so the
// mock actually exercises the stability guarantees described in #1071.
// ---------------------------------------------------------------------------
interface MockIncident {
  id: string;
  protocol: string;
  severity: string;
  type: string;
  title: string;
  description: string;
  affectedVaults: string[];
  resolved: boolean;
  startedAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const makeIncident = (id: string, startedAt: Date): MockIncident => ({
  id,
  protocol: "TestProtocol",
  severity: "HIGH",
  type: "PAUSE",
  title: `Incident ${id}`,
  description: "Test description",
  affectedVaults: [],
  resolved: false,
  startedAt,
  resolvedAt: null,
  createdAt: startedAt,
  updatedAt: startedAt,
});

// 25 incidents, ids intentionally NOT correlated with startedAt order — like
// real UUIDs — to prove pagination stays correct even when id order and
// time order disagree (the bug #1071 fixes).
const ALL_INCIDENTS: MockIncident[] = Array.from({ length: 25 }, (_, i) => {
  const n = 25 - i; // n goes 25, 24, … 1 → startedAt descending
  const startedAt = new Date(Date.UTC(2024, 0, n));
  // Shuffle-ish id so lexical id order has no relation to startedAt order.
  const id = `uuid-${String((n * 37) % 25).padStart(2, "0")}-${n}`;
  return makeIncident(id, startedAt);
});

let mutablePool: MockIncident[] = [...ALL_INCIDENTS];

type CursorWhere = {
  OR?: [{ startedAt: { lt: Date } }, { startedAt: Date; id: { lt: string } }];
};

function applyCompoundCursor(pool: MockIncident[], where?: CursorWhere): MockIncident[] {
  const or = where?.OR;
  if (!or || or.length !== 2) return pool;

  const [ltClause, tieClause] = or;
  const cursorTs = ltClause.startedAt.lt.getTime();
  const cursorId = tieClause.id.lt;

  return pool.filter((incident) => {
    const ts = incident.startedAt.getTime();
    if (ts !== cursorTs) return ts < cursorTs;
    return incident.id < cursorId;
  });
}

jest.mock("@prisma/client", () => {
  const mockFindMany = jest.fn().mockImplementation(
    (args?: {
      where?: { resolved?: boolean; OR?: unknown };
      take?: number;
    }) => {
      let pool = [...mutablePool];

      if (args?.where?.resolved !== undefined) {
        pool = pool.filter((i) => i.resolved === args.where!.resolved);
      }

      pool = applyCompoundCursor(pool, args?.where as CursorWhere);

      // Compound sort: startedAt desc, id desc — matches the real orderBy.
      pool = [...pool].sort((a, b) => {
        const tsDiff = b.startedAt.getTime() - a.startedAt.getTime();
        if (tsDiff !== 0) return tsDiff;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });

      return Promise.resolve(args?.take ? pool.slice(0, args.take) : pool);
    },
  );

  return {
    PrismaClient: jest.fn(() => ({
      incident: { findMany: mockFindMany, findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      $disconnect: jest.fn(),
    })),
  };
});

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use("/api/incidents", incidentsRouter);

beforeEach(() => {
  mutablePool = [...ALL_INCIDENTS];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GET /api/incidents — cursor pagination", () => {
  it("returns first page with default limit (20) and hasMore=true", async () => {
    const res = await request(app).get("/api/incidents");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(20);
    expect(res.body.pagination.hasMore).toBe(true);
    expect(res.body.pagination.limit).toBe(20);
    expect(typeof res.body.pagination.nextCursor).toBe("string");
  });

  it("returns correct second page using nextCursor, with no overlap or gaps", async () => {
    const firstPage = await request(app).get("/api/incidents");
    const { nextCursor } = firstPage.body.pagination;

    const secondPage = await request(app).get(`/api/incidents?cursor=${nextCursor}`);

    expect(secondPage.status).toBe(200);
    // 25 total - 20 first page = 5 remaining
    expect(secondPage.body.data).toHaveLength(5);
    expect(secondPage.body.pagination.hasMore).toBe(false);
    expect(secondPage.body.pagination.nextCursor).toBeNull();

    const firstIds = firstPage.body.data.map((i: MockIncident) => i.id);
    const secondIds = secondPage.body.data.map((i: MockIncident) => i.id);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(25);
  });

  it("remains stable when a new incident is inserted between page requests (#1071)", async () => {
    const firstPage = await request(app).get("/api/incidents?limit=10");
    const { nextCursor } = firstPage.body.pagination;

    // Simulate a concurrent insert: a brand-new incident, newer than
    // everything already paged, with a lexically small id (so an id-only
    // cursor would have incorrectly resurfaced or reshuffled prior pages).
    mutablePool = [
      makeIncident("uuid-00-new", new Date(Date.UTC(2024, 0, 26))),
      ...mutablePool,
    ];

    const secondPage = await request(app).get(`/api/incidents?cursor=${nextCursor}&limit=10`);

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data).toHaveLength(10);

    // The newly inserted incident must NOT appear on page 2 — it's newer
    // than the cursor position, so it only ever shows up on a fresh
    // first-page fetch, never inserted into an already-issued page.
    const secondIds = secondPage.body.data.map((i: MockIncident) => i.id);
    expect(secondIds).not.toContain("uuid-00-new");

    // No duplicates with page 1, and continuing to page through eventually
    // yields every original incident exactly once.
    const firstIds = firstPage.body.data.map((i: MockIncident) => i.id);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length + secondIds.length);
  });

  it("uses id as a deterministic tie-breaker when startedAt collides", async () => {
    const sharedTime = new Date(Date.UTC(2024, 5, 1));
    mutablePool = [
      makeIncident("uuid-tie-b", sharedTime),
      makeIncident("uuid-tie-a", sharedTime),
      ...ALL_INCIDENTS,
    ];

    const page1 = await request(app).get("/api/incidents?limit=1");
    // Highest id ("uuid-tie-b" > "uuid-tie-a") comes first under `id desc`.
    expect(page1.body.data[0].id).toBe("uuid-tie-b");

    const page2 = await request(app).get(`/api/incidents?cursor=${page1.body.pagination.nextCursor}&limit=1`);
    expect(page2.body.data[0].id).toBe("uuid-tie-a");
  });

  it("returns empty data array when cursor points past the last item", async () => {
    const pastLastCursor = encodeTimelineCursor({ ts: new Date(Date.UTC(2020, 0, 1)).getTime(), id: "uuid-00-00" });
    const res = await request(app).get(`/api/incidents?cursor=${pastLastCursor}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.hasMore).toBe(false);
    expect(res.body.pagination.nextCursor).toBeNull();
  });

  it("falls back to the first page for a malformed cursor instead of erroring", async () => {
    const res = await request(app).get("/api/incidents?cursor=not-a-real-cursor");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(20);
  });

  it("respects a custom limit", async () => {
    const res = await request(app).get("/api/incidents?limit=5");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.pagination.limit).toBe(5);
    expect(res.body.pagination.hasMore).toBe(true);
  });

  it("clamps limit to maximum of 100", async () => {
    const res = await request(app).get("/api/incidents?limit=999");

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
  });

  it("uses default limit when limit param is invalid", async () => {
    const res = await request(app).get("/api/incidents?limit=abc");

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(20);
  });

  it("returns pagination shape on every response (data + pagination fields present)", async () => {
    const res = await request(app).get("/api/incidents?limit=3");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("pagination");
    expect(res.body.pagination).toHaveProperty("nextCursor");
    expect(res.body.pagination).toHaveProperty("hasMore");
    expect(res.body.pagination).toHaveProperty("limit");
  });

  it("paging through every page yields all 25 incidents exactly once", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let i = 0; i < 10; i++) {
      const res: { body: { data: MockIncident[]; pagination: { nextCursor: string | null; hasMore: boolean } } } =
        await request(app).get(`/api/incidents?limit=7${cursor ? `&cursor=${cursor}` : ""}`);
      for (const incident of res.body.data) {
        expect(seen.has(incident.id)).toBe(false); // no duplicates
        seen.add(incident.id);
      }
      if (!res.body.pagination.hasMore) break;
      cursor = res.body.pagination.nextCursor!;
    }

    expect(seen.size).toBe(25);
  });
});