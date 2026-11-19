import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDepositImpact } from "./useDepositImpact";
import type { QuoteSnapshot } from "./useDepositImpact";
import {
  ALL_ROUTE_FIXTURES,
  DIRECT_ROUTE,
  SINGLE_HOP_ROUTE,
  ONE_INTERMEDIATE_HOP_ROUTE,
  MULTI_HOP_ROUTE,
  MULTI_HOP_ROUTE_ALTERNATE_PATH,
  DEEP_MULTI_HOP_ROUTE,
  type RouteFixture,
} from "./multiHopRouteFixtures";

/**
 * Regression coverage for deposit impact estimation across multi-hop zap
 * routes (issue #863). Complements `useDepositImpact.test.ts`, which covers
 * the non-route signals (slippage, deposit size, fallback/stale, fragmentation).
 *
 * These tests pin down:
 *  - Impact stays stable (no spurious escalation) for shallow routes.
 *  - Warnings scale predictably with route depth as routes gain hops.
 *  - A route re-priced through a different path is caught even when the
 *    nominal output amount barely moves.
 */

const base = {
  amountUsd: 0,
  slippageTolerance: 1,
  isFallback: false,
  isStale: false,
};

function makeQuote(route: string[], overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    quotedAt: new Date().toISOString(),
    route,
    expectedOut: 10_000_000n,
    minOut: 9_950_000n,
    isFallback: false,
    isStale: false,
    ...overrides,
  };
}

describe("multi-hop route fixtures", () => {
  it("fixture hop counts match route edge counts", () => {
    for (const fixture of ALL_ROUTE_FIXTURES) {
      expect(fixture.hopCount).toBe(Math.max(0, fixture.route.length - 1));
    }
  });

  it("MULTI_HOP_ROUTE and its alternate cover the same hop count via a different path", () => {
    expect(MULTI_HOP_ROUTE.hopCount).toBe(MULTI_HOP_ROUTE_ALTERNATE_PATH.hopCount);
    expect(MULTI_HOP_ROUTE.route).not.toEqual(MULTI_HOP_ROUTE_ALTERNATE_PATH.route);
  });
});

describe("useDepositImpact — route depth", () => {
  it.each<RouteFixture>([DIRECT_ROUTE, SINGLE_HOP_ROUTE, ONE_INTERMEDIATE_HOP_ROUTE])(
    "stays at severity=none and score=0 for shallow route: $description",
    (fixture) => {
      const quote = makeQuote(fixture.route);
      const { result } = renderHook(() => useDepositImpact({ ...base, quote }));
      expect(result.current.severity).toBe("none");
      expect(result.current.impactScore).toBe(0);
      expect(result.current.reasons).toHaveLength(0);
    },
  );

  it("adds a route-depth reason (score +15) once a route has more than one intermediate hop", () => {
    const quote = makeQuote(MULTI_HOP_ROUTE.route);
    const { result } = renderHook(() => useDepositImpact({ ...base, quote }));
    expect(result.current.impactScore).toBe(15);
    // Alone, a moderate route-depth signal shouldn't escalate severity.
    expect(result.current.severity).toBe("none");
    expect(
      result.current.reasons.some((r) => r.includes("3 hops") && r.includes("intermediate pools")),
    ).toBe(true);
  });

  it("escalates to severity=warning for a deep multi-hop route on its own (score +30)", () => {
    const quote = makeQuote(DEEP_MULTI_HOP_ROUTE.route);
    const { result } = renderHook(() => useDepositImpact({ ...base, quote }));
    expect(result.current.impactScore).toBe(30);
    expect(result.current.severity).toBe("warning");
    expect(
      result.current.reasons.some((r) => r.includes("5 hops") && r.includes("compound execution risk")),
    ).toBe(true);
  });

  it("combines route depth with other risk factors to reach critical severity", () => {
    const quote = makeQuote(MULTI_HOP_ROUTE.route);
    const { result } = renderHook(() =>
      useDepositImpact({
        ...base,
        slippageTolerance: 8, // +40
        amountUsd: 600_000, // +40 -> already clamps, so use a lighter combo below
        quote,
      }),
    );
    // 40 (slippage) + 40 (amount) + 15 (route depth) = 95, under the 100 cap.
    expect(result.current.impactScore).toBe(95);
    expect(result.current.severity).toBe("critical");
  });

  it("produces a stable (non-escalating) score across repeated renders of the same multi-hop route", () => {
    const quote = makeQuote(MULTI_HOP_ROUTE.route);
    const { result, rerender } = renderHook(
      (props: { quote: QuoteSnapshot }) => useDepositImpact({ ...base, quote: props.quote }),
      { initialProps: { quote } },
    );
    const first = result.current.impactScore;
    rerender({ quote: makeQuote(MULTI_HOP_ROUTE.route) });
    expect(result.current.impactScore).toBe(first);
    expect(result.current.severity).toBe("none");
  });
});

describe("useDepositImpact — path changes under equal nominal output", () => {
  it("flags a route path change when the output amount stays nominal (<5% delta)", () => {
    const quote = makeQuote(MULTI_HOP_ROUTE.route, {
      expectedOut: 10_020_000n, // 0.2% delta from prevExpectedOut — nominally unchanged
      prevExpectedOut: 10_000_000n,
      prevRoute: MULTI_HOP_ROUTE_ALTERNATE_PATH.route,
    });
    const { result } = renderHook(() => useDepositImpact({ ...base, quote }));

    expect(
      result.current.reasons.some(
        (r) => r.includes("Route path changed") && r.includes("nominal"),
      ),
    ).toBe(true);
    // Route-depth (15) + path-change-under-nominal-output (20) = 35.
    expect(result.current.impactScore).toBe(35);
    expect(result.current.severity).toBe("warning");
  });

  it("uses a distinct, lower-weight reason when the path changes alongside a material output change", () => {
    const quote = makeQuote(MULTI_HOP_ROUTE.route, {
      expectedOut: 8_500_000n, // 15% delta — material, not nominal
      prevExpectedOut: 10_000_000n,
      prevRoute: MULTI_HOP_ROUTE_ALTERNATE_PATH.route,
    });
    const { result } = renderHook(() => useDepositImpact({ ...base, quote }));

    expect(
      result.current.reasons.some((r) => r.includes("changed by") && r.includes("since last fetch")),
    ).toBe(true);
    expect(
      result.current.reasons.some(
        (r) => r.includes("Route path changed alongside the output amount"),
      ),
    ).toBe(true);
    expect(
      result.current.reasons.some((r) => r.includes("nominal")),
    ).toBe(false);
  });

  it("does not flag a path change when the route is unchanged, even at deep hop counts", () => {
    const quote = makeQuote(DEEP_MULTI_HOP_ROUTE.route, {
      expectedOut: 10_000_000n,
      prevExpectedOut: 10_000_000n,
      prevRoute: DEEP_MULTI_HOP_ROUTE.route,
    });
    const { result } = renderHook(() => useDepositImpact({ ...base, quote }));

    expect(result.current.reasons.some((r) => r.includes("Route path changed"))).toBe(false);
    // Only the route-depth signal should contribute.
    expect(result.current.impactScore).toBe(30);
  });

  it("does not flag a path change when no prevRoute was supplied", () => {
    const quote = makeQuote(MULTI_HOP_ROUTE_ALTERNATE_PATH.route, {
      expectedOut: 10_000_000n,
      prevExpectedOut: 10_000_000n,
      // prevRoute intentionally omitted
    });
    const { result } = renderHook(() => useDepositImpact({ ...base, quote }));

    expect(result.current.reasons.some((r) => r.includes("Route path changed"))).toBe(false);
  });

  it("treats reordered identical hops as a real path change, not a no-op", () => {
    const quote = makeQuote(["CXLM", "CUSDC", "CAQUA", "CVAULT"], {
      expectedOut: 10_010_000n,
      prevExpectedOut: 10_000_000n,
      prevRoute: ["CXLM", "CAQUA", "CUSDC", "CVAULT"],
    });
    const { result } = renderHook(() => useDepositImpact({ ...base, quote }));

    expect(result.current.reasons.some((r) => r.includes("Route path changed"))).toBe(true);
  });
});

describe("useDepositImpact — full regression matrix across route fixtures", () => {
  it.each<[string, RouteFixture, number, "none" | "warning" | "critical"]>([
    [DIRECT_ROUTE.description, DIRECT_ROUTE, 0, "none"],
    [SINGLE_HOP_ROUTE.description, SINGLE_HOP_ROUTE, 0, "none"],
    [ONE_INTERMEDIATE_HOP_ROUTE.description, ONE_INTERMEDIATE_HOP_ROUTE, 0, "none"],
    [MULTI_HOP_ROUTE.description, MULTI_HOP_ROUTE, 15, "none"],
    [DEEP_MULTI_HOP_ROUTE.description, DEEP_MULTI_HOP_ROUTE, 30, "warning"],
  ])("%s", (_desc, fixture, expectedScore, expectedSeverity) => {
    const quote = makeQuote(fixture.route);
    const { result } = renderHook(() => useDepositImpact({ ...base, quote }));
    expect(result.current.impactScore).toBe(expectedScore);
    expect(result.current.severity).toBe(expectedSeverity);
  });
});
