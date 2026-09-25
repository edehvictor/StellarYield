/**
 * Tests for useOptimisticUpdate hook
 *
 * Covers success, failure, and retry scenarios for optimistic UI updates
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useOptimisticUpdate } from "../useOptimisticUpdate";

describe("useOptimisticUpdate hook", () => {
  interface TestState {
    enabled: boolean;
    value: number;
  }

  const initialState: TestState = { enabled: false, value: 0 };

  describe("successful optimistic update", () => {
    it("should update state optimistically and keep it on success", async () => {
      const onSuccess = vi.fn();
      const { result } = renderHook(() =>
        useOptimisticUpdate({
          initialValue: initialState,
          onSuccess,
        })
      );

      expect(result.current.current).toEqual(initialState);
      expect(result.current.error).toBeNull();
      expect(result.current.isPending).toBe(false);

      const optimisticValue = { enabled: true, value: 0 };
      await act(async () => {
        await result.current.optimisticUpdate(optimisticValue, async () => ({
          enabled: true,
          value: 100,
        }));
      });

      expect(result.current.current).toEqual({ enabled: true, value: 100 });
      expect(result.current.error).toBeNull();
      expect(result.current.isPending).toBe(false);
      expect(onSuccess).toHaveBeenCalledWith({ enabled: true, value: 100 });
    });

    it("should keep optimistic value when operation returns void", async () => {
      const onSuccess = vi.fn();
      const { result } = renderHook(() =>
        useOptimisticUpdate({
          initialValue: initialState,
          onSuccess,
        })
      );

      const optimisticValue = { enabled: true, value: 50 };

      await act(async () => {
        await result.current.optimisticUpdate(optimisticValue, async () => {
          return undefined;
        });
      });

      expect(result.current.current).toEqual(optimisticValue);
      expect(result.current.isPending).toBe(false);
      expect(onSuccess).toHaveBeenCalledWith(optimisticValue);
    });
  });

  describe("failed optimistic update with rollback", () => {
    it("should rollback state on operation failure", async () => {
      const onRollback = vi.fn();
      const onError = vi.fn();
      const { result } = renderHook(() =>
        useOptimisticUpdate({
          initialValue: initialState,
          onRollback,
          onError,
        })
      );

      const optimisticValue = { enabled: true, value: 50 };
      const error = new Error("Save failed");

      await act(async () => {
        await result.current.optimisticUpdate(optimisticValue, async () => {
          throw error;
        });
      });

      expect(result.current.current).toEqual(initialState);
      expect(result.current.error).toBe("Save failed");
      expect(result.current.isPending).toBe(false);
      expect(onRollback).toHaveBeenCalledWith(initialState);
      expect(onError).toHaveBeenCalledWith(error);
    });

    it("should mark state as retryable after failure", async () => {
      const { result } = renderHook(() =>
        useOptimisticUpdate({
          initialValue: initialState,
        })
      );

      const optimisticValue = { enabled: true, value: 50 };

      await act(async () => {
        await result.current.optimisticUpdate(optimisticValue, async () => {
          throw new Error("Network error");
        });
      });

      expect(result.current.canRetry).toBe(true);
      expect(result.current.error).toBe("Network error");
    });

    it("should track previous state for rollback", async () => {
      const { result } = renderHook(() =>
        useOptimisticUpdate({
          initialValue: initialState,
        })
      );

      const optimisticValue = { enabled: true, value: 50 };

      await act(async () => {
        await result.current.optimisticUpdate(optimisticValue, async () => {
          throw new Error("Failed");
        });
      });

      expect(result.current.previous).toEqual(initialState);
    });
  });

  describe("retry functionality", () => {
    it("should retry failed operation", async () => {
      const onSuccess = vi.fn();
      const { result } = renderHook(() =>
        useOptimisticUpdate({
          initialValue: initialState,
          onSuccess,
        })
      );

      const optimisticValue = { enabled: true, value: 50 };
      let attemptCount = 0;

      await act(async () => {
        await result.current.optimisticUpdate(optimisticValue, async () => {
          attemptCount++;
          if (attemptCount === 1) {
            throw new Error("First attempt failed");
          }
          return { enabled: true, value: 100 };
        });
      });

      expect(result.current.current).toEqual(initialState);
      expect(result.current.canRetry).toBe(true);

      await act(async () => {
        await result.current.retry();
      });

      expect(result.current.current).toEqual({ enabled: true, value: 100 });
      expect(result.current.error).toBeNull();
      expect(onSuccess).toHaveBeenCalled();
    });

    it("should clear error state", async () => {
      const { result } = renderHook(() =>
        useOptimisticUpdate({
          initialValue: initialState,
        })
      );

      const optimisticValue = { enabled: true, value: 50 };

      await act(async () => {
        await result.current.optimisticUpdate(optimisticValue, async () => {
          throw new Error("Save failed");
        });
      });

      expect(result.current.error).toBe("Save failed");

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe("pending state management", () => {
    it("should set and clear pending state correctly", async () => {
      let resolveOperation: ((value: TestState) => void) | null = null;
      const operation = () =>
        new Promise<TestState>((resolve) => {
          resolveOperation = resolve;
        });

      const { result } = renderHook(() =>
        useOptimisticUpdate({
          initialValue: initialState,
        })
      );

      const optimisticValue = { enabled: true, value: 50 };

      act(() => {
        void result.current.optimisticUpdate(optimisticValue, operation);
      });

      expect(result.current.isPending).toBe(true);

      act(() => {
        resolveOperation?.({ enabled: true, value: 100 });
      });

      await waitFor(() => {
        expect(result.current.isPending).toBe(false);
      });
    });
  });
});
