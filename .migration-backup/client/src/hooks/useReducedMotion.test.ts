import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useReducedMotion } from "./useReducedMotion";

type MQListener = (e: MediaQueryListEvent) => void;

function makeMQ(matches: boolean) {
  const listeners: MQListener[] = [];
  return {
    matches,
    addEventListener: vi.fn((_: string, fn: MQListener) => listeners.push(fn)),
    removeEventListener: vi.fn((_: string, fn: MQListener) => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    }),
    _fire(newMatches: boolean) {
      listeners.forEach((fn) => fn({ matches: newMatches } as MediaQueryListEvent));
    },
  };
}

describe("useReducedMotion", () => {
  let mq: ReturnType<typeof makeMQ>;

  beforeEach(() => {
    mq = makeMQ(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(mq as unknown as MediaQueryList);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false when prefers-reduced-motion is not set", () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it("returns true when prefers-reduced-motion: reduce is set", () => {
    mq = makeMQ(true);
    vi.spyOn(window, "matchMedia").mockReturnValue(mq as unknown as MediaQueryList);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it("updates when the media query changes", () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      mq._fire(true);
    });

    expect(result.current).toBe(true);
  });

  it("removes the event listener on unmount", () => {
    const { unmount } = renderHook(() => useReducedMotion());
    unmount();
    expect(mq.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
