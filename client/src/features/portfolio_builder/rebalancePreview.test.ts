import { describe, it, expect } from "vitest";
import {
  buildRebalanceRequest,
  summarizeApyDelta,
  hasWarnings,
  type RebalancePreview,
} from "./rebalancePreview";
import type { VaultAllocation } from "./types";

const vault = (
  id: string,
  name: string,
  apy: number,
  weight: number,
): VaultAllocation => ({
  vaultContractId: id,
  vaultName: name,
  apy,
  weight,
  amount: 0n,
});

describe("buildRebalanceRequest", () => {
  it("pairs current and target weights by vault id", () => {
    const current = [vault("c1", "Blend", 8, 50), vault("c2", "Soroswap", 4, 50)];
    const target = [vault("c1", "Blend", 8, 70), vault("c2", "Soroswap", 4, 30)];

    const req = buildRebalanceRequest(10_000, current, target);

    expect(req.totalValueUsd).toBe(10_000);
    expect(req.allocations).toEqual([
      { label: "Blend", currentWeight: 50, targetWeight: 70, apy: 8 },
      { label: "Soroswap", currentWeight: 50, targetWeight: 30, apy: 4 },
    ]);
  });

  it("treats a newly added vault as 0% current weight", () => {
    const current = [vault("c1", "Blend", 8, 100)];
    const target = [vault("c1", "Blend", 8, 60), vault("c2", "New", 10, 40)];

    const req = buildRebalanceRequest(5_000, current, target);
    const added = req.allocations.find((a) => a.label === "New");
    expect(added?.currentWeight).toBe(0);
    expect(added?.targetWeight).toBe(40);
  });
});

describe("summarizeApyDelta", () => {
  const preview = (apyDeltaPct: number): RebalancePreview => ({
    isSimulationOnly: true,
    legs: [],
    blendedApyBefore: 6,
    blendedApyAfter: 6 + apyDeltaPct,
    apyDeltaPct,
    totalTurnoverUsd: 0,
    estimatedFeeUsd: 0,
    maxDriftPct: 0,
    warnings: [],
  });

  it("labels a positive delta as up with a + sign", () => {
    const summary = summarizeApyDelta(preview(0.8));
    expect(summary.direction).toBe("up");
    expect(summary.label).toBe("+0.80%");
  });

  it("labels a negative delta as down", () => {
    expect(summarizeApyDelta(preview(-1.25)).direction).toBe("down");
    expect(summarizeApyDelta(preview(-1.25)).label).toBe("-1.25%");
  });

  it("labels a zero delta as flat", () => {
    expect(summarizeApyDelta(preview(0)).direction).toBe("flat");
  });
});

describe("hasWarnings", () => {
  it("is true only when the preview carries warnings", () => {
    const base: RebalancePreview = {
      isSimulationOnly: true,
      legs: [],
      blendedApyBefore: 6,
      blendedApyAfter: 6,
      apyDeltaPct: 0,
      totalTurnoverUsd: 0,
      estimatedFeeUsd: 0,
      maxDriftPct: 0,
      warnings: [],
    };
    expect(hasWarnings(base)).toBe(false);
    expect(hasWarnings({ ...base, warnings: ["High fees: …"] })).toBe(true);
  });
});
