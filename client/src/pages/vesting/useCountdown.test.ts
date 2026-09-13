import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCountdown } from "./useCountdown";
import { computeCountdownParts } from "./vestingCountdown";

describe("computeCountdownParts", () => {
  const target = 1_700_000_000;

  it("returns expired when now equals target timestamp", () => {
    expect(computeCountdownParts(target, target * 1000)).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      expired: true,
    });
  });

  it("returns expired one millisecond after the boundary", () => {
    expect(computeCountdownParts(target, target * 1000 + 1).expired).toBe(true);
  });

  it("shows one second remaining one second before boundary", () => {
    const parts = computeCountdownParts(target, (target - 1) * 1000);
    expect(parts.expired).toBe(false);
    expect(parts.seconds).toBe(1);
  });

  it("shows zero seconds with sub-second remainder still active", () => {
    const parts = computeCountdownParts(target, target * 1000 - 1);
    expect(parts.expired).toBe(false);
    expect(parts.seconds).toBe(0);
  });

  it("returns expired immediately for target timestamp zero", () => {
    expect(computeCountdownParts(0).expired).toBe(true);
  });
});

describe("useCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions from one second remaining to expired on tick", () => {
    const target = Math.floor(Date.now() / 1000) + 1;
    const { result } = renderHook(() => useCountdown(target));

    expect(result.current.seconds).toBe(1);
    expect(result.current.expired).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current.expired).toBe(true);
    expect(result.current.seconds).toBe(0);
  });

  it("recomputes when target timestamp changes", () => {
    const firstTarget = Math.floor(Date.now() / 1000) + 10;
    const { result, rerender } = renderHook(
      ({ target }) => useCountdown(target),
      { initialProps: { target: firstTarget } },
    );

    expect(result.current.seconds).toBe(10);

    const secondTarget = Math.floor(Date.now() / 1000) + 30;
    rerender({ target: secondTarget });

    expect(result.current.seconds).toBe(30);
  });
});
