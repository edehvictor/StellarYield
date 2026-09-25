import type { WatchlistItem } from "../../../shared/types/watchlist";

/**
 * Local, per-wallet optimistic snapshot of the watchlist for instant
 * reconnect-render only. Unlike the quests module (client/src/pages/quests/
 * questPersistence.ts), watchlist has always been server-backed — the
 * server (via the wallet-scoped /api/watchlist routes) remains the source
 * of truth. This cache exists purely so the UI can show the last-known
 * list immediately on reconnect while the fresh fetch is in flight, and to
 * avoid a flash of another wallet's data during a wallet switch.
 */
export const WATCHLIST_STORAGE_VERSION = 1;

export interface PersistedWalletWatchlistBundle {
  version: typeof WATCHLIST_STORAGE_VERSION;
  items: WatchlistItem[];
  /** When this snapshot was last confirmed against the server (ms epoch). */
  lastSyncedAt: number | null;
}

export type StorageBackend = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function walletWatchlistStorageKey(walletAddress: string): string {
  return `sy_watchlist_wallet_v${WATCHLIST_STORAGE_VERSION}_${walletAddress}`;
}

function parseBundle(raw: string | null): PersistedWalletWatchlistBundle | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedWalletWatchlistBundle;
    if (
      parsed &&
      parsed.version === WATCHLIST_STORAGE_VERSION &&
      Array.isArray(parsed.items)
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function loadWalletWatchlistBundle(
  walletAddress: string,
  storage: StorageBackend = localStorage,
): PersistedWalletWatchlistBundle {
  const key = walletWatchlistStorageKey(walletAddress);
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    /* private mode — non-fatal, fall through to an empty bundle */
  }
  const fromDisk = parseBundle(raw);
  if (fromDisk) return fromDisk;

  return {
    version: WATCHLIST_STORAGE_VERSION,
    items: [],
    lastSyncedAt: null,
  };
}

export function saveWalletWatchlistBundle(
  walletAddress: string,
  bundle: PersistedWalletWatchlistBundle,
  storage: StorageBackend = localStorage,
): void {
  try {
    storage.setItem(walletWatchlistStorageKey(walletAddress), JSON.stringify(bundle));
  } catch {
    /* quota or private mode — non-fatal */
  }
}

export function clearWalletWatchlistBundle(
  walletAddress: string,
  storage: StorageBackend = localStorage,
): void {
  try {
    storage.removeItem(walletWatchlistStorageKey(walletAddress));
  } catch {
    /* private mode — non-fatal */
  }
}
