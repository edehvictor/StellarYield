import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isConnected } from "@stellar/freighter-api";
import {
  clearStoredSession,
  connectWalletSession,
  loadStoredSession,
} from "../auth/session";
import { getAdapter } from "../auth/walletAdapters";
import type { ConnectWalletOptions, ExtensionWalletProviderId, WalletSession } from "../auth/types";
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
      } catch (error) {
        console.error("Unable to inspect Freighter connection", error);
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
      console.error("Wallet connection failed", error);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Wallet connection failed. Please try again.",
      );
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
      throw new Error("No wallet connected.");
    }
    const EXTENSION_PROVIDERS: ExtensionWalletProviderId[] = ["freighter", "xbull", "albedo"];
    if ((EXTENSION_PROVIDERS as string[]).includes(session.providerId)) {
      const adapter = getAdapter(session.providerId as ExtensionWalletProviderId);
      if (!adapter) {
        throw new Error(`No adapter for provider: ${session.providerId}`);
      }
      return adapter.signTransaction(xdr, networkPassphrase);
    }
    // Smart wallet (email / google / github) sessions don't support direct signing
    throw new Error("signTransaction is not supported for smart wallet sessions.");
  }

  const value = useMemo(
    () => ({
      walletAddress: session?.walletAddress ?? null,
      walletAddressType: session?.walletAddressType ?? null,
      providerLabel: session?.providerLabel ?? null,
      sessionKeyAddress: session?.sessionKeyAddress ?? null,
      verificationStatus: session?.verificationStatus ?? null,
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
