/**
 * Deposit draft persistence and reload reconciliation (#1146).
 *
 * A user who reloads the app mid-deposit (before submission, after
 * submission but before confirmation, or after confirmation) should see the
 * correct state when the page comes back up instead of a blank slate.
 *
 * The flow:
 *  1. At submission time, `saveDepositDraft()` persists minimal context
 *     (amount, vault, input asset, tx hash once known, timestamp) to
 *     `localStorage`, following the same pattern as `lib/preferences.ts`
 *     (namespaced key, JSON, try/catch around every storage access so a
 *     disabled/full/private-mode storage never breaks the app).
 *  2. On load, `loadDepositDraft()` reads any persisted draft for the
 *     connected wallet.
 *  3. `reconcileDepositDraft()` checks the draft against the indexer (via
 *     `GET /api/deposits/status/:txHash`) and returns a typed
 *     `DepositDraftState` the UI can render directly:
 *       - "none"      — nothing persisted, or a draft with no tx hash yet
 *                        (submission never completed) → fresh-start state.
 *       - "pending"   — a tx hash was persisted and the indexer has not
 *                        recorded it yet.
 *       - "confirmed" — the indexer has recorded the transaction; the draft
 *                        is cleaned up (removed from storage) after this is
 *                        reported so it doesn't linger.
 *       - "stale"     — the draft is older than `DEPOSIT_DRAFT_STALE_MS`
 *                        and never confirmed; treated as abandoned and
 *                        cleaned up rather than shown as pending forever.
 *
 * Staleness window: 24 hours. Chosen because Stellar transactions settle in
 * seconds to low minutes, so any deposit still unconfirmed a full day later
 * has almost certainly failed, expired, or was abandoned — continuing to
 * show it as "pending" after that point would be misleading. 24h is also
 * long enough to comfortably cover a user closing their laptop overnight
 * mid-flow without losing the pending state prematurely.
 */

const DRAFT_KEY_PREFIX = "deposit_draft_";

/** How long an unconfirmed draft is still shown as "pending" before being treated as stale and discarded. */
export const DEPOSIT_DRAFT_STALE_MS = 24 * 60 * 60 * 1000;

export interface DepositDraft {
  /** Amount entered by the user, in decimal display units (not stroops). */
  amount: string;
  /** Vault token contract id being deposited into. */
  vaultContractId: string;
  vaultTokenSymbol: string;
  /** Input asset the user paid with. */
  inputTokenContract: string;
  inputTokenSymbol: string;
  /** Submitted transaction hash, once known. A draft saved before the wallet
   *  returns a hash (e.g. saved right before signing) may have this unset;
   *  such a draft reconciles to "none" since there is nothing to look up. */
  txHash?: string;
  /** epoch ms when the draft was saved (at submission time). */
  submittedAt: number;
}

export type DepositDraftState =
  | { kind: "none" }
  | { kind: "pending"; draft: DepositDraft }
  | {
      kind: "confirmed";
      draft: DepositDraft;
      confirmedAmount?: number;
      confirmedShares?: number;
      confirmedAt?: string;
    }
  | { kind: "stale"; draft: DepositDraft };

function draftKey(walletAddress: string): string {
  return `${DRAFT_KEY_PREFIX}${walletAddress}`;
}

/** Persists a deposit draft for the given wallet. Never throws. */
export function saveDepositDraft(walletAddress: string, draft: DepositDraft): void {
  if (!walletAddress) return;
  try {
    localStorage.setItem(draftKey(walletAddress), JSON.stringify(draft));
  } catch {
    // Storage unavailable (disabled, full, private mode) — the deposit
    // still succeeds, the user just won't get reload recovery for it.
  }
}

/** Loads the persisted deposit draft for a wallet, if any. Never throws. */
export function loadDepositDraft(walletAddress: string): DepositDraft | null {
  if (!walletAddress) return null;
  try {
    const raw = localStorage.getItem(draftKey(walletAddress));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.amount === "string" &&
      typeof parsed.vaultContractId === "string" &&
      typeof parsed.submittedAt === "number"
    ) {
      return parsed as DepositDraft;
    }
  } catch {
    // Malformed storage value — treat as no draft.
  }
  return null;
}

/** Removes the persisted deposit draft for a wallet. Never throws. */
export function clearDepositDraft(walletAddress: string): void {
  if (!walletAddress) return;
  try {
    localStorage.removeItem(draftKey(walletAddress));
  } catch {
    // Ignore — nothing to clean up if storage is unavailable.
  }
}

export interface DepositStatusResponse {
  txHash: string;
  status: "pending" | "confirmed";
  amount?: number;
  shares?: number;
  vaultId?: string;
  confirmedAt?: string;
}

/**
 * Fetches the on-chain status of a submitted deposit from the indexer-backed
 * status endpoint. Returns `null` on any network/parse failure so callers
 * degrade to treating the draft as still-pending rather than crashing.
 */
export async function fetchDepositStatus(
  txHash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DepositStatusResponse | null> {
  try {
    const res = await fetchImpl(`/api/deposits/status/${txHash}`);
    if (!res.ok) return null;
    const body = await res.json();
    if (body && (body.status === "pending" || body.status === "confirmed")) {
      return body as DepositStatusResponse;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reconciles a persisted deposit draft for `walletAddress` against indexed
 * on-chain state, returning the state the UI should render. Cleans up the
 * persisted draft once it is confirmed or stale so it doesn't linger.
 */
export async function reconcileDepositDraft(
  walletAddress: string,
  options: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<DepositDraftState> {
  const draft = loadDepositDraft(walletAddress);
  if (!draft) return { kind: "none" };

  // No tx hash means submission never got far enough to be resumable —
  // there is nothing to reconcile against the indexer, so this is
  // indistinguishable from a fresh start. Clear it so it doesn't linger.
  if (!draft.txHash) {
    clearDepositDraft(walletAddress);
    return { kind: "none" };
  }

  const now = options.now ?? Date.now();
  const age = now - draft.submittedAt;

  const status = await fetchDepositStatus(draft.txHash, options.fetchImpl);

  if (status?.status === "confirmed") {
    clearDepositDraft(walletAddress);
    return {
      kind: "confirmed",
      draft,
      confirmedAmount: status.amount,
      confirmedShares: status.shares,
      confirmedAt: status.confirmedAt,
    };
  }

  // Still pending (or the status lookup failed/degraded) — decide based on
  // draft age whether this looks abandoned.
  if (age > DEPOSIT_DRAFT_STALE_MS) {
    clearDepositDraft(walletAddress);
    return { kind: "stale", draft };
  }

  return { kind: "pending", draft };
}
