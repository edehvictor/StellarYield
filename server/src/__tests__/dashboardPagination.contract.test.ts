/**
 * API pagination contract tests for dashboard endpoints — Issue #1305.
 *
 * Covers GET /api/portfolio/activity/:walletAddress against the shared
 * PaginatedResponse contract (cursor/limit → {data, pagination}):
 * normal paged walk, limit clamping, and invalid-cursor degradation.
 */
import request from "supertest";
import { createApp } from "../app";

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
const WALLET = "GTEST_PAGINATION_WALLET";

describe("GET /api/portfolio/activity/:walletAddress — pagination contract (#1305)", () => {
  it("returns the legacy timeline plus the canonical data/pagination envelope", async () => {
    const res = await request(app).get(`/api/portfolio/activity/${WALLET}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toEqual(res.body.timeline);
    expect(res.body.pagination).toMatchObject({
      nextCursor: null,
      hasMore: false,
    });
    expect(typeof res.body.pagination.limit).toBe("number");
  });

  it("walks pages without overlap or gaps", async () => {
    const first = await request(app).get(
      `/api/portfolio/activity/${WALLET}?limit=3`,
    );
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(3);
    expect(first.body.pagination.hasMore).toBe(true);
    expect(typeof first.body.pagination.nextCursor).toBe("string");

    const second = await request(app).get(
      `/api/portfolio/activity/${WALLET}?limit=3&cursor=${encodeURIComponent(
        first.body.pagination.nextCursor,
      )}`,
    );
    expect(second.status).toBe(200);
    const firstIds = new Set(first.body.data.map((e: { id: string }) => e.id));
    for (const entry of second.body.data as Array<{ id: string }>) {
      expect(firstIds.has(entry.id)).toBe(false);
    }
    // Combined pages are newest-first with no duplicates.
    const combined = [...first.body.data, ...second.body.data];
    const ids = combined.map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("clamps limits deterministically (0 → default 20, 500 → max 100)", async () => {
    const zero = await request(app).get(
      `/api/portfolio/activity/${WALLET}?limit=0`,
    );
    expect(zero.status).toBe(200);
    expect(zero.body.pagination.limit).toBe(20);

    const huge = await request(app).get(
      `/api/portfolio/activity/${WALLET}?limit=500`,
    );
    expect(huge.status).toBe(200);
    expect(huge.body.pagination.limit).toBe(100);
  });

  it("degrades an invalid cursor to the first page", async () => {
    const res = await request(app).get(
      `/api/portfolio/activity/${WALLET}?limit=3&cursor=not-a-cursor`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    const fresh = await request(app).get(
      `/api/portfolio/activity/${WALLET}?limit=3`,
    );
    expect(res.body.data).toEqual(fresh.body.data);
  });

  it("keeps filters working together with pagination", async () => {
    const res = await request(app).get(
      `/api/portfolio/activity/${WALLET}?types=deposit&limit=2`,
    );
    expect(res.status).toBe(200);
    for (const entry of res.body.data as Array<{ type: string }>) {
      expect(entry.type).toBe("deposit");
    }
  });
});
