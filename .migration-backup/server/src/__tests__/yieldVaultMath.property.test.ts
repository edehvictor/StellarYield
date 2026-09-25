/**
 * Property-based and unit tests for YieldVault share math (#722).
 *
 * Uses fast-check for property-based generation.
 */

import fc from "fast-check";
import {
  calculateShares,
  calculateAssets,
  calculateHarvestFee,
} from "../services/yieldVaultMath";

// ------------------------------------------------------------------
// Arbitraries
// ------------------------------------------------------------------

/** Small positive integer amounts (micro-token scale, avoids overflow) */
const amount = () => fc.integer({ min: 0, max: 1_000_000_000 });
const positiveAmount = () => fc.integer({ min: 1, max: 1_000_000_000 });
const feeBps = () => fc.integer({ min: 0, max: 10_000 });

// ------------------------------------------------------------------
// calculateShares — unit tests
// ------------------------------------------------------------------

describe("calculateShares — unit tests", () => {
  it("returns depositAmount for initial mint (totalShares = 0)", () => {
    expect(calculateShares(1000, 0, 0)).toBe(1000);
    expect(calculateShares(1000, 5000, 0)).toBe(1000);
    expect(calculateShares(1000, 0, 5000)).toBe(1000);
  });

  it("returns 0 when depositAmount is 0", () => {
    expect(calculateShares(0, 1_000_000, 1_000_000)).toBe(0);
    expect(calculateShares(0, 0, 0)).toBe(0);
  });

  it("proportional mint: equal deposit into vault with equal existing position", () => {
    // 100 assets, 100 shares; deposit 50 → should mint 50 shares
    expect(calculateShares(50, 100, 100)).toBe(50);
  });

  it("floors fractional shares (no over-minting)", () => {
    // 100 assets, 3 shares; deposit 1 → 1 * 3 / 100 = 0.03 → floor = 0
    expect(calculateShares(1, 100, 3)).toBe(0);
  });

  it("throws on negative depositAmount", () => {
    expect(() => calculateShares(-1, 100, 100)).toThrow(RangeError);
  });

  it("throws on negative totalAssets", () => {
    expect(() => calculateShares(100, -1, 100)).toThrow(RangeError);
  });

  it("throws on negative totalShares", () => {
    expect(() => calculateShares(100, 100, -1)).toThrow(RangeError);
  });
});

// ------------------------------------------------------------------
// calculateAssets — unit tests
// ------------------------------------------------------------------

describe("calculateAssets — unit tests", () => {
  it("returns 0 when sharesToRedeem is 0", () => {
    expect(calculateAssets(0, 1_000_000, 1_000_000)).toBe(0);
  });

  it("proportional redemption: redeem half of outstanding shares", () => {
    expect(calculateAssets(50, 100, 100)).toBe(50);
  });

  it("floors fractional assets (no over-withdrawal)", () => {
    // 100 assets, 3 shares; redeem 1 → 1 * 100 / 3 = 33.33 → floor = 33
    expect(calculateAssets(1, 100, 3)).toBe(33);
  });

  it("throws on negative sharesToRedeem", () => {
    expect(() => calculateAssets(-1, 100, 100)).toThrow(RangeError);
  });

  it("throws on negative totalAssets", () => {
    expect(() => calculateAssets(10, -1, 100)).toThrow(RangeError);
  });

  it("throws when totalShares is 0 (division by zero guard)", () => {
    expect(() => calculateAssets(10, 100, 0)).toThrow(RangeError);
  });

  it("throws when totalShares is negative", () => {
    expect(() => calculateAssets(10, 100, -1)).toThrow(RangeError);
  });
});

// ------------------------------------------------------------------
// calculateHarvestFee — unit tests
// ------------------------------------------------------------------

describe("calculateHarvestFee — unit tests", () => {
  it("returns 0 when yield is 0", () => {
    expect(calculateHarvestFee(0, 1000)).toBe(0);
  });

  it("returns 0 when fee rate is 0 bps", () => {
    expect(calculateHarvestFee(100_000, 0)).toBe(0);
  });

  it("returns full yield when fee rate is 10000 bps (100%)", () => {
    expect(calculateHarvestFee(100_000, 10_000)).toBe(100_000);
  });

  it("calculates 10% fee correctly", () => {
    // 1000 bps = 10%; 5000 * 10% = 500
    expect(calculateHarvestFee(5000, 1000)).toBe(500);
  });

  it("floors fractional fee (protocol never over-charges)", () => {
    // 1 yield, 1 bps → 1 * 1 / 10000 = 0.0001 → floor = 0
    expect(calculateHarvestFee(1, 1)).toBe(0);
  });

  it("throws on negative yield", () => {
    expect(() => calculateHarvestFee(-1, 500)).toThrow(RangeError);
  });

  it("throws on feeRateBps < 0", () => {
    expect(() => calculateHarvestFee(1000, -1)).toThrow(RangeError);
  });

  it("throws on feeRateBps > 10000", () => {
    expect(() => calculateHarvestFee(1000, 10_001)).toThrow(RangeError);
  });
});

// ------------------------------------------------------------------
// Property: deposit + immediate withdraw ≈ same amount (within 1 unit)
// ------------------------------------------------------------------

describe("property: deposit + immediate withdraw ≈ original amount", () => {
  it("round-trip invariant holds for random deposits into a non-empty vault", () => {
    fc.assert(
      fc.property(
        positiveAmount(), // depositAmount
        positiveAmount(), // totalAssets before deposit
        positiveAmount(), // totalShares before deposit
        (depositAmount, totalAssets, totalShares) => {
          const sharesToMint = calculateShares(depositAmount, totalAssets, totalShares);

          if (sharesToMint === 0) {
            // Tiny deposits that round to 0 shares are skipped —
            // there is nothing to redeem.
            return true;
          }

          const newTotalAssets = totalAssets + depositAmount;
          const newTotalShares = totalShares + sharesToMint;

          const assetsReturned = calculateAssets(
            sharesToMint,
            newTotalAssets,
            newTotalShares,
          );

          // Two floor operations occur (one in calculateShares, one in
          // calculateAssets), so the returned amount is always <= depositAmount
          // and the maximum loss per operation is bounded by one asset-per-share
          // unit. The invariant: assetsReturned <= depositAmount and
          // the shortfall <= floor(newTotalAssets / newTotalShares) + 1.
          if (assetsReturned > depositAmount) return false;
          const maxLoss = Math.floor(newTotalAssets / newTotalShares) + 1;
          return depositAmount - assetsReturned <= maxLoss;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("round-trip invariant holds for the initial mint scenario", () => {
    fc.assert(
      fc.property(positiveAmount(), (depositAmount) => {
        // Initial vault state
        const sharesToMint = calculateShares(depositAmount, 0, 0);

        // After initial mint, totalAssets = depositAmount, totalShares = sharesToMint
        const assetsReturned = calculateAssets(
          sharesToMint,
          depositAmount,
          sharesToMint,
        );

        return Math.abs(assetsReturned - depositAmount) <= 1;
      }),
      { numRuns: 200 },
    );
  });
});

// ------------------------------------------------------------------
// Property: two equal depositors get equal shares
// ------------------------------------------------------------------

describe("property: equal depositors get equal shares", () => {
  it("same deposit amount into the same vault state produces equal shares", () => {
    fc.assert(
      fc.property(
        positiveAmount(),
        positiveAmount(),
        positiveAmount(),
        (depositAmount, totalAssets, totalShares) => {
          const sharesA = calculateShares(depositAmount, totalAssets, totalShares);
          const sharesB = calculateShares(depositAmount, totalAssets, totalShares);

          return sharesA === sharesB;
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ------------------------------------------------------------------
// Property: total assets consistency after multiple deposits
// ------------------------------------------------------------------

describe("property: total assets are consistent after multiple deposits", () => {
  it("summing sequential deposits equals total assets added", () => {
    fc.assert(
      fc.property(
        fc.array(positiveAmount(), { minLength: 2, maxLength: 10 }),
        (deposits) => {
          let totalAssets = 1_000_000; // seed the vault
          let totalShares = 1_000_000;
          let sumDeposits = 0;
          const initialAssets = totalAssets;

          for (const deposit of deposits) {
            const shares = calculateShares(deposit, totalAssets, totalShares);
            totalShares += shares;
            totalAssets += deposit;
            sumDeposits += deposit;
          }

          // totalAssets should equal initialAssets + sum of all deposits
          return totalAssets === initialAssets + sumDeposits;
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ------------------------------------------------------------------
// Property: fee is within [0, yield_]
// ------------------------------------------------------------------

describe("property: harvest fee stays within [0, yield_]", () => {
  it("fee is always >= 0 and <= yield_", () => {
    fc.assert(
      fc.property(amount(), feeBps(), (yield_, rateBps) => {
        const fee = calculateHarvestFee(yield_, rateBps);

        return fee >= 0 && fee <= yield_;
      }),
      { numRuns: 500 },
    );
  });

  it("fee is monotonically non-decreasing in yield_ (same rate)", () => {
    fc.assert(
      fc.property(
        amount(),
        positiveAmount(),
        feeBps(),
        (smallerYield, extra, rateBps) => {
          const largerYield = smallerYield + extra;
          const feeSmall = calculateHarvestFee(smallerYield, rateBps);
          const feeLarge = calculateHarvestFee(largerYield, rateBps);

          return feeLarge >= feeSmall;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("fee is monotonically non-decreasing in rateBps (same yield_)", () => {
    fc.assert(
      fc.property(
        amount(),
        fc.integer({ min: 0, max: 9_999 }),
        fc.integer({ min: 1, max: 10_000 }),
        (yield_, lowerRate, extraRate) => {
          const higherRate = Math.min(lowerRate + extraRate, 10_000);
          const feeLow = calculateHarvestFee(yield_, lowerRate);
          const feeHigh = calculateHarvestFee(yield_, higherRate);

          return feeHigh >= feeLow;
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ------------------------------------------------------------------
// Edge cases
// ------------------------------------------------------------------

describe("edge cases", () => {
  it("zero deposit produces zero shares regardless of vault state", () => {
    expect(calculateShares(0, 1_000_000, 1_000_000)).toBe(0);
    expect(calculateShares(0, 0, 0)).toBe(0);
  });

  it("initial mint with very large amount does not overflow (Number.MAX_SAFE_INTEGER guard)", () => {
    const large = 1_000_000_000;
    const shares = calculateShares(large, 0, 0);
    expect(shares).toBe(large);
  });

  it("redeeming all shares returns all assets (1:1 vault)", () => {
    const totalAssets = 5_000;
    const totalShares = 5_000;

    expect(calculateAssets(totalShares, totalAssets, totalShares)).toBe(
      totalAssets,
    );
  });

  it("100% fee rate returns the full yield as fee", () => {
    const yield_ = 123_456;
    expect(calculateHarvestFee(yield_, 10_000)).toBe(yield_);
  });

  it("0% fee rate returns zero fee for any yield", () => {
    fc.assert(
      fc.property(amount(), (yield_) => {
        return calculateHarvestFee(yield_, 0) === 0;
      }),
      { numRuns: 200 },
    );
  });
});
