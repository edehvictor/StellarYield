import { describe, it, expect } from "vitest";
import { parseDecimalToStroops, formatStroopsToDecimal } from "./amount";

describe("parseDecimalToStroops", () => {
  it("parses whole and fractional parts", () => {
    expect(parseDecimalToStroops("1", 7)).toBe(10_000_000n);
    expect(parseDecimalToStroops("1.5", 7)).toBe(15_000_000n);
    expect(parseDecimalToStroops(".25", 7)).toBe(2_500_000n);
  });

  it("rejects invalid input", () => {
    expect(() => parseDecimalToStroops("abc", 7)).toThrow();
  });
});

describe("formatStroopsToDecimal", () => {
  it("formats stroops with decimals", () => {
    expect(formatStroopsToDecimal(10_500_000n, 7)).toBe("1.05");
    expect(formatStroopsToDecimal(10_000_000n, 7)).toBe("1");
  });

  it("formats negative stroops", () => {
    expect(formatStroopsToDecimal(-5_000_000n, 7)).toBe("-0.5");
  });
});

describe("parseDecimalToStroops extra branches", () => {
  it("parses negative decimal amounts", () => {
    expect(parseDecimalToStroops("-2.5", 7)).toBe(-25_000_000n);
  });
});
