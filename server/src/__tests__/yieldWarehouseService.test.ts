import {
  computeHourlyRollups,
  computeDailyRollups,
  getHistoricalRange,
  getProtocolStats,
} from "../services/yieldWarehouseService";

jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn(),
}));

jest.mock("../db/database", () => ({
  connectToDatabase: jest.fn().mockResolvedValue(true),
}));

const mockYieldData = [
  {
    protocolName: "Blend",
    apy: 6.75,
    tvl: 12_500_000,
    riskScore: 8.5,
    source: "stellar://blend",
    fetchedAt: "2026-03-25T10:00:00.000Z",
  },
  {
    protocolName: "Soroswap",
    apy: 11.2,
    tvl: 4_850_000,
    riskScore: 7.2,
    source: "stellar://soroswap",
    fetchedAt: "2026-03-25T10:00:00.000Z",
  },
];

jest.mock("../models/YieldSnapshot", () => {
  const mockHourlyInsert = jest.fn().mockReturnValue({
    upsert: jest.fn().mockResolvedValue(true),
  });
  const mockDailyInsert = jest.fn().mockReturnValue({
    upsert: jest.fn().mockResolvedValue(true),
  });

  return {
    YieldSnapshotModel: {
      insertMany: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    },
    HourlyRollupModel: {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
      findOneAndUpdate: mockHourlyInsert,
    },
    DailyRollupModel: {
      find: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
      findOneAndUpdate: mockDailyInsert,
    },
  };
});

jest.mock("../models/YieldSnapshot", () => ({
  YieldSnapshotModel: {
    insertMany: jest.fn().mockResolvedValue([]),
    find: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    }),
  },
  HourlyRollupModel: {
    find: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    }),
    findOneAndUpdate: jest.fn().mockReturnValue({
      upsert: jest.fn().mockResolvedValue(true),
    }),
  },
  DailyRollupModel: {
    find: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    }),
    findOneAndUpdate: jest.fn().mockReturnValue({
      upsert: jest.fn().mockResolvedValue(true),
    }),
  },
}));

import { getYieldData } from "../services/yieldService";

describe("yieldWarehouseService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("computeHourlyRollups", () => {
    it("returns 0 when no database", async () => {
      const { connectToDatabase } = require("../db/database");
      (connectToDatabase as jest.Mock).mockResolvedValueOnce(null);

      const result = await computeHourlyRollups();

      expect(result).toBe(0);
    });

    it("returns 0 when no snapshots found", async () => {
      const result = await computeHourlyRollups(new Date());

      expect(result).toBe(0);
    });

    it("computes rollups correctly from snapshots", async () => {
      const { YieldSnapshotModel } = require("../models/YieldSnapshot");
      const mockSnapshots = [
        {
          protocolName: "Blend",
          apy: 6.5,
          tvl: 12_000_000,
          snapshotAt: new Date(),
        },
        {
          protocolName: "Blend",
          apy: 6.7,
          tvl: 12_200_000,
          snapshotAt: new Date(),
        },
      ];
      (YieldSnapshotModel.find as jest.Mock).mockReturnValue({
        lean: jest.fn().mockResolvedValue(mockSnapshots),
      });

      const result = await computeHourlyRollups(new Date());

      expect(result).toBe(1);
    });
  });

  describe("computeDailyRollups", () => {
    it("returns 0 when no database", async () => {
      const { connectToDatabase } = require("../db/database");
      (connectToDatabase as jest.Mock).mockResolvedValueOnce(null);

      const result = await computeDailyRollups();

      expect(result).toBe(0);
    });

    it("returns 0 when no hourly rollups found", async () => {
      const result = await computeDailyRollups(new Date());

      expect(result).toBe(0);
    });

    it("computes daily rollups correctly", async () => {
      const { HourlyRollupModel } = require("../models/YieldSnapshot");
      const mockHourly = [
        { protocolName: "Blend", avgApy: 6.5, avgTvl: 12_000_000, sampleCount: 10, hourStart: new Date() },
        { protocolName: "Blend", avgApy: 6.7, avgTvl: 12_200_000, sampleCount: 10, hourStart: new Date() },
      ];
      (HourlyRollupModel.find as jest.Mock).mockReturnValue({
        lean: jest.fn().mockResolvedValue(mockHourly),
      });

      const result = await computeDailyRollups(new Date());

      expect(result).toBe(1);
    });
  });

  describe("getHistoricalRange", () => {
    it("returns empty array when no database", async () => {
      const { connectToDatabase } = require("../db/database");
      (connectToDatabase as jest.Mock).mockResolvedValueOnce(null);

      const result = await getHistoricalRange({
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-01-31"),
        granularity: "daily",
      });

      expect(result).toEqual([]);
    });

    it("fetches daily granularity", async () => {
      const result = await getHistoricalRange({
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-01-31"),
        granularity: "daily",
      });

      expect(Array.isArray(result)).toBe(true);
    });

    it("fetches hourly granularity", async () => {
      const result = await getHistoricalRange({
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-01-31"),
        granularity: "hourly",
      });

      expect(Array.isArray(result)).toBe(true);
    });

    it("applies protocol filter", async () => {
      const result = await getHistoricalRange({
        protocol: "Blend",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-01-31"),
        granularity: "daily",
      });

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getProtocolStats", () => {
    it("returns null when no database", async () => {
      const { connectToDatabase } = require("../db/database");
      (connectToDatabase as jest.Mock).mockResolvedValueOnce(null);

      const result = await getProtocolStats("Blend");

      expect(result).toBeNull();
    });

    it("returns stats correctly", async () => {
      (getYieldData as jest.Mock).mockResolvedValue(mockYieldData);

      const result = await getProtocolStats("Blend");

      expect(result).not.toBeNull();
      expect(result?.currentApy).toBe(6.75);
    });

    it("handles protocol not found", async () => {
      (getYieldData as jest.Mock).mockResolvedValue(mockYieldData);

      const result = await getProtocolStats("UnknownProtocol");

      expect(result?.currentApy).toBe(0);
    });
  });
});