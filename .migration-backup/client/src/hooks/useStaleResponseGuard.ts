import { useRef, useCallback } from "react";

/**
 * Guards against stale API responses overwriting current page state
 * during rapid dashboard navigation.
 *
 * Each call to `startRequest()` returns a unique token. After an async
 * operation completes, call `isCurrent(token)` to check whether the
 * response still belongs to the active view. If it returns false, the
 * caller should discard the result.
 *
 * @example
 * ```tsx
 * const { startRequest, isCurrent } = useStaleResponseGuard();
 *
 * const fetchData = async () => {
 *   const token = startRequest();
 *   const res = await fetch(url);
 *   const data = await res.json();
 *   if (!isCurrent(token)) return; // stale — discard
 *   setData(data);
 * };
 * ```
 */
export function useStaleResponseGuard() {
  const requestIdRef = useRef(0);

  /**
   * Increment the internal counter and return the new token.
   * Any in-flight request whose token no longer matches should be discarded.
   */
  const startRequest = useCallback((): number => {
    requestIdRef.current += 1;
    return requestIdRef.current;
  }, []);

  /**
   * Check whether the given token still matches the most recent request.
   */
  const isCurrent = useCallback((token: number): boolean => {
    return token === requestIdRef.current;
  }, []);

  return { startRequest, isCurrent };
}
