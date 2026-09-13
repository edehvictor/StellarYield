import { calculateDailyMovement } from "../../../shared/types/dailyMovement";

describe("calculateDailyMovement", () => {
  const walletAddress = "GTEST123";

  describe("with no previous snapshot", () => {
    it("should return neutral state", () => {
      const current = {
        walletAddress,
        totalValueUsd: 10000,
        assetBreakdown: { USDC: { valueUsd: 5000, quantity: 5000 } },
        protocolBreakdown: { Blend: { valueUsd: 10000 } },
      };

      const result = calculateDailyMovement(current, undefined);

      expect(result.hasPreviousSnapshot).toBe(false);
      expect(result.totalAbsoluteChange).toBe(0);
      expect(result.totalPercentChange).toBe(0);
      expect(result.assetMovements).toEqual([]);
      expect(result.protocolMovements).toEqual([]);
      expect(result.previousTotalValue).toBe(0);
      expect(result.currentTotalValue).toBe(10000);
    });

    it("should show only today's deposits and no price movement", () => {
      const current = {
        walletAddress,
        totalValueUsd: 10000,
        assetBreakdown: {},
        protocolBreakdown: {},
      };

      const result = calculateDailyMovement(current, undefined, {
        deposited: 10000,
        withdrawn: 0,
      });

      expect(result.depositedToday).toBe(10000);
      expect(result.withdrawnToday).toBe(0);
      expect(result.priceMovementOnly).toBe(0);
    });
  });

  describe("with previous snapshot", () => {
    const previous = {
      totalValueUsd: 10000,
      assetBreakdown: {
        USDC: { valueUsd: 5000, quantity: 5000 },
        XLM: { valueUsd: 5000, quantity: 2500 },
      },
      protocolBreakdown: {
        Blend: { valueUsd: 5000 },
        Soroswap: { valueUsd: 5000 },
      },
    };

    it("should calculate positive movement correctly", () => {
      const current = {
        walletAddress,
        totalValueUsd: 11000,
        assetBreakdown: {
          USDC: { valueUsd: 5500, quantity: 5500 },
          XLM: { valueUsd: 5500, quantity: 2750 },
        },
        protocolBreakdown: {
          Blend: { valueUsd: 5500 },
          Soroswap: { valueUsd: 5500 },
        },
      };

      const result = calculateDailyMovement(current, previous);

      expect(result.hasPreviousSnapshot).toBe(true);
      expect(result.totalAbsoluteChange).toBe(1000);
      expect(result.totalPercentChange).toBeCloseTo(10, 1);
      expect(result.isNegativeMovement).toBe(false);
      expect(result.assetMovements).toHaveLength(2);
      expect(result.protocolMovements).toHaveLength(2);
    });

    it("should calculate negative movement correctly", () => {
      const current = {
        walletAddress,
        totalValueUsd: 9000,
        assetBreakdown: {
          USDC: { valueUsd: 4500, quantity: 4500 },
          XLM: { valueUsd: 4500, quantity: 2250 },
        },
        protocolBreakdown: {
          Blend: { valueUsd: 4500 },
          Soroswap: { valueUsd: 4500 },
        },
      };

      const result = calculateDailyMovement(current, previous);

      expect(result.totalAbsoluteChange).toBe(-1000);
      expect(result.totalPercentChange).toBeCloseTo(-10, 1);
      expect(result.isNegativeMovement).toBe(true);
    });

    it("should exclude deposits from price movement calculation", () => {
      const current = {
        walletAddress,
        totalValueUsd: 12000, // +2000 total, but +1000 deposited, so +1000 from price
        assetBreakdown: {
          USDC: { valueUsd: 6000, quantity: 6000 },
          XLM: { valueUsd: 6000, quantity: 3000 },
        },
        protocolBreakdown: {
          Blend: { valueUsd: 6000 },
          Soroswap: { valueUsd: 6000 },
        },
      };

      const result = calculateDailyMovement(current, previous, {
        deposited: 1000,
        withdrawn: 0,
      });

      expect(result.totalAbsoluteChange).toBe(2000);
      expect(result.depositedToday).toBe(1000);
      expect(result.priceMovementOnly).toBeCloseTo(1000, 1); // 2000 - 1000 = 1000
    });

    it("should exclude withdrawals from price movement calculation", () => {
      const current = {
        walletAddress,
        totalValueUsd: 9000, // -1000 total, but -500 withdrawn, so -500 from price
        assetBreakdown: {
          USDC: { valueUsd: 4500, quantity: 4500 },
          XLM: { valueUsd: 4500, quantity: 2250 },
        },
        protocolBreakdown: {
          Blend: { valueUsd: 4500 },
          Soroswap: { valueUsd: 4500 },
        },
      };

      const result = calculateDailyMovement(current, previous, {
        deposited: 0,
        withdrawn: 500,
      });

      expect(result.totalAbsoluteChange).toBe(-1000);
      expect(result.withdrawnToday).toBe(500);
      expect(result.priceMovementOnly).toBeCloseTo(-500, 1); // -1000 - (-500) = -500
    });

    it("should handle new assets in current snapshot", () => {
      const current = {
        walletAddress,
        totalValueUsd: 11500,
        assetBreakdown: {
          USDC: { valueUsd: 5000, quantity: 5000 },
          XLM: { valueUsd: 5000, quantity: 2500 },
          AQUA: { valueUsd: 1500, quantity: 150 }, // New asset
        },
        protocolBreakdown: {
          Blend: { valueUsd: 5000 },
          Soroswap: { valueUsd: 6500 },
        },
      };

      const result = calculateDailyMovement(current, previous);

      const aquaMovement = result.assetMovements.find(
        (m) => m.asset === "AQUA",
      );
      expect(aquaMovement).toBeDefined();
      expect(aquaMovement?.previousValue).toBe(0);
      expect(aquaMovement?.currentValue).toBe(1500);
      expect(aquaMovement?.percentChange).toBe(100);
    });

    it("should handle removed assets (zero balance now)", () => {
      const current = {
        walletAddress,
        totalValueUsd: 5000,
        assetBreakdown: {
          USDC: { valueUsd: 5000, quantity: 5000 },
          // XLM is gone
        },
        protocolBreakdown: {
          Blend: { valueUsd: 5000 },
        },
      };

      const result = calculateDailyMovement(current, previous);

      const xlmMovement = result.assetMovements.find((m) => m.asset === "XLM");
      expect(xlmMovement).toBeDefined();
      expect(xlmMovement?.previousValue).toBe(5000);
      expect(xlmMovement?.currentValue).toBe(0);
      expect(xlmMovement?.percentChange).toBe(-100);
    });

    it("should sort asset movements by absolute change descending", () => {
      const current = {
        walletAddress,
        totalValueUsd: 10500,
        assetBreakdown: {
          USDC: { valueUsd: 5250, quantity: 5250 }, // +250
          XLM: { valueUsd: 5250, quantity: 2625 }, // +250
        },
        protocolBreakdown: {
          Blend: { valueUsd: 10500 },
        },
      };

      const result = calculateDailyMovement(current, previous);

      expect(result.assetMovements[0].absoluteChange).toBeGreaterThanOrEqual(
        result.assetMovements[1].absoluteChange,
      );
    });

    it("should calculate protocol movements correctly", () => {
      const current = {
        walletAddress,
        totalValueUsd: 10000,
        assetBreakdown: {
          USDC: { valueUsd: 5000, quantity: 5000 },
          XLM: { valueUsd: 5000, quantity: 2500 },
        },
        protocolBreakdown: {
          Blend: { valueUsd: 6000 }, // +1000
          Soroswap: { valueUsd: 4000 }, // -1000
        },
      };

      const result = calculateDailyMovement(current, previous);

      const blendMovement = result.protocolMovements.find(
        (m) => m.protocol === "Blend",
      );
      const soroswapMovement = result.protocolMovements.find(
        (m) => m.protocol === "Soroswap",
      );

      expect(blendMovement?.absoluteChange).toBe(1000);
      expect(blendMovement?.percentChange).toBeCloseTo(20, 1);
      expect(soroswapMovement?.absoluteChange).toBe(-1000);
      expect(soroswapMovement?.percentChange).toBeCloseTo(-20, 1);
    });
  });

  describe("edge cases", () => {
    it("should handle zero portfolio value", () => {
      const current = {
        walletAddress,
        totalValueUsd: 0,
        assetBreakdown: {},
        protocolBreakdown: {},
      };

      const result = calculateDailyMovement(current, undefined);

      expect(result.currentTotalValue).toBe(0);
      expect(result.totalAbsoluteChange).toBe(0);
      expect(result.totalPercentChange).toBe(0);
    });

    it("should handle previous zero portfolio value (growth from zero)", () => {
      const previous = {
        totalValueUsd: 0,
        assetBreakdown: {},
        protocolBreakdown: {},
      };

      const current = {
        walletAddress,
        totalValueUsd: 5000,
        assetBreakdown: { USDC: { valueUsd: 5000, quantity: 5000 } },
        protocolBreakdown: { Blend: { valueUsd: 5000 } },
      };

      const result = calculateDailyMovement(current, previous);

      expect(result.previousTotalValue).toBe(0);
      expect(result.currentTotalValue).toBe(5000);
      expect(result.totalPercentChange).toBe(100);
    });

    it("should handle large deposits with price loss", () => {
      const previous = {
        totalValueUsd: 10000,
        assetBreakdown: { USDC: { valueUsd: 10000, quantity: 10000 } },
        protocolBreakdown: { Blend: { valueUsd: 10000 } },
      };

      const current = {
        walletAddress,
        totalValueUsd: 14000, // +4000 total but -1000 price loss
        assetBreakdown: { USDC: { valueUsd: 14000, quantity: 14000 } },
        protocolBreakdown: { Blend: { valueUsd: 14000 } },
      };

      const result = calculateDailyMovement(current, previous, {
        deposited: 5000,
        withdrawn: 0,
      });

      expect(result.totalAbsoluteChange).toBe(4000);
      expect(result.depositedToday).toBe(5000);
      expect(result.priceMovementOnly).toBeCloseTo(-1000, 1); // 4000 - 5000 = -1000
      expect(result.isNegativeMovement).toBe(false); // Total is positive
    });
  });
});
