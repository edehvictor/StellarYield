import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isConnected } from "@stellar/freighter-api";
import {
  clearStoredSession,
  connectWalletSession,
  getWalletLifecycleDiagnostic,
  getWalletLifecycleStageDiagnostic,
  loadStoredSession,
  WalletLifecycleError,
  isSessionExpired,
  recoverSession,
} from "../auth/session";
import { getAdapter } from "../auth/walletAdapters";
import type { ConnectWalletOptions, WalletSession } from "../auth/types";
import { WalletContext } from "./WalletContextObject";

import {
  clearSensitiveWalletState,
  clearPendingTransactionDrafts,
} from "../services/transactionDraft";

/**
 * Lifecycle state persisted alongside the session so that a partially
 * completed connect/disconnect can be detected and safely retried or rolled
 * back on the next mount. Kept in a dedicated key so it never collides with
 * the session payload itself.
 */
const LIFECYCLE_STORAGE_KEY = "wallet.lifecycle.v1";

type WalletLifecyclePhase = "idle" | "connecting" | "connected" | "disconnecting";

interface WalletLifecycleState {
  phase: WalletLifecyclePhase;
  // The wallet address we were attempting to connect to, if any. Used to
  // detect an interrupted connect so we can roll back to the previous session.
  pendingWalletAddress: string | null;
  updatedAt: number;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WalletSession | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isFreighterInstalled, setIsFreighterInstalled] = useState<
    boolean | null
  >(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Tracks the last successfully committed session so a failed connect can
  // restore it without re-reading (possibly already-cleared) storage.
  const lastCommittedSessionRef = useRef<WalletSession | null>(null);

  const readLifecycleState = useCallback((): WalletLifecycleState | null => {
    try {
      const raw = localStorage.getItem(LIFECYCLE_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as WalletLifecycleState;
      if (
        !parsed ||
        typeof parsed.phase !== "string" ||
        typeof parsed.updatedAt !== "number"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }, []);

  const writeLifecycleState = useCallback((
    phase: WalletLifecyclePhase,
    pendingWalletAddress: string | null,
  ) => {
    try {
      const next: WalletLifecycleState = {
        phase,
        pendingWalletAddress,
        updatedAt: Date.now(),
      };
      localStorage.setItem(LIFECYCLE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage may be unavailable (private mode, quota); lifecycle tracking
      // is best-effort and must never break wallet operations.
    }
  }, []);

  const clearLifecycleState = useCallback(() => {
    try {
      localStorage.removeItem(LIFECYCLE_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  /**
   * Reconciles any lifecycle state left behind by a previous, interrupted
   * operation. Returns the session that should be active after recovery.
   */
  const reconcileInterruptedLifecycle = useCallback((
    recovered: WalletSession | null,
  ): WalletSession | null => {
    const lifecycle = readLifecycleState();
    if (!lifecycle) return recovered;

    if (lifecycle.phase === "connecting") {
      // A connect was interrupted. If recovery produced a session for the
      // pending address, treat it as completed; otherwise roll back to the
      // recovered (previous) session and surface a retry-friendly error.
      if (
        recovered &&
        lifecycle.pendingWalletAddress &&
        recovered.walletAddress === lifecycle.pendingWalletAddress
      ) {
        clearLifecycleState();
        return recovered;
      }
      clearLifecycleState();
      setErrorMessage(
        "Previous wallet connection did not complete. Please try connecting again.",
      );
      return recovered;
    }

    if (lifecycle.phase === "disconnecting") {
      // A disconnect was interrupted. Finish it deterministically so we never
      // leave stale session data behind.
      clearStoredSession();
      clearSensitiveWalletState();
      clearLifecycleState();
      return null;
    }

    // Connected / idle: nothing to reconcile.
    clearLifecycleState();
    return recovered;
  }, [clearLifecycleState, readLifecycleState, writeLifecycleState]);

  useEffect(() => {
    // On mount, attempt to recover any persisted session rather than loading
    // the raw stored value directly. recoverSession() checks TTL, probes
    // provider availability, and re-verifies smart wallet credentials so the
    // context starts in an accurate state after a page reload.
    let cancelled = false;

    recoverSession().then((result) => {
      if (cancelled) return;
      const reconciled = reconcileInterruptedLifecycle(result.session ?? null);
      if (reconciled) {
        lastCommittedSessionRef.current = reconciled;
        setSession(reconciled);
      } else {
        lastCommittedSessionRef.current = null;
        setSession(null);
      }
    }).catch(() => {
      // Fallback: load without recovery so the user is not silently logged out
      if (cancelled) return;
      const fallback = reconcileInterruptedLifecycle(loadStoredSession());
      lastCommittedSessionRef.current = fallback;
      setSession(fallback);
    });

    return () => { cancelled = true; };
  }, [reconcileInterruptedLifecycle]);

  useEffect(() => {
    async function checkConnection() {
      try {
        const connectionResult = await isConnected();

        if (connectionResult.error || !connectionResult.isConnected) {
          setIsFreighterInstalled(false);
          return;
        }

        setIsFreighterInstalled(true);
      } catch {
        const diagnostic = getWalletLifecycleStageDiagnostic("provider_availability");
        console.warn("[wallet] lifecycle diagnostic", {
          stage: diagnostic.stage,
          remediation: diagnostic.remediation,
        });
        setIsFreighterInstalled(false);
      }
    }

    void checkConnection();
  }, []);

  const connectWallet = useCallback(async (options?: ConnectWalletOptions) => {
    setIsConnecting(true);
    setErrorMessage(null);

    // Persist intent before attempting so an interrupted connect can be
    // detected and rolled back on the next mount.
    writeLifecycleState("connecting", null);

    try {
      const nextSession = await connectWalletSession(options);
      // Account switch detection: if connecting a different account, clear prior pending draft payloads
      if (session?.walletAddress && session.walletAddress !== nextSession.walletAddress) {
        clearPendingTransactionDrafts();
      }
      lastCommittedSessionRef.current = nextSession;
      setSession(nextSession);
      writeLifecycleState("connected", null);
      return true;
    } catch (error) {
      // Roll back the in-memory session before surfacing the safe diagnostic.
      const previous = lastCommittedSessionRef.current;
      setSession(previous);
      clearLifecycleState();
      const diagnostic = getWalletLifecycleDiagnostic(error);
      console.error("[wallet] lifecycle diagnostic", {
        stage: diagnostic.stage,
        remediation: diagnostic.remediation,
      });
      setErrorMessage(diagnostic.message);
      return false;
    } finally {
      setIsConnecting(false);
    }
  }, [clearLifecycleState, session, writeLifecycleState]);

  const disconnectWallet = useCallback(() => {
    // Record intent so an interrupted disconnect can be completed on reload.
    writeLifecycleState("disconnecting", null);
    clearStoredSession();
    clearSensitiveWalletState();
    lastCommittedSessionRef.current = null;
    setSession(null);
    setErrorMessage(null);

    // Clear wallet-specific cached data and session state
    try {
      // Clear any in-flight pending transaction state or notifications
      // by resetting browser's fetch/cache for wallet-dependent endpoints
      if ('caches' in window) {
        void (async () => {
          try {
            const cacheNames = await caches.keys();
            for (const cacheName of cacheNames) {
              const cache = await caches.open(cacheName);
              const requests = await cache.keys();
              for (const request of requests) {
                if (request.url.includes('/api/users/') ||
                    request.url.includes('/api/rewards/') ||
                    request.url.includes('/api/referrals/') ||
                    request.url.includes('/api/yields/')) {
                  await cache.delete(request);
                }
              }
            }
            // Disconnect fully completed; safe to clear the lifecycle marker.
            clearLifecycleState();
          } catch {
            // Cache API might not be available in all environments
            clearLifecycleState();
          }
        })();
      } else {
        // No Cache API: disconnect is complete synchronously.
        clearLifecycleState();
      }
    } catch {
      // localStorage or other APIs might not be available
      clearLifecycleState();
    }
  }, [clearLifecycleState, writeLifecycleState]);

  const clearError = useCallback(() => {
    setErrorMessage(null);
  }, []);

  const signTransaction = useCallback(async (xdr: string, networkPassphrase: string): Promise<string> => {
    if (!session) {
      throw new WalletLifecycleError("transaction_signing");
    }
    if (
      session.providerId === "freighter" ||
      session.providerId === "xbull" ||
      session.providerId === "albedo"
    ) {
      const adapter = getAdapter(session.providerId);
      if (!adapter) {
        throw new WalletLifecycleError("transaction_signing");
      }
      try {
        return await adapter.signTransaction(xdr, networkPassphrase);
      } catch {
        throw new WalletLifecycleError("transaction_signing");
      }
    }
    throw new WalletLifecycleError("transaction_signing");
  }, [session]);

  const value = useMemo(
    () => ({
      walletAddress: session?.walletAddress ?? null,
      walletAddressType: session?.walletAddressType ?? null,
      providerLabel: session?.providerLabel ?? null,
      providerId: session?.providerId ?? null,
      network: session?.providerId ? "mainnet" : null,
      sessionKeyAddress: session?.sessionKeyAddress ?? null,
      verificationStatus: session?.verificationStatus ?? null,
      connectedAt: session?.connectedAt ?? null,
      lastActivityAt: session?.lastActivityAt ?? null,
      isConnected: Boolean(session?.walletAddress),
      // Issue #1152: exposed so protected flows (quote preview, tx submission)
      // can check expiry synchronously before acting, rather than only
      // discovering it when a signing/read call fails deep in a service.
      isSessionExpired: session ? isSessionExpired(session) : false,
      isConnecting,
      isFreighterInstalled,
      errorMessage,
      connectWallet,
      disconnectWallet,
      clearError,
      signTransaction,
    }),
    [session, isConnecting, isFreighterInstalled, errorMessage, connectWallet, disconnectWallet, clearError, signTransaction],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}
