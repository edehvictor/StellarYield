import { describe, it, expect } from "vitest";
import { I128_MAX, parseDecimalToUnits, shortenAddress, validateReviewAmounts } from "./reviewAmounts";

const base = {
  inputToken: { amount: "100" },
  vaultToken: { amount: "99.5", minAmount: "99.0" },
  slippageTolerance: 0.5,
};

describe("parseDecimalToUnits", () => {
  it("parses zero, minimum and typical values exactly", () => {
    expect(parseDecimalToUnits("0")).toBe(BigInt(0));
    expect(parseDecimalToUnits("0.0000001")).toBe(BigInt(1));
    expect(parseDecimalToUnits("99.5")).toBe(BigInt(995_000_000));
  });
  it("is exact at the i128 maximum and rejects one above", () => {
    expect(parseDecimalToUnits(I128_MAX.toString(), 0)).toBe(I128_MAX);
    expect(parseDecimalToUnits((I128_MAX + BigInt(1)).toString(), 0)).toBeNull();
  });
  it("does not lose precision on near-limit values float64 cannot hold", () => {
    expect(parseDecimalToUnits("9007199254740993", 0)).toBe(BigInt("9007199254740993"));
  });
  it("rejects excess precision instead of rounding", () => {
    expect(parseDecimalToUnits("0.00000001")).toBeNull();
  });
  it.each(["", "-1", "1e3", "1.", ".5", " 1", "NaN", "Infinity", "1,5"])("rejects malformed %p", (v) => {
    expect(parseDecimalToUnits(v)).toBeNull();
  });
});

describe("validateReviewAmounts", () => {
  it("accepts a normal review", () => {
    expect(validateReviewAmounts(base)).toEqual({ valid: true });
  });
  it("blocks zero deposit and zero estimated output", () => {
    expect(validateReviewAmounts({ ...base, inputToken: { amount: "0" } }).valid).toBe(false);
    expect(validateReviewAmounts({ ...base, vaultToken: { amount: "0" } }).valid).toBe(false);
  });
  it("allows a zero guaranteed minimum at the boundary", () => {
    expect(validateReviewAmounts({ ...base, vaultToken: { amount: "0.0000001", minAmount: "0" } }).valid).toBe(true);
  });
  it("allows min equal to estimate, blocks min above estimate by one unit", () => {
    expect(validateReviewAmounts({ ...base, vaultToken: { amount: "1", minAmount: "1" } }).valid).toBe(true);
    expect(validateReviewAmounts({ ...base, vaultToken: { amount: "1", minAmount: "1.0000001" } }).valid).toBe(false);
  });
  it("blocks non-finite or out-of-range slippage", () => {
    for (const s of [NaN, Infinity, -0.1, 100.01]) {
      expect(validateReviewAmounts({ ...base, slippageTolerance: s }).valid).toBe(false);
    }
    expect(validateReviewAmounts({ ...base, slippageTolerance: 0 }).valid).toBe(true);
    expect(validateReviewAmounts({ ...base, slippageTolerance: 100 }).valid).toBe(true);
  });
  it("blocks overflow amounts", () => {
    expect(
      validateReviewAmounts({ ...base, inputToken: { amount: (I128_MAX + BigInt(1)).toString(), decimals: 0 } }).valid,
    ).toBe(false);
  });
});

describe("shortenAddress", () => {
  it("shortens long addresses and leaves short ones whole", () => {
    expect(shortenAddress("GBWM7FAKESTELLARWALLETADDRESS123456")).toBe("GBWM7F…3456");
    expect(shortenAddress("GABC")).toBe("GABC");
    expect(shortenAddress("")).toBe("");
  });
});
