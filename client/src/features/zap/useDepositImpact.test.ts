import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDepositImpact } from "./useDepositImpact";

const base = {
  amountUsd: 0,
  slippageTolerance: 1,
  isFallback: false,
  isStale: false,
};

describe("useDepositImpact", () => {
  it("returns severity=none for baseline inputs", () => {
    const { result } = renderHook(() => useDepositImpact(base));
    expect(result.current.severity).toBe("none");
    expect(result.current.reasons).toHaveLength(0);
    expect(result.current.impactScore).toBe(0);
  });

  it("adds slippage reason for elevated slippage (3–7%)", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, slippageTolerance: 5 }),
    );
    expect(result.current.reasons.some((r) => r.includes("slippage"))).toBe(true);
    expect(result.current.impactScore).toBe(20);
  });

  it("reaches warning severity when elevated slippage combines with fallback", () => {
    // slippage 5%: +20, fallback: +15 → 35 → warning
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, slippageTolerance: 5, isFallback: true }),
    );
    expect(result.current.severity).toBe("warning");
    expect(result.current.impactScore).toBe(35);
  });

  it("reaches warning severity for high slippage (>=8%)", () => {
    // high slippage: +40 → warning
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, slippageTolerance: 8 }),
    );
    expect(result.current.severity).toBe("warning");
    expect(result.current.reasons.some((r) => r.includes("8%"))).toBe(true);
    expect(result.current.impactScore).toBe(40);
  });

  it("reaches critical severity when high slippage and large deposit combine", () => {
    // high slippage: +40, large deposit: +40 → 80 → critical
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, slippageTolerance: 8, amountUsd: 600_000 }),
    );
    expect(result.current.severity).toBe("critical");
    expect(result.current.impactScore).toBe(80);
  });

  it("adds reason for moderate deposit size (>=50k USD)", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, amountUsd: 75_000 }),
    );
    expect(result.current.reasons.some((r) => r.includes("75k"))).toBe(true);
    expect(result.current.impactScore).toBe(20);
  });

  it("adds reason and higher score for large deposit size (>=500k USD)", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, amountUsd: 600_000 }),
    );
    expect(result.current.reasons.some((r) => r.includes("600k"))).toBe(true);
    expect(result.current.impactScore).toBe(40);
  });

  it("adds fallback reason when isFallback=true", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, isFallback: true }),
    );
    expect(result.current.reasons.some((r) => r.toLowerCase().includes("fallback"))).toBe(true);
    expect(result.current.impactScore).toBe(15);
  });

  it("adds stale reason when isStale=true", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, isStale: true }),
    );
    expect(result.current.reasons.some((r) => r.toLowerCase().includes("stale"))).toBe(true);
    expect(result.current.impactScore).toBe(10);
  });

  it("fallback + stale together reach warning threshold (score=25)", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, isFallback: true, isStale: true }),
    );
    expect(result.current.impactScore).toBe(25);
    expect(result.current.severity).toBe("warning");
  });

  it("adds degraded execution quality reason for score 50–69", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, executionQualityScore: 60 }),
    );
    expect(result.current.reasons.some((r) => r.includes("60/100"))).toBe(true);
    expect(result.current.impactScore).toBe(20);
  });

  it("adds critical execution quality reason for score <50", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, executionQualityScore: 40 }),
    );
    expect(result.current.reasons.some((r) => r.includes("40/100"))).toBe(true);
    expect(result.current.severity).toBe("warning");
    expect(result.current.impactScore).toBe(35);
  });

  it("reaches critical when very low execution quality combines with large deposit", () => {
    // low quality: +35, large deposit: +40 → 75 → critical
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, executionQualityScore: 40, amountUsd: 600_000 }),
    );
    expect(result.current.severity).toBe("critical");
  });

  it("adds materialImpact reason when flag is true", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, materialImpact: true }),
    );
    expect(result.current.reasons.some((r) => r.toLowerCase().includes("material impact"))).toBe(true);
    expect(result.current.impactScore).toBe(15);
  });

  it("clamps impactScore at 100", () => {
    const { result } = renderHook(() =>
      useDepositImpact({
        amountUsd: 600_000,
        slippageTolerance: 10,
        isFallback: true,
        isStale: true,
        executionQualityScore: 30,
        materialImpact: true,
      }),
    );
    expect(result.current.impactScore).toBeLessThanOrEqual(100);
    expect(result.current.severity).toBe("critical");
  });
});
