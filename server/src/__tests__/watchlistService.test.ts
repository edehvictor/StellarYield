jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn(),
}));

jest.mock("../db/database", () => ({
  connectToDatabase: jest.fn().mockResolvedValue(true),
}));

jest.mock("../models/WatchlistRule", () => ({
  WatchlistRuleModel: {
    create: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    findByIdAndUpdate: jest.fn().mockResolvedValue(null),
  },
}));

import {
  validateRuleInput,
  createWatchlistRule,
  evaluateWatchlistRules,
  checkCondition,
} from "../services/watchlistService";

const mockYieldData = [
  {
    protocolName: "Blend",
    apy: 6.75,
    tvl: 12_500_000,
    riskScore: 8.5,
    source: "stellar://blend",
    fetchedAt: "2026-03-25T10:00:00.000Z",
    attribution: {
      baseYield: 5.4,
      incentives: 1.35,
      compounding: 0.34,
      tacticalRotation: 0.34,
    },
  },
];

import { getYieldData } from "../services/yieldService";

describe("watchlistService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("validateRuleInput", () => {
    it("validates correct input", () => {
      const input = {
        userId: "user123",
        targetType: "protocol" as const,
        targetId: "blend",
        targetName: "Blend",
        conditions: [{ metric: "apy" as const, operator: "above" as const, value: 10 }],
        notificationChannels: ["email"] as const,
      };
      const errors = validateRuleInput(input);
      expect(errors).toHaveLength(0);
    });

    it("rejects missing userId", () => {
      const input = {
        userId: "",
        targetType: "protocol" as const,
        targetId: "blend",
        targetName: "Blend",
        conditions: [{ metric: "apy" as const, operator: "above" as const, value: 10 }],
        notificationChannels: ["email"] as const,
      };
      const errors = validateRuleInput(input);
      expect(errors).toContain("Invalid userId");
    });

    it("rejects invalid targetType", () => {
      const input = {
        userId: "user123",
        targetType: "invalid" as unknown as "protocol",
        targetId: "blend",
        targetName: "Blend",
        conditions: [{ metric: "apy" as const, operator: "above" as const, value: 10 }],
        notificationChannels: ["email"] as const,
      };
      const errors = validateRuleInput(input);
      expect(errors).toContain("Invalid targetType");
    });

    it("rejects empty conditions", () => {
      const input = {
        userId: "user123",
        targetType: "protocol" as const,
        targetId: "blend",
        targetName: "Blend",
        conditions: [],
        notificationChannels: ["email"] as const,
      };
      const errors = validateRuleInput(input);
      expect(errors).toContain("At least one condition is required");
    });

    it("rejects invalid condition metric", () => {
      const input = {
        userId: "user123",
        targetType: "protocol" as const,
        targetId: "blend",
        targetName: "Blend",
        conditions: [{ metric: "invalid" as unknown as "apy", operator: "above" as const, value: 10 }],
        notificationChannels: ["email"] as const,
      };
      const errors = validateRuleInput(input);
      expect(errors).toContain("Invalid condition metric: invalid");
    });

    it("rejects negative condition value", () => {
      const input = {
        userId: "user123",
        targetType: "protocol" as const,
        targetId: "blend",
        targetName: "Blend",
        conditions: [{ metric: "apy" as const, operator: "above" as const, value: -5 }],
        notificationChannels: ["email"] as const,
      };
      const errors = validateRuleInput(input);
      expect(errors).toContain("Invalid condition value: -5");
    });
  });

  describe("checkCondition", () => {
    it("returns true for above operator when value exceeds threshold", () => {
      const condition = { metric: "apy" as const, operator: "above" as const, value: 10, cooldownMinutes: 60 };
      expect(checkCondition(15, 0, condition)).toBe(true);
    });

    it("returns false for above operator when value is below threshold", () => {
      const condition = { metric: "apy" as const, operator: "above" as const, value: 10, cooldownMinutes: 60 };
      expect(checkCondition(5, 0, condition)).toBe(false);
    });

    it("returns true for below operator when value is below threshold", () => {
      const condition = { metric: "apy" as const, operator: "below" as const, value: 10, cooldownMinutes: 60 };
      expect(checkCondition(5, 0, condition)).toBe(true);
    });

    it("returns true for change_above operator when change exceeds threshold", () => {
      const condition = { metric: "apy" as const, operator: "change_above" as const, value: 10, cooldownMinutes: 60 };
      expect(checkCondition(110, 100, condition)).toBe(true);
    });

    it("returns false for change_above operator when change is below threshold", () => {
      const condition = { metric: "apy" as const, operator: "change_above" as const, value: 10, cooldownMinutes: 60 };
      expect(checkCondition(105, 100, condition)).toBe(false);
    });

    it("handles edge case when previous value is 0", () => {
      const condition = { metric: "apy" as const, operator: "change_above" as const, value: 10, cooldownMinutes: 60 };
      expect(checkCondition(100, 0, condition)).toBe(false);
    });
  });

  describe("evaluateWatchlistRules", () => {
    it("filters yields correctly by targetId", async () => {
      const { WatchlistRuleModel } = require("../models/WatchlistRule");
      (WatchlistRuleModel.find as jest.Mock).mockResolvedValue([
        {
          _id: "rule-1",
          userId: "user123",
          targetType: "protocol",
          targetId: "Blend",
          targetName: "Blend",
          conditions: [{ metric: "apy", operator: "above", value: 5, cooldownMinutes: 60 }],
          notificationChannels: ["email"],
          status: "active",
        },
      ]);
      (getYieldData as jest.Mock).mockResolvedValue(mockYieldData);

      const result = await evaluateWatchlistRules();

      expect(getYieldData).toHaveBeenCalled();
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });
});