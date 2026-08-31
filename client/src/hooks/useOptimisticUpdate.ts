/**
 * Hook for managing optimistic UI updates with automatic rollback on failure
 *
 * Handles the common pattern of:
 * 1. Save previous state
 * 2. Update UI optimistically
 * 3. Make API request
 * 4. Rollback on failure with actionable retry option
 */

import { useCallback, useRef, useState } from "react";

export interface OptimisticUpdateState<T> {
  /** Current state (optimistic or confirmed) */
  current: T;
  /** Previous state for rollback */
  previous: T | null;
  /** Error message if operation failed */
  error: string | null;
  /** Whether operation is in progress */
  isPending: boolean;
  /** Whether there's a failed operation that can be retried */
  canRetry: boolean;
}

interface UseOptimisticUpdateOptions<T> {
  /** Initial state value */
  initialValue: T;
  /** Called when rollback happens (receives previous state) */
  onRollback?: (previous: T) => void;
  /** Called when operation succeeds */
  onSuccess?: (current: T) => void;
  /** Called when operation fails */
  onError?: (error: Error) => void;
}

/**
 * Hook for optimistic updates with automatic rollback
 *
 * @example
 * const { current, isPending, error, canRetry, optimisticUpdate, retry } = useOptimisticUpdate({
 *   initialValue: { enabled: false },
 *   onRollback: (prev) => console.log("rolled back to", prev),
 * });
 *
 * // Optimistically update and make API call
 * const handleToggle = async (newValue: boolean) => {
 *   await optimisticUpdate(
 *     { enabled: newValue },  // optimistic state
 *     async () => {
 *       return await api.save({ enabled: newValue });
 *     }
 *   );
 * };
 */
export function useOptimisticUpdate<T>(
  options: UseOptimisticUpdateOptions<T>,
): OptimisticUpdateState<T> & {
  /** Apply optimistic update and execute async operation with rollback on failure */
  optimisticUpdate: (
    optimisticValue: T,
    operation: () => Promise<T | void>
  ) => Promise<void>;
  /** Retry the last failed operation */
  retry: () => Promise<void>;
  /** Clear error state */
  clearError: () => void;
} {
  const [state, setState] = useState<T>(options.initialValue);
  const [previous, setPrevious] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [canRetry, setCanRetry] = useState(false);

  // Track previous state for rollback and last failed operation
  const previousRef = useRef<T | null>(null);
  const lastOperationRef = useRef<{
    optimisticValue: T;
    operation: () => Promise<T | void>;
  } | null>(null);

  const optimisticUpdate = useCallback(
    async (optimisticValue: T, operation: () => Promise<T | void>) => {
      // Save current state before optimistic update
      previousRef.current = state;
      setPrevious(state);
      lastOperationRef.current = { optimisticValue, operation };

      // Optimistically update UI
      setState(optimisticValue);
      setError(null);
      setCanRetry(false);
      setIsPending(true);

      try {
        // Execute the operation
        const result = await operation();

        // Update to confirmed result (or keep optimistic if operation returns void)
        if (result !== undefined) {
          setState(result);
        }

        setIsPending(false);
        setCanRetry(false);
        options.onSuccess?.(result !== undefined ? result : optimisticValue);
      } catch (err) {
        // Rollback to previous state on failure
        setState(previousRef.current!);
        setIsPending(false);
        setCanRetry(true);

        const errorMessage =
          err instanceof Error ? err.message : "Operation failed. Please try again.";
        setError(errorMessage);

        options.onError?.(err instanceof Error ? err : new Error(errorMessage));
        options.onRollback?.(previousRef.current!);
      }
    },
    [state, options]
  );

  const retry = useCallback(async () => {
    if (!lastOperationRef.current) {
      setError("No operation to retry");
      return;
    }

    await optimisticUpdate(
      lastOperationRef.current.optimisticValue,
      lastOperationRef.current.operation
    );
  }, [optimisticUpdate]);

  const clearError = useCallback(() => {
    setError(null);
    setCanRetry(false);
  }, []);

  return {
    current: state,
    previous,
    error,
    isPending,
    canRetry,
    optimisticUpdate,
    retry,
    clearError,
  };
}
