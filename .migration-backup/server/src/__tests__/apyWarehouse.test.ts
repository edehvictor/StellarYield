/**
 * Tests for the APY Warehouse service (#250).
 *
 * The service layer calls connectToDatabase() and then Mongoose model methods.
 * We mock both so the tests run without a real MongoDB instance.
 */

jest.mock("../db/database", () => ({
  connectToDatabase: jest.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// In-memory store — module-scoped so mock closures can reference it at
// call-time (not at mock-definition time).
// ---------------------------------------------------------------------------
type SnapshotRecord = {
  protocolId: string;
  apy: number;
  tvl: number;
  timestamp: Date;
  source: string;
};

const snapshotStore: SnapshotRecord[] = [];

jest.mock("../models/ApySnapshot", () => {
  // Each mock function reads snapshotStore at call-time, not definition-time.
  const findOne = jest.fn((query: { protocolId?: string; timestamp?: Date }) => {
    const match =
      snapshotStore.find(
        (s) =>
          s.protocolId === query.protocolId &&
          s.timestamp?.getTime() === (query.timestamp as Date)?.getTime(),
      ) ?? null;
    // Return a thenable so `await ApySnapshotModel.findOne(...)` resolves
    return Promise.resolve(match);
  });

  const create = jest.fn((data: SnapshotRecord) => {
    const doc = { ...data };
    snapshotStore.push(doc);
    // Plain object — service handles both `.toObject()` and plain objects
    return Promise.resolve(doc);
  });

  const find = jest.fn(
    (query: {
      protocolId?: string;
      timestamp?: { $gte?: Date; $lte?: Date };
    }) => ({
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(
        snapshotStore
          .filter((s) => {
            if (query.protocolId && s.protocolId !== query.protocolId)
              return false;
            if (query.timestamp?.$gte && s.timestamp < query.timestamp.$gte)
              return false;
            if (query.timestamp?.$lte && s.timestamp > query.timestamp.$lte)
              return false;
            return true;
          })
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
      ),
    }),
  );

  // In-process aggregation: reads snapshotStore at call-time.
  const aggregate = jest.fn(
    (
      pipeline: Array<Record<string, unknown>>,
    ) => {
      const matchStage = pipeline.find((s) => "$match" in s) as
        | { $match: { protocolId?: string; timestamp?: { $gte?: Date; $lte?: Date } } }
        | undefined;
      const groupStage = pipeline.find((s) => "$group" in s) as
        | { $group: { _id: Record<string, unknown> } }
        | undefined;

      if (!matchStage || !groupStage) return Promise.resolve([]);

      const { protocolId, timestamp } = matchStage.$match;

      const filtered = snapshotStore.filter((s) => {
        if (protocolId && s.protocolId !== protocolId) return false;
        if (timestamp?.$gte && s.timestamp < timestamp.$gte) return false;
        if (timestamp?.$lte && s.timestamp > timestamp.$lte) return false;
        return true;
      });

      const idKeys = Object.keys(groupStage.$group._id);
      const isHourly = idKeys.includes("hour");

      const buckets = new Map<
        string,
        { apySum: number; count: number; _id: Record<string, number> }
      >();

      for (const s of filtered) {
        const d = s.timestamp;
        const key = isHourly
          ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`
          : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

        const _id: Record<string, number> = isHourly
          ? {
              year: d.getFullYear(),
              month: d.getMonth() + 1,
              day: d.getDate(),
              hour: d.getHours(),
            }
          : { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };

        const existing = buckets.get(key);
        if (existing) {
          existing.apySum += s.apy;
          existing.count += 1;
        } else {
          buckets.set(key, { apySum: s.apy, count: 1, _id });
        }
      }

      return Promise.resolve(
        Array.from(buckets.values()).map((b) => ({
          _id: b._id,
          avgApy: b.apySum / b.count,
          count: b.count,
        })),
      );
    },
  );

  return {
    ApySnapshotModel: { findOne, create, find, aggregate },
  };
});

import {
  ingestSnapshot,
  getHourlyRollup,
  getDailyRollup,
  getRange,
} from "../services/apyWarehouseService";
import { ApySnapshotModel } from "../models/ApySnapshot";

beforeEach(() => {
  snapshotStore.length = 0;
  jest.clearAllMocks();
});

// ------------------------------------------------------------------
// ingestSnapshot — idempotency / duplicate prevention
// ------------------------------------------------------------------

describe("ingestSnapshot", () => {
  const baseSnapshot: SnapshotRecord = {
    protocolId: "Blend",
    apy: 6.45,
    tvl: 12_400_000,
    timestamp: new Date("2024-01-01T12:00:00Z"),
    source: "stellar://blend",
  };

  it("stores a new snapshot and returns it", async () => {
    const result = await ingestSnapshot(baseSnapshot);

    expect(result.protocolId).toBe("Blend");
    expect(result.apy).toBe(6.45);
    expect(ApySnapshotModel.create).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: duplicate protocolId+timestamp returns existing without creating again", async () => {
    // First call — stored
    await ingestSnapshot(baseSnapshot);
    // Second call — findOne now returns the stored record
    const result = await ingestSnapshot(baseSnapshot);

    expect(ApySnapshotModel.create).toHaveBeenCalledTimes(1);
    expect(result.protocolId).toBe("Blend");
  });

  it("stores snapshots for different protocols independently", async () => {
    await ingestSnapshot(baseSnapshot);
    await ingestSnapshot({ ...baseSnapshot, protocolId: "Soroswap" });

    expect(ApySnapshotModel.create).toHaveBeenCalledTimes(2);
  });

  it("stores snapshots for same protocol at different timestamps independently", async () => {
    await ingestSnapshot(baseSnapshot);
    await ingestSnapshot({
      ...baseSnapshot,
      timestamp: new Date("2024-01-01T13:00:00Z"),
    });

    expect(ApySnapshotModel.create).toHaveBeenCalledTimes(2);
  });
});

// ------------------------------------------------------------------
// getHourlyRollup
// ------------------------------------------------------------------

describe("getHourlyRollup", () => {
  beforeEach(() => {
    // Seed: 3 snapshots within hour 12, and 2 within hour 13
    const base = new Date("2024-03-01T12:00:00Z");
    for (let i = 0; i < 3; i++) {
      const ts = new Date(base.getTime() + i * 10 * 60 * 1000); // +10 min each
      snapshotStore.push({
        protocolId: "Blend",
        apy: 6.0 + i * 0.5, // 6.0, 6.5, 7.0
        tvl: 10_000_000,
        timestamp: ts,
        source: "internal",
      });
    }
    const hour13 = new Date("2024-03-01T13:00:00Z");
    for (let i = 0; i < 2; i++) {
      snapshotStore.push({
        protocolId: "Blend",
        apy: 8.0 + i,
        tvl: 10_000_000,
        timestamp: new Date(hour13.getTime() + i * 5 * 60 * 1000),
        source: "internal",
      });
    }
  });

  it("returns one bucket per hour", async () => {
    const from = new Date("2024-03-01T00:00:00Z");
    const to = new Date("2024-03-01T23:59:59Z");
    const buckets = await getHourlyRollup("Blend", from, to);

    expect(buckets.length).toBe(2);
  });

  it("calculates correct average APY per bucket", async () => {
    const from = new Date("2024-03-01T00:00:00Z");
    const to = new Date("2024-03-01T23:59:59Z");
    const buckets = await getHourlyRollup("Blend", from, to);

    // Sort by bucket string to get stable order
    buckets.sort((a, b) => a.bucket.localeCompare(b.bucket));

    // Hour 12: avg of 6.0, 6.5, 7.0 = 6.5
    expect(buckets[0].avgApy).toBeCloseTo(6.5, 5);
    expect(buckets[0].count).toBe(3);

    // Hour 13: avg of 8.0, 9.0 = 8.5
    expect(buckets[1].avgApy).toBeCloseTo(8.5, 5);
    expect(buckets[1].count).toBe(2);
  });

  it("returns empty array when no data in range", async () => {
    const from = new Date("2025-01-01T00:00:00Z");
    const to = new Date("2025-01-02T00:00:00Z");
    const buckets = await getHourlyRollup("Blend", from, to);

    expect(buckets).toHaveLength(0);
  });
});

// ------------------------------------------------------------------
// getDailyRollup
// ------------------------------------------------------------------

describe("getDailyRollup", () => {
  beforeEach(() => {
    // Seed: 2 days, 3 snapshots on day 1, 2 on day 2
    const day1 = new Date("2024-03-01T10:00:00Z");
    [4.0, 5.0, 6.0].forEach((apy, i) => {
      snapshotStore.push({
        protocolId: "Soroswap",
        apy,
        tvl: 5_000_000,
        timestamp: new Date(day1.getTime() + i * 3600 * 1000),
        source: "internal",
      });
    });
    const day2 = new Date("2024-03-02T08:00:00Z");
    [7.0, 9.0].forEach((apy, i) => {
      snapshotStore.push({
        protocolId: "Soroswap",
        apy,
        tvl: 5_000_000,
        timestamp: new Date(day2.getTime() + i * 3600 * 1000),
        source: "internal",
      });
    });
  });

  it("returns one bucket per day", async () => {
    const from = new Date("2024-03-01T00:00:00Z");
    const to = new Date("2024-03-02T23:59:59Z");
    const buckets = await getDailyRollup("Soroswap", from, to);

    expect(buckets.length).toBe(2);
  });

  it("calculates correct average APY per day", async () => {
    const from = new Date("2024-03-01T00:00:00Z");
    const to = new Date("2024-03-02T23:59:59Z");
    const buckets = await getDailyRollup("Soroswap", from, to);

    buckets.sort((a, b) => a.bucket.localeCompare(b.bucket));

    // Day 1: avg of 4, 5, 6 = 5
    expect(buckets[0].avgApy).toBeCloseTo(5, 5);
    expect(buckets[0].count).toBe(3);

    // Day 2: avg of 7, 9 = 8
    expect(buckets[1].avgApy).toBeCloseTo(8, 5);
    expect(buckets[1].count).toBe(2);
  });

  it("excludes snapshots outside the requested range", async () => {
    const from = new Date("2024-03-02T00:00:00Z");
    const to = new Date("2024-03-02T23:59:59Z");
    const buckets = await getDailyRollup("Soroswap", from, to);

    expect(buckets.length).toBe(1);
  });
});

// ------------------------------------------------------------------
// getRange
// ------------------------------------------------------------------

describe("getRange", () => {
  beforeEach(() => {
    const base = new Date("2024-04-01T00:00:00Z");
    for (let i = 0; i < 5; i++) {
      snapshotStore.push({
        protocolId: "Blend",
        apy: 5 + i,
        tvl: 1_000_000,
        timestamp: new Date(base.getTime() + i * 3600 * 1000),
        source: "internal",
      });
    }
  });

  it("returns raw snapshots ordered by timestamp ascending", async () => {
    const from = new Date("2024-04-01T00:00:00Z");
    const to = new Date("2024-04-01T23:59:59Z");
    const snapshots = await getRange("Blend", from, to);

    expect(snapshots.length).toBe(5);
    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i].timestamp >= snapshots[i - 1].timestamp).toBe(true);
    }
  });

  it("returns empty array when no snapshots in range", async () => {
    const from = new Date("2025-01-01T00:00:00Z");
    const to = new Date("2025-01-02T00:00:00Z");
    const snapshots = await getRange("Blend", from, to);

    expect(snapshots).toHaveLength(0);
  });

  it("does not include snapshots from other protocols", async () => {
    // Add a snapshot for a different protocol
    snapshotStore.push({
      protocolId: "Other",
      apy: 99,
      tvl: 1,
      timestamp: new Date("2024-04-01T01:30:00Z"),
      source: "internal",
    });

    const from = new Date("2024-04-01T00:00:00Z");
    const to = new Date("2024-04-01T23:59:59Z");
    const snapshots = await getRange("Blend", from, to);

    expect(snapshots.every((s) => s.protocolId === "Blend")).toBe(true);
  });
});
