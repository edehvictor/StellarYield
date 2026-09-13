import { describe, expect, it } from "vitest";
import { formatApy, formatApyDeviation } from "./apyFormat";

describe("formatApy — normal range", () => {
  it("formats a typical APY with 2 decimals", () => {
    expect(formatApy(6.5)).toBe("6.50%");
  });

  it("formats a sub-1% but above-tiny-threshold value with 4 decimals", () => {
    expect(formatApy(0.5)).toBe("0.5000%");
  });

  it("formats exactly zero as 0.00%", () => {
    expect(formatApy(0)).toBe("0.00%");
  });

  it("formats negative values with a leading minus sign", () => {
    expect(formatApy(-3.25)).toBe("-3.25%");
  });

  it("omits the % suffix when suffix: false", () => {
    expect(formatApy(6.5, { suffix: false })).toBe("6.50");
  });
});

describe("formatApy — sub-basis-point (tiny) values", () => {
  it("does not collapse a sub-basis-point value to 0.00%", () => {
    const result = formatApy(0.003);
    expect(result).not.toBe("0.00%");
    expect(result).toBe("0.0030%");
  });

  it("does not collapse an extremely tiny value to 0.00%", () => {
    const result = formatApy(0.00001);
    expect(result).not.toBe("0.00%");
    expect(parseFloat(result)).toBeGreaterThan(0);
  });

  it("caps decimal places for an absurdly tiny value instead of an unbounded string", () => {
    const result = formatApy(0.0000000000001);
    const decimalPlaces = result.replace("%", "").split(".")[1]?.length ?? 0;
    expect(decimalPlaces).toBeLessThanOrEqual(10);
  });

  it("handles a tiny negative value with sign and no zero-collapse", () => {
    const result = formatApy(-0.004);
    expect(result.startsWith("-")).toBe(true);
    expect(result).not.toBe("-0.00%");
  });
});

describe("formatApy — unusually large (synthetic/stress) values", () => {
  it("uses compact K grouping above the large threshold", () => {
    expect(formatApy(15_000)).toBe("15.00K%");
  });

  it("uses compact M grouping for very large synthetic rates", () => {
    expect(formatApy(2_500_000)).toBe("2.50M%");
  });

  it("uses compact B grouping for extreme synthetic rates", () => {
    expect(formatApy(7_800_000_000)).toBe("7.80B%");
  });

  it("does not produce a sprawling digit string for a huge value", () => {
    const result = formatApy(123_456_789);
    expect(result.length).toBeLessThan(12);
  });

  it("stays finite and formatted for Number.MAX_SAFE_INTEGER-scale input", () => {
    const result = formatApy(9_007_199_254_740_991);
    expect(result).not.toContain("NaN");
    expect(result).not.toContain("Infinity");
  });
});

describe("formatApy — non-finite input", () => {
  it("renders an em dash for NaN", () => {
    expect(formatApy(NaN)).toBe("—%");
  });

  it("renders an em dash for Infinity", () => {
    expect(formatApy(Infinity)).toBe("—%");
  });

  it("renders an em dash for -Infinity", () => {
    expect(formatApy(-Infinity)).toBe("—%");
  });
});

describe("formatApyDeviation", () => {
  it("shows a leading + for positive deviations", () => {
    expect(formatApyDeviation(1.5)).toBe("+1.50");
  });

  it("shows a leading - for negative deviations", () => {
    expect(formatApyDeviation(-2)).toBe("-2.00");
  });

  it("has no % suffix", () => {
    expect(formatApyDeviation(3)).not.toContain("%");
  });

  it("does not collapse a tiny deviation to 0", () => {
    const result = formatApyDeviation(0.002);
    expect(result).not.toBe("+0.00");
  });
});