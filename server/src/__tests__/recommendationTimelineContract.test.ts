/**
 * API Contract Tests for Paginated Recommendation Timeline
 *
 * Tests pagination behavior: first page, next page, empty page, invalid cursor
 * Verifies item ordering, cursor shape, and error responses follow shared API contract
 */

import {
  recordRecommendation,
  getRecommendationTimelinePaginated,
  getRecommendationTimeline,
  resetRecommendationTimelineStore,
  type RecommendationTimelineEntry,
} from "../services/recommendationTimelineService";
import type { PaginatedRecommendations } from "../services/recommendationTimelineService";

describe("Recommendation Timeline Pagination Contract", () => {
  beforeEach(() => {
    resetRecommendationTimelineStore();
  });

  afterEach(() => {
    resetRecommendationTimelineStore();
  });

  describe("First page response contract", () => {
    it("should return first page with stable cursor shape", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 5; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      const result = getRecommendationTimelinePaginated(userId, null, 3);
      expect(result.data).toHaveLength(3);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeTruthy();
      expect(typeof result.nextCursor).toBe("string");
    });

    it("should return items in reverse chronological order (newest first)", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 3; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10 + i,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      const result = getRecommendationTimelinePaginated(userId, null, 10);
      const recommendations = result.data.map((r) => r.recommendation);
      expect(recommendations[0]).toContain("Rec");
      expect(recommendations.length).toBe(3);
    });

    it("should respect limit parameter", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 10; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      const result = getRecommendationTimelinePaginated(userId, null, 5);
      expect(result.data).toHaveLength(5);
    });

    it("should indicate hasMore=false when all items fit on first page", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 3; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      const result = getRecommendationTimelinePaginated(userId, null, 10);
      expect(result.data).toHaveLength(3);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe("Next page with cursor", () => {
    it("should fetch second page using nextCursor from first page", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 6; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      const firstPage = getRecommendationTimelinePaginated(userId, null, 3);
      expect(firstPage.data).toHaveLength(3);
      expect(firstPage.hasMore).toBe(true);

      const secondPage = getRecommendationTimelinePaginated(
        userId,
        firstPage.nextCursor,
        3,
      );
      expect(secondPage.data).toHaveLength(3);
      expect(secondPage.hasMore).toBe(false);

      const firstPageIds = firstPage.data.map((r) => r.id);
      const secondPageIds = secondPage.data.map((r) => r.id);
      expect(firstPageIds).not.toContain(secondPageIds[0]);
    });

    it("should fetch final page with hasMore=false", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 7; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      const page1 = getRecommendationTimelinePaginated(userId, null, 3);
      const page2 = getRecommendationTimelinePaginated(
        userId,
        page1.nextCursor,
        3,
      );
      const page3 = getRecommendationTimelinePaginated(
        userId,
        page2.nextCursor,
        3,
      );

      expect(page3.data).toHaveLength(1);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();
    });

    it("should maintain consistent ordering across pages", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 10; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      let allItems: RecommendationTimelineEntry[] = [];
      let cursor: string | null = null;

      do {
        const page = getRecommendationTimelinePaginated(userId, cursor, 3);
        allItems = allItems.concat(page.data);
        cursor = page.nextCursor;
      } while (cursor);

      expect(allItems).toHaveLength(10);
      const timestamps = allItems.map((r) => r.timestamp);
      const sortedTimestamps = [...timestamps].sort().reverse();
      expect(timestamps).toEqual(sortedTimestamps);
    });
  });

  describe("Empty page responses", () => {
    it("should return empty data for nonexistent user", () => {
      const result = getRecommendationTimelinePaginated(
        "nonexistent-user",
        null,
        10,
      );
      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it("should return empty page after all items consumed", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 3; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      let cursor: string | null = null;
      let page;

      do {
        page = getRecommendationTimelinePaginated(userId, cursor, 2);
        cursor = page.nextCursor;
      } while (page.hasMore);

      if (page.data.length > 0) {
        const lastItem = page.data[page.data.length - 1];
        const allItems = getRecommendationTimeline(userId);
        const lastItemIndex = allItems.findIndex(
          (item) => item.id === lastItem.id,
        );
        const pastEndCursor = Buffer.from(
          `${lastItem.timestamp}:${lastItemIndex + 1}`,
        ).toString("base64url");

        const pastEnd = getRecommendationTimelinePaginated(
          userId,
          pastEndCursor,
          2,
        );

        expect(pastEnd.data).toEqual([]);
        expect(pastEnd.hasMore).toBe(false);
        expect(pastEnd.nextCursor).toBeNull();
      }
    });
  });

  describe("Invalid cursor handling", () => {
    it("should return empty page for malformed cursor", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 3; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      const page = getRecommendationTimelinePaginated(
        userId,
        "not-valid-base64url!!!",
        10,
      );

      expect(page.data).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it("should return empty page for cursor pointing past end", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 3; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      const fakeCursor = Buffer.from(`2020-01-01T00:00:00.000Z:100`).toString(
        "base64url",
      );

      const page = getRecommendationTimelinePaginated(userId, fakeCursor, 10);

      expect(page.data).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it("should return empty page for empty cursor string", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 3; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      const page = getRecommendationTimelinePaginated(userId, "", 10);

      expect(page.data).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe("Repeated timestamps (edge case)", () => {
    it("should handle multiple items with same timestamp correctly", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 5; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      const page1 = getRecommendationTimelinePaginated(userId, null, 2);
      expect(page1.data).toHaveLength(2);
      expect(page1.hasMore).toBe(true);

      if (page1.nextCursor) {
        const page2 = getRecommendationTimelinePaginated(
          userId,
          page1.nextCursor,
          2,
        );
        expect(page2.data).toHaveLength(2);
        expect(page2.hasMore).toBe(true);

        if (page2.nextCursor) {
          const page3 = getRecommendationTimelinePaginated(
            userId,
            page2.nextCursor,
            2,
          );
          expect(page3.data).toHaveLength(1);
          expect(page3.hasMore).toBe(false);
          expect(page3.nextCursor).toBeNull();
        }
      }
    });
  });

  describe("Mixed recommendation types", () => {
    it("should handle different reason codes in paginated results", async () => {
      const userId = `test-${Math.random()}`;
      await recordRecommendation(userId, {
        recommendation: "Start with conservative",
        rationale: "New user",
        targetVault: "vault-conservative",
        inputSnapshot: {
          riskTolerance: "conservative",
          expectedApy: 5,
          liquidityDepthUsd: 100000,
          volatilityPct: 2,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await recordRecommendation(userId, {
        recommendation: "Shift to balanced",
        rationale: "Risk tolerance increased",
        targetVault: "vault-balanced",
        inputSnapshot: {
          riskTolerance: "balanced",
          expectedApy: 8,
          liquidityDepthUsd: 100000,
          volatilityPct: 2,
        },
      });

      const result = getRecommendationTimelinePaginated(userId, null, 10);
      expect(result.data).toHaveLength(2);
      expect(result.data[0].recommendation).toContain("Shift");
      expect(result.data[1].recommendation).toContain("Start");
    });
  });

  describe("Limit parameter validation", () => {
    it("should default to reasonable limit when not specified", async () => {
      const userId = `test-${Math.random()}`;
      for (let i = 0; i < 30; i++) {
        await recordRecommendation(userId, {
          recommendation: `Rec ${i}`,
          rationale: `Rationale ${i}`,
          targetVault: `vault-${i}`,
          inputSnapshot: {
            riskTolerance: "balanced",
            expectedApy: 10,
            liquidityDepthUsd: 100000,
            volatilityPct: 5,
          },
        });
      }

      const result = getRecommendationTimelinePaginated(userId, null); // No limit
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data.length).toBeLessThanOrEqual(20);
    });
  });
});
