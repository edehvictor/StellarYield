import { describe, it, expect } from "vitest";
import {
  computeAllocationDeltas,
  formatValueDelta,
  formatWeightDelta,
} from "./allocationDelta";
import type { VaultAllocation } from "./types";

const vault = (
  id: string,
  name: string,
  weight: number,
): VaultAllocation => ({
  vaultContractId: id,
  vaultName: name,
  apy: 8,
  weight,
  amount: 0n,
});

// ── computeAllocationDeltas ────────────────────────────────────────────────

describe("computeAllocationDeltas", () => {
  it("marks rows with higher next weight as increases", () => {
    const prev = [vault("a", "Blend", 50), vault("b", "Soroswap", 50)];
    const next = [vault("a", "Blend", 70), vault("b", "Soroswap", 30)];

    const { rows } = computeAllocationDeltas(10_000, prev, next);

    const blend = rows.find((r) => r.vaultContractId === "a")!;
    const soro = rows.find((r) => r.vaultContractId === "b")!;

    expect(blend.direction).toBe("increase");
    expect(blend.weightDeltaPct).toBeCloseTo(20);
    expect(soro.direction).toBe("decrease");
    expect(soro.weightDeltaPct).toBeCloseTo(-20);
  });

  it("marks unchanged rows when weights are identical", () => {
    const allocs = [vault("a", "Blend", 60), vault("b", "Soroswap", 40)];
    const { rows, hasChanges } = computeAllocationDeltas(5_000, allocs, allocs);

    expect(rows.every((r) => r.direction === "unchanged")).toBe(true);
    expect(hasChanges).toBe(false);
  });

  it("computes USD value deltas proportionally to totalValueUsd", () => {
    const prev = [vault("a", "Blend", 50), vault("b", "Soroswap", 50)];
    const next = [vault("a", "Blend", 80), vault("b", "Soroswap", 20)];

    const { rows } = computeAllocationDeltas(1_000, prev, next);

    const blend = rows.find((r) => r.vaultContractId === "a")!;
    expect(blend.previousValueUsd).toBeCloseTo(500);
    expect(blend.nextValueUsd).toBeCloseTo(800);
    expect(blend.valueDeltaUsd).toBeCloseTo(300);
  });

  it("treats a vault absent from previous as previousWeight=0 (new position)", () => {
    const prev = [vault("a", "Blend", 100)];
    const next = [vault("a", "Blend", 60), vault("b", "New Vault", 40)];

    const { rows } = computeAllocationDeltas(2_000, prev, next);

    const newVault = rows.find((r) => r.vaultContractId === "b")!;
    expect(newVault.previousWeight).toBe(0);
    expect(newVault.direction).toBe("increase");
  });

  it("marks totalIsValid=true when next weights sum to 100", () => {
    const prev = [vault("a", "Blend", 100)];
    const next = [vault("a", "Blend", 60), vault("b", "Soro", 40)];

    const { totalIsValid, nextWeightTotal } = computeAllocationDeltas(0, prev, next);

    expect(totalIsValid).toBe(true);
    expect(nextWeightTotal).toBeCloseTo(100);
  });

  it("marks totalIsValid=false when next weights do not sum to 100", () => {
    const prev = [vault("a", "Blend", 100)];
    const next = [vault("a", "Blend", 60), vault("b", "Soro", 30)]; // sum = 90

    const { totalIsValid, nextWeightTotal } = computeAllocationDeltas(0, prev, next);

    expect(totalIsValid).toBe(false);
    expect(nextWeightTotal).toBeCloseTo(90);
  });

  it("preserves stable insertion order — prev vaults first", () => {
    const prev = [vault("b", "B", 50), vault("a", "A", 50)];
    const next = [vault("b", "B", 40), vault("a", "A", 40), vault("c", "C", 20)];

    const { rows } = computeAllocationDeltas(0, prev, next);

    expect(rows.map((r) => r.vaultContractId)).toEqual(["b", "a", "c"]);
  });
});

// ── formatValueDelta ───────────────────────────────────────────────────────

describe("formatValueDelta", () => {
  it("prefixes positive values with +$", () => {
    expect(formatValueDelta(1234.56)).toBe("+$1,234.56");
  });

  it("prefixes negative values with −$", () => {
    expect(formatValueDelta(-500)).toBe("−$500.00");
  });

  it("treats zero as positive", () => {
    expect(formatValueDelta(0)).toBe("+$0.00");
  });
});

// ── formatWeightDelta ──────────────────────────────────────────────────────

describe("formatWeightDelta", () => {
  it("formats a positive delta with + and pp suffix", () => {
    expect(formatWeightDelta(5.0)).toBe("+5.0pp");
  });

  it("formats a negative delta with − and pp suffix", () => {
    expect(formatWeightDelta(-3.5)).toBe("−3.5pp");
  });
});
