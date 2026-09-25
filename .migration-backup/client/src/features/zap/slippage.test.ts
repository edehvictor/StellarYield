import { describe, it, expect } from "vitest";
import { minAmountAfterSlippage } from "./slippage";

describe("minAmountAfterSlippage", () => {
  it("applies half-percent slippage to 1e7 stroops", () => {
    const expected = 10_000_000n;
    const min = minAmountAfterSlippage(expected, 0.5);
    expect(min).toBe(9_950_000n);
  });

  it("handles 1% slippage", () => {
    const min = minAmountAfterSlippage(10000n, 1);
    expect(min).toBe(9900n);
  });

  it("throws for invalid slippage", () => {
    expect(() => minAmountAfterSlippage(100n, -1)).toThrow(RangeError);
    expect(() => minAmountAfterSlippage(100n, 100)).toThrow(RangeError);
  });
});
