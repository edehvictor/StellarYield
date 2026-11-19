/**
 * activityTimelineFilters.test.ts — Issue #1178
 *
 * Tests for the account activity timeline service filter functionality:
 * 1. Protocol filtering
 * 2. Asset filtering
 * 3. Status filtering
 * 4. Combined filters
 * 5. Type filtering (existing behavior)
 */

import {
  buildUnifiedAccountTimeline,
  type AccountActivityFilters,
  type AccountActivityEventType,
} from "../services/accountActivityTimelineService";

const WALLET = "GTEST_WALLET_ADDRESS_12345";

describe("activityTimelineFilters (#1178)", () => {
  it("returns all events when no filters are provided", () => {
    const events = buildUnifiedAccountTimeline(WALLET);
    expect(events.length).toBeGreaterThan(0);
  });

  it("filters by type", () => {
    const filters: AccountActivityFilters = { types: ["deposit"] };
    const events = buildUnifiedAccountTimeline(WALLET, filters);
    for (const event of events) {
      expect(event.type).toBe("deposit");
    }
  });

  it("filters by multiple types", () => {
    const filters: AccountActivityFilters = { types: ["deposit", "withdrawal"] };
    const events = buildUnifiedAccountTimeline(WALLET, filters);
    for (const event of events) {
      expect(["deposit", "withdrawal"]).toContain(event.type);
    }
  });

  it("filters by protocol", () => {
    const filters: AccountActivityFilters = { protocol: "Blend Stable" };
    const events = buildUnifiedAccountTimeline(WALLET, filters);
    for (const event of events) {
      expect(event.protocol).toBe("Blend Stable");
    }
  });

  it("filters by asset", () => {
    const filters: AccountActivityFilters = { asset: "USDC" };
    const events = buildUnifiedAccountTimeline(WALLET, filters);
    for (const event of events) {
      expect(event.assetSymbol).toBe("USDC");
    }
  });

  it("filters by status", () => {
    const filters: AccountActivityFilters = { status: "completed" };
    const events = buildUnifiedAccountTimeline(WALLET, filters);
    for (const event of events) {
      expect(event.status).toBe("completed");
    }
  });

  it("applies combined filters (type + protocol)", () => {
    const filters: AccountActivityFilters = {
      types: ["deposit"],
      protocol: "Blend Stable",
    };
    const events = buildUnifiedAccountTimeline(WALLET, filters);
    for (const event of events) {
      expect(event.type).toBe("deposit");
      expect(event.protocol).toBe("Blend Stable");
    }
  });

  it("applies combined filters (type + asset + status)", () => {
    const filters: AccountActivityFilters = {
      types: ["deposit", "withdrawal"],
      asset: "USDC",
      status: "completed",
    };
    const events = buildUnifiedAccountTimeline(WALLET, filters);
    for (const event of events) {
      expect(["deposit", "withdrawal"]).toContain(event.type);
      expect(event.assetSymbol).toBe("USDC");
      expect(event.status).toBe("completed");
    }
  });

  it("returns empty array when no events match filters", () => {
    const filters: AccountActivityFilters = { protocol: "NonExistentProtocol" };
    const events = buildUnifiedAccountTimeline(WALLET, filters);
    expect(events).toHaveLength(0);
  });

  it("all seeded events have protocol field populated", () => {
    const events = buildUnifiedAccountTimeline(WALLET);
    for (const event of events) {
      expect(event.protocol).toBeDefined();
      expect(typeof event.protocol).toBe("string");
      expect(event.protocol!.length).toBeGreaterThan(0);
    }
  });

  it("all seeded events have status field populated", () => {
    const events = buildUnifiedAccountTimeline(WALLET);
    for (const event of events) {
      expect(event.status).toBeDefined();
      expect(["completed", "pending", "failed"]).toContain(event.status);
    }
  });
});
