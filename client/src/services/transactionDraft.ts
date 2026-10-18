/**
 * Pending Transaction Draft & Wallet State Management (#1046)
 *
 * Ensures pending drafts and sensitive transaction state are bound to the
 * active wallet address and cleared immediately upon disconnect or account switch,
 * while safely preserving non-sensitive UI preferences.
 */

export interface TransactionDraft {
  id: string;
  walletAddress: string;
  action: string;
  vaultId?: string;
  assetId?: string;
  amount?: number | string;
  payload?: string; // Serialized XDR or simulation payload
  createdAt: number;
  updatedAt: number;
  status: "draft" | "simulated" | "ready";
}

export const DRAFT_STORAGE_KEY = "stellar_yield_pending_tx_draft";
export const GOVERNANCE_TX_KEY = "stellar_yield_governance_txns";

/** Safe preferences that must survive wallet disconnect */
export const SAFE_PREFERENCE_KEYS = [
  "stellar_yield_tx_settings",
  "stellar_yield_ui_density",
  "stellar_yield_theme",
  "theme",
  "stellar_yield_reduced_motion",
] as const;

/**
 * Persists a draft transaction bound to the active wallet address.
 */
export function saveTransactionDraft(
  walletAddress: string,
  draft: Omit<TransactionDraft, "walletAddress" | "createdAt" | "updatedAt">,
): TransactionDraft {
  const fullDraft: TransactionDraft = {
    ...draft,
    walletAddress,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  try {
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(fullDraft));
  } catch {
    // Ignore storage quota or access errors
  }

  return fullDraft;
}

/**
 * Retrieves the pending draft for the current wallet address.
 * Rejects and purges drafts that belong to a different (or disconnected) wallet.
 */
export function getTransactionDraft(
  currentWalletAddress?: string | null,
): TransactionDraft | null {
  if (!currentWalletAddress) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;

    const draft = JSON.parse(raw) as TransactionDraft;
    if (draft.walletAddress !== currentWalletAddress) {
      // Discard draft belonging to a previous account
      clearPendingTransactionDrafts();
      return null;
    }

    return draft;
  } catch {
    return null;
  }
}

/**
 * Clears all pending transaction drafts from storage.
 */
export function clearPendingTransactionDrafts(): void {
  try {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    window.localStorage.removeItem(GOVERNANCE_TX_KEY);
    window.sessionStorage?.removeItem(DRAFT_STORAGE_KEY);
    window.sessionStorage?.removeItem(GOVERNANCE_TX_KEY);
  } catch {
    // Ignore environment storage errors
  }
}

/**
 * Clears all sensitive user state on disconnect or account switch.
 * Leaves safe UI preferences intact.
 */
export function clearSensitiveWalletState(): void {
  clearPendingTransactionDrafts();

  try {
    window.localStorage.removeItem("authToken");
    window.localStorage.removeItem("stellar_yield_google_oauth");
    window.localStorage.removeItem("stellar_yield_google_sheets");
  } catch {
    // Ignore environment storage errors
  }
}
