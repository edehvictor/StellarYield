import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDepositImpact } from "./useDepositImpact";
import type { QuoteSnapshot } from "./useDepositImpact";

const base = {
  amountUsd: 0,
  slippageTolerance: 1,
  isFallback: false,
  isStale: false,
};

function makeQuote(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    quotedAt: new Date().toISOString(),
    route: ["CXLM", "CVAULT"],
    expectedOut: 10_000_000n,
    minOut: 9_950_000n,
    isFallback: false,
    isStale: false,
    ...overrides,
  };
}

describe("useDepositImpact", () => {
  it("returns severity=none for baseline inputs", () => {
    const { result } = renderHook(() => useDepositImpact(base));
    expect(result.current.severity).toBe("none");
    expect(result.current.reasons).toHaveLength(0);
    expect(result.current.impactScore).toBe(0);
    expect(result.current.shouldBlock).toBe(false);
  });

  it("blocks when deposit exceeds 25% of route liquidity depth (#1312)", () => {
    const { result } = renderHook(() =>
      useDepositImpact({
        ...base,
        amountUsd: 30_000,
        routeLiquidityDepthUsd: 100_000,
      }),
    );
    expect(result.current.shouldBlock).toBe(true);
    expect(result.current.blockReason).toContain("route liquidity depth");
    expect(result.current.severity).toBe("critical");
    expect(
      result.current.reasons.some((r) => r.includes("route liquidity depth")),
    ).toBe(true);
  });

  it("warns when deposit exceeds 15% but not 25% of depth (#1312)", () => {
    const { result } = renderHook(() =>
      useDepositImpact({
        ...base,
        amountUsd: 20_000,
        routeLiquidityDepthUsd: 100_000,
      }),
    );
    expect(result.current.shouldBlock).toBe(false);
    expect(result.current.severity).toBe("warning");
    expect(
      result.current.reasons.some((r) => r.includes("safety cap")),
    ).toBe(true);
  });

  it("skips depth check when depth is unknown (#1312)", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, amountUsd: 1_000_000 }),
    );
    expect(result.current.shouldBlock).toBe(false);
    expect(
      result.current.reasons.some((r) => r.includes("route liquidity depth")),
    ).toBe(false);
  });

  it("skips depth check when amountUsd is zero (#1312)", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, amountUsd: 0, routeLiquidityDepthUsd: 100 }),
    );
    expect(result.current.shouldBlock).toBe(false);
    expect(
      result.current.reasons.some((r) => r.includes("route liquidity depth")),
    ).toBe(false);
  });

  it("adds slippage reason for elevated slippage (3–7%)", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, slippageTolerance: 5 }),
    );
    expect(result.current.reasons.some((r) => r.includes("slippage"))).toBe(true);
    expect(result.current.impactScore).toBe(20);
  });

  it("reaches warning severity when elevated slippage combines with fallback", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, slippageTolerance: 5, isFallback: true }),
    );
    expect(result.current.severity).toBe("warning");
    expect(result.current.impactScore).toBe(35);
  });

  it("reaches warning severity for high slippage (>=8%)", () => {
    const { result } = renderHook(() =>
      useDepositImpact({ ...base, slippageTolerance: 8 }),
    );
    expect(result.current.severity).toBe("warning");
    expect(result.current.reasons.some((r) => r.includes("8%"))).toBe(true);
    expect(result.current.impactScore).toBe(40);
  });

  it("reaches critical severity when high slippage and large deposit combine", () => {
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

  describe("quote tracking", () => {
    it("adds output delta reason when quote changes significantly", () => {
      const quote = makeQuote({
        expectedOut: 9_000_000n,
        prevExpectedOut: 10_000_000n,
      });
      const { result } = renderHook(() =>
        useDepositImpact({ ...base, quote }),
      );
      expect(result.current.reasons.some((r) => r.includes("changed by"))).toBe(true);
      expect(result.current.impactScore).toBe(25);
    });

    it("adds minor route variation reason for 5-10% output change", () => {
      const quote = makeQuote({
        expectedOut: 9_400_000n,
        prevExpectedOut: 10_000_000n,
      });
      const { result } = renderHook(() =>
        useDepositImpact({ ...base, quote }),
      );
      expect(result.current.reasons.some((r) => r.includes("minor route variation"))).toBe(true);
      expect(result.current.impactScore).toBe(10);
    });

    it("no output delta reason when quote is stable", () => {
      const quote = makeQuote({
        expectedOut: 9_900_000n,
        prevExpectedOut: 10_000_000n,
      });
      const { result } = renderHook(() =>
        useDepositImpact({ ...base, quote }),
      );
      expect(result.current.reasons.some((r) => r.includes("changed by"))).toBe(false);
    });

    it("adds freshness reason for old quotes", () => {
      const oldDate = new Date(Date.now() - 120_000).toISOString();
      const quote = makeQuote({ quotedAt: oldDate });
      const { result } = renderHook(() =>
        useDepositImpact({ ...base, quote }),
      );
      expect(result.current.reasons.some((r) => r.includes("freshness degraded"))).toBe(true);
    });
  });

  describe("blocking", () => {
    it("blocks when quote is stale and blockStaleQuotes is true", () => {
      const { result } = renderHook(() =>
        useDepositImpact({ ...base, isStale: true, blockStaleQuotes: true }),
      );
      expect(result.current.shouldBlock).toBe(true);
      expect(result.current.blockReason).toContain("stale");
    });

    it("does not block when quote is stale but blockStaleQuotes is false", () => {
      const { result } = renderHook(() =>
        useDepositImpact({ ...base, isStale: true, blockStaleQuotes: false }),
      );
      expect(result.current.shouldBlock).toBe(false);
    });

    it("blocks when impact score exceeds route threshold", () => {
      const { result } = renderHook(() =>
        useDepositImpact({
          ...base,
          slippageTolerance: 10,
          amountUsd: 600_000,
          routeImpactThreshold: 70,
        }),
      );
      expect(result.current.shouldBlock).toBe(true);
      expect(result.current.blockReason).toContain("threshold");
    });

    it("does not block when impact score is below route threshold", () => {
      const { result } = renderHook(() =>
        useDepositImpact({
          ...base,
          slippageTolerance: 5,
          routeImpactThreshold: 70,
        }),
      );
      expect(result.current.shouldBlock).toBe(false);
    });

    it("stale quote blocks even at low impact", () => {
      const { result } = renderHook(() =>
        useDepositImpact({
          ...base,
          slippageTolerance: 1,
          isStale: true,
          blockStaleQuotes: true,
        }),
      );
      expect(result.current.shouldBlock).toBe(true);
    });
  });
});
