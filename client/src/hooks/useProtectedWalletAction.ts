import { useCallback, useRef, useState } from "react";
import { useWallet } from "../context/useWallet";

/**
 * Issue #1152 — graceful recovery for expired wallet connection sessions.
 *
 * Wraps an async "protected" action (a quote preview refresh, a transaction
 * submission, etc.) that requires a live, non-expired wallet session. If the
 * session is expired when the action is invoked, the action is never run —
 * instead its invocation is captured as a resumable thunk and a typed
 * recovery state is surfaced so the UI can offer reconnect / cancel / retry
 * without an uncaught error or a silent no-op.
 *
 * Design notes:
 *  - The "pending action" is captured as a zero-arg closure over whatever
 *    parameters were in scope at call time (e.g. the currently-typed amount,
 *    the currently-fetched quote). This is sufficient for the two call sites
 *    that need it (zap deposit submission, withdrawal submission/preview) and
 *    avoids inventing a generic serializable action-description scheme that
 *    nothing else in the codebase needs yet.
 *  - Expiry is re-checked (not assumed fixed) both when the action is first
 *    invoked and again after a reconnect, so a resume can't silently run
 *    against a session that's still stale for some other reason.
 */

export interface ProtectedActionRecoveryState {
  /** Short, user-facing label for what was being attempted (e.g. "Zap deposit"). */
  label: string;
}

export interface UseProtectedWalletActionResult {
  /** Set once a protected action was blocked by an expired session; null otherwise. */
  pendingRecovery: ProtectedActionRecoveryState | null;
  /**
   * Run `action` if the wallet session is currently valid. If the session is
   * expired, `action` is not invoked; it's captured for later resumption and
   * `pendingRecovery` is set instead. Returns true if `action` ran.
   */
  runProtected: (label: string, action: () => void | Promise<void>) => Promise<boolean>;
  /** Reconnect the wallet, then resume the captured action if the new session is valid. */
  reconnectAndResume: () => Promise<void>;
  /** Re-attempt the captured action without reconnecting (e.g. session was refreshed elsewhere). */
  retryPending: () => Promise<void>;
  /** Discard the captured action and clear the recovery state. */
  cancelPending: () => void;
  /** True while a reconnect triggered from this hook is in flight. */
  isReconnecting: boolean;
}

export function useProtectedWalletAction(): UseProtectedWalletActionResult {
  const { isSessionExpired, isConnected, connectWallet, providerId } = useWallet();
  const [pendingRecovery, setPendingRecovery] = useState<ProtectedActionRecoveryState | null>(
    null,
  );
  const [isReconnecting, setIsReconnecting] = useState(false);
  const pendingActionRef = useRef<(() => void | Promise<void>) | null>(null);

  const runProtected = useCallback(
    async (label: string, action: () => void | Promise<void>) => {
      if (!isConnected || isSessionExpired) {
        pendingActionRef.current = action;
        setPendingRecovery({ label });
        return false;
      }
      await action();
      return true;
    },
    [isConnected, isSessionExpired],
  );

  const cancelPending = useCallback(() => {
    pendingActionRef.current = null;
    setPendingRecovery(null);
  }, []);

  const retryPending = useCallback(async () => {
    if (!pendingActionRef.current) return;
    if (!isConnected || isSessionExpired) {
      // Still not usable — keep the recovery state visible rather than
      // silently dropping the pending action.
      return;
    }
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    setPendingRecovery(null);
    await action();
  }, [isConnected, isSessionExpired]);

  const reconnectAndResume = useCallback(async () => {
    setIsReconnecting(true);
    try {
      const ok = await connectWallet({ providerId: providerId ?? "freighter" });
      // `connectWallet` succeeding is the authoritative signal that the
      // session is valid now — run the pending action directly rather than
      // going through retryPending's isConnected/isSessionExpired check,
      // which would still read this closure's pre-reconnect snapshot of
      // wallet state (React hasn't re-rendered with the new session yet).
      if (ok && pendingActionRef.current) {
        const action = pendingActionRef.current;
        pendingActionRef.current = null;
        setPendingRecovery(null);
        await action();
      }
    } finally {
      setIsReconnecting(false);
    }
  }, [connectWallet, providerId]);

  return {
    pendingRecovery,
    runProtected,
    reconnectAndResume,
    retryPending,
    cancelPending,
    isReconnecting,
  };
}
