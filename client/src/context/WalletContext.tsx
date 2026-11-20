import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isConnected } from "@stellar/freighter-api";
import {
  clearStoredSession,
  connectWalletSession,
  getWalletLifecycleDiagnostic,
  getWalletLifecycleStageDiagnostic,
  loadStoredSession,
  WalletLifecycleError,
} from "../auth/session";
import { getAdapter } from "../auth/walletAdapters";
import type { ConnectWalletOptions, WalletSession } from "../auth/types";
import { WalletContext } from "./WalletContextObject";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WalletSession | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isFreighterInstalled, setIsFreighterInstalled] = useState<
    boolean | null
  >(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setSession(loadStoredSession());
  }, []);

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

  async function connectWallet(options?: ConnectWalletOptions) {
    setIsConnecting(true);
    setErrorMessage(null);

    try {
      const nextSession = await connectWalletSession(options);
      setSession(nextSession);
      return true;
    } catch (error) {
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
  }

  function disconnectWallet() {
    clearStoredSession();
    setSession(null);
    setErrorMessage(null);

    // Clear wallet-specific cached data and session state
    try {
      window.localStorage.removeItem('authToken');
      window.localStorage.removeItem('stellar_yield_google_oauth');
      window.localStorage.removeItem('stellar_yield_google_sheets');

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
          } catch {
            // Cache API might not be available in all environments
          }
        })();
      }
    } catch {
      // localStorage or other APIs might not be available
    }
  }

  function clearError() {
    setErrorMessage(null);
  }

  async function signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
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
  }

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
      isConnecting,
      isFreighterInstalled,
      errorMessage,
      connectWallet,
      disconnectWallet,
      clearError,
      signTransaction,
    }),
    // signTransaction is stable: it only captures `session` which is already
    // in the deps array below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, isConnecting, isFreighterInstalled, errorMessage],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}
