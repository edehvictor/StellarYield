import { describe, expect, it } from "vitest";
import {
  distributeByWeight,
  DUST_VALIDATION_MESSAGES,
  PortfolioDustValidationError,
  validatePortfolioDust,
} from "./portfolioDust";

const vault = (id: string, weight: number, name = id) => ({
  vaultContractId: id,
  vaultName: name,
  weight,
});

describe("portfolio dust validation", () => {
  it("accepts a clean two-vault split", () => {
    const result = validatePortfolioDust({
      totalAmount: 1_000n,
      allocations: [vault("blend", 50), vault("soroswap", 50)],
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.message).toBe(DUST_VALIDATION_MESSAGES.valid);
    expect(result.suggestedAllocations).toBeNull();
  });

  it("flags allocations that round to zero and suggests redistributing them", () => {
    const result = validatePortfolioDust({
      totalAmount: 2n,
      allocations: [
        vault("blend", 50, "Blend"),
        vault("soroswap", 25, "Soroswap"),
        vault("defindex", 25, "DeFindex"),
      ],
    });

    expect(result.valid).toBe(false);
    expect(
      result.issues.filter((issue) => issue.code === "AMOUNT_ROUNDS_TO_ZERO"),
    ).toHaveLength(2);
    expect(result.issues.map((issue) => issue.vaultName)).toEqual(
      expect.arrayContaining(["Soroswap", "DeFindex"]),
    );

    const suggested = result.suggestedAllocations;
    expect(suggested).not.toBeNull();
    expect(suggested).toHaveLength(1);
    expect(suggested?.[0].vaultContractId).toBe("blend");
    expect(suggested?.[0].weight).toBeCloseTo(100, 10);
  });

  it("flags an amount below a custom minimum deposit", () => {
    const result = validatePortfolioDust({
      totalAmount: 100n,
      minimumAllocationAmount: 10n,
      allocations: [vault("blend", 2), vault("soroswap", 98)],
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      code: "AMOUNT_BELOW_MINIMUM",
      vaultContractId: "blend",
      amount: 2n,
      minimumAmount: 10n,
    });
    expect(result.issues[0].message).toContain("below the 10 unit minimum");
  });

  it("flags a non-zero weight below the minimum weight threshold", () => {
    const result = validatePortfolioDust({
      totalAmount: 1_000_000n,
      allocations: [vault("blend", 0.005, "Blend"), vault("soroswap", 99.995)],
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe("WEIGHT_BELOW_MINIMUM");
    expect(result.issues[0].message).toContain("0.01% minimum non-zero weight");
  });

  it("treats an empty total as an empty state, not as dust", () => {
    const result = validatePortfolioDust({
      totalAmount: 0n,
      allocations: [vault("blend", 50), vault("soroswap", 50)],
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.message).toBe(DUST_VALIDATION_MESSAGES.emptyTotal);
  });

  it("treats an empty allocation list as an empty state", () => {
    const result = validatePortfolioDust({ totalAmount: 100n, allocations: [] });

    expect(result.valid).toBe(true);
    expect(result.message).toBe(DUST_VALIDATION_MESSAGES.emptyAllocations);
  });

  it("returns no cleanup suggestion when every allocation is dust", () => {
    const result = validatePortfolioDust({
      totalAmount: 100n,
      minimumAllocationAmount: 1_000n,
      allocations: [vault("blend", 50), vault("soroswap", 50)],
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.suggestedAllocations).toBeNull();
  });

  it("ignores intentionally zero-weight vaults", () => {
    const result = validatePortfolioDust({
      totalAmount: 100n,
      allocations: [vault("blend", 100), vault("unused", 0)],
    });

    expect(result.valid).toBe(true);
  });

  it("distributes every base unit exactly once", () => {
    const amounts = distributeByWeight(10_001n, [
      vault("a", 33.33),
      vault("b", 33.33),
      vault("c", 33.34),
    ]);

    expect(amounts.reduce((sum, amount) => sum + amount, 0n)).toBe(10_001n);
  });

  it("throws typed errors for malformed input", () => {
    expect(() =>
      validatePortfolioDust({ totalAmount: -1n, allocations: [] }),
    ).toThrow(PortfolioDustValidationError);
    expect(() =>
      validatePortfolioDust({
        totalAmount: 100n,
        allocations: [vault("blend", Number.NaN)],
      }),
    ).toThrow(PortfolioDustValidationError);
  });
});
