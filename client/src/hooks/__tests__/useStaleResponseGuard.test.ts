import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useStaleResponseGuard } from "../useStaleResponseGuard";

describe("useStaleResponseGuard", () => {
  describe("token generation", () => {
    it("returns a numeric token from startRequest", () => {
      const { result } = renderHook(() => useStaleResponseGuard());
      const token = result.current.startRequest();
      expect(typeof token).toBe("number");
    });

    it("returns incrementing tokens on each call", () => {
      const { result } = renderHook(() => useStaleResponseGuard());
      const t1 = result.current.startRequest();
      const t2 = result.current.startRequest();
      const t3 = result.current.startRequest();
      expect(t2).toBeGreaterThan(t1);
      expect(t3).toBeGreaterThan(t2);
    });
  });

  describe("isCurrent checks", () => {
    it("returns true when token matches the latest request", () => {
      const { result } = renderHook(() => useStaleResponseGuard());
      const token = result.current.startRequest();
      expect(result.current.isCurrent(token)).toBe(true);
    });

    it("returns false when a newer request has started", () => {
      const { result } = renderHook(() => useStaleResponseGuard());
      const oldToken = result.current.startRequest();
      result.current.startRequest(); // newer request
      expect(result.current.isCurrent(oldToken)).toBe(false);
    });

    it("returns false for an unknown token value", () => {
      const { result } = renderHook(() => useStaleResponseGuard());
      result.current.startRequest();
      expect(result.current.isCurrent(999999)).toBe(false);
    });

    it("returns true for the most recent token after multiple requests", () => {
      const { result } = renderHook(() => useStaleResponseGuard());
      result.current.startRequest();
      result.current.startRequest();
      const latestToken = result.current.startRequest();
      expect(result.current.isCurrent(latestToken)).toBe(true);
    });
  });

  describe("rapid navigation simulation", () => {
    it("marks all but the latest response as stale", () => {
      const { result } = renderHook(() => useStaleResponseGuard());

      // Simulate: navigate to page A, start fetch
      const tokenA = result.current.startRequest();
      // Simulate: navigate to page B quickly, start fetch
      const tokenB = result.current.startRequest();
      // Simulate: navigate back to page A, start fetch
      const tokenC = result.current.startRequest();

      // Fetch A resolves — should be stale
      expect(result.current.isCurrent(tokenA)).toBe(false);
      // Fetch B resolves — should be stale
      expect(result.current.isCurrent(tokenB)).toBe(false);
      // Fetch C resolves — should be current
      expect(result.current.isCurrent(tokenC)).toBe(true);
    });

    it("handles sequential rapid requests correctly", () => {
      const { result } = renderHook(() => useStaleResponseGuard());

      const tokens: number[] = [];
      for (let i = 0; i < 10; i++) {
        tokens.push(result.current.startRequest());
      }

      // Only the last token should be current
      for (let i = 0; i < tokens.length - 1; i++) {
        expect(result.current.isCurrent(tokens[i])).toBe(false);
      }
      expect(result.current.isCurrent(tokens[tokens.length - 1])).toBe(true);
    });
  });

  describe("reference stability", () => {
    it("startRequest and isCurrent references are stable across re-renders", () => {
      const { result, rerender } = renderHook(() => useStaleResponseGuard());
      const startRef1 = result.current.startRequest;
      const isCurrentRef1 = result.current.isCurrent;

      rerender();

      expect(result.current.startRequest).toBe(startRef1);
      expect(result.current.isCurrent).toBe(isCurrentRef1);
    });
  });
});
