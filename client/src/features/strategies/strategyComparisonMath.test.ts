import { describe, expect, it } from "vitest";
import {
  MAX_FEE_BPS,
  MAX_FEE_DRAG_BPS,
  StrategyComparisonCalculationError,
  assertFeeBps,
  assertRiskScore,
  assertUsdAmount,
  bpsToPercent,
  checkedFeeDragBps,
  comparableValue,
  formatApy,
  formatComparisonCurrency,
  roundHalfUp,
} from "./strategyComparisonMath";

describe("roundHalfUp (#1922)", () => {
  it("rounds half away from zero at two decimals, without float drift", () => {
    expect(roundHalfUp(1.005)).toBe(1.01);
    expect(roundHalfUp(4.004)).toBe(4);
    expect(roundHalfUp(-1.005)).toBe(-1.01);
    expect(roundHalfUp(0)).toBe(0);
    expect(Object.is(roundHalfUp(-0.001), 0)).toBe(true);
  });

  it("refuses non-finite input instead of returning NaN", () => {
    expect(() => roundHalfUp(Number.NaN)).toThrow(StrategyComparisonCalculationError);
    expect(() => roundHalfUp(Number.POSITIVE_INFINITY)).toThrow(StrategyComparisonCalculationError);
  });
});

describe("fee basis points", () => {
  it("accepts zero, the maximum and values near it", () => {
    expect(assertFeeBps(0)).toBe(0);
    expect(assertFeeBps(MAX_FEE_BPS)).toBe(10_000);
    expect(assertFeeBps(MAX_FEE_BPS - 1)).toBe(9_999);
  });

  it("refuses negative, above-maximum, fractional and non-numeric fees", () => {
    for (const bad of [-1, MAX_FEE_BPS + 1, 12.5, Number.NaN, Number.POSITIVE_INFINITY, "50", null]) {
      expect(() => assertFeeBps(bad)).toThrow(StrategyComparisonCalculationError);
    }
  });

  it("sums fee drag with checked arithmetic up to 2 x 100%", () => {
    expect(checkedFeeDragBps(0, 0)).toBe(0);
    expect(checkedFeeDragBps(30, 1000)).toBe(1030);
    expect(checkedFeeDragBps(MAX_FEE_BPS, MAX_FEE_BPS)).toBe(MAX_FEE_DRAG_BPS);
    expect(() => checkedFeeDragBps(MAX_FEE_BPS + 1, 0)).toThrow(StrategyComparisonCalculationError);
    expect(() => checkedFeeDragBps(Number.MAX_SAFE_INTEGER, 1)).toThrow(
      StrategyComparisonCalculationError,
    );
  });

  it("converts bps to a two-decimal percentage", () => {
    expect(bpsToPercent(0)).toBe(0);
    expect(bpsToPercent(1)).toBe(0.01);
    expect(bpsToPercent(125)).toBe(1.25);
    expect(bpsToPercent(MAX_FEE_BPS)).toBe(100);
  });
});

describe("USD amounts and risk scores", () => {
  it("accepts zero and the safe-integer maximum, refuses beyond", () => {
    expect(assertUsdAmount(0)).toBe(0);
    expect(assertUsdAmount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => assertUsdAmount(-0.01)).toThrow(StrategyComparisonCalculationError);
    expect(() => assertUsdAmount(Number.MAX_SAFE_INTEGER * 2)).toThrow(
      StrategyComparisonCalculationError,
    );
    expect(() => assertUsdAmount(Number.POSITIVE_INFINITY)).toThrow(
      StrategyComparisonCalculationError,
    );
  });

  it("keeps the risk score on its 0-100 scale", () => {
    expect(assertRiskScore(0)).toBe(0);
    expect(assertRiskScore(100)).toBe(100);
    expect(() => assertRiskScore(-1)).toThrow(StrategyComparisonCalculationError);
    expect(() => assertRiskScore(100.01)).toThrow(StrategyComparisonCalculationError);
    expect(() => assertRiskScore(Number.NaN)).toThrow(StrategyComparisonCalculationError);
  });
});

describe("display formatting", () => {
  it("formats APY half-up to two decimals, negatives included", () => {
    expect(formatApy(0)).toBe("0.00");
    expect(formatApy(8.675)).toBe("8.68");
    expect(formatApy(-3.005)).toBe("-3.01");
    expect(() => formatApy(Number.NaN)).toThrow(StrategyComparisonCalculationError);
  });

  it("chooses the currency tier after rounding, so near-limit values never read $1000.0K", () => {
    expect(formatComparisonCurrency(0)).toBe("$0.00");
    expect(formatComparisonCurrency(999.994)).toBe("$999.99");
    expect(formatComparisonCurrency(999.995)).toBe("$1.0K");
    expect(formatComparisonCurrency(999_949)).toBe("$999.9K");
    expect(formatComparisonCurrency(999_950)).toBe("$1.00M");
    expect(formatComparisonCurrency(12_400_000)).toBe("$12.40M");
    expect(() => formatComparisonCurrency(-1)).toThrow(StrategyComparisonCalculationError);
  });

  it("treats NaN and infinities as not comparable", () => {
    expect(comparableValue(0)).toBe(0);
    expect(comparableValue(Number.NaN)).toBeNull();
    expect(comparableValue(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(comparableValue(undefined)).toBeNull();
  });
});
