/**
 * Governance Vote Receipt Service (#1190)
 *
 * Tracks submitted governance votes and reconciles them against indexed
 * on-chain events. Provides lifecycle states so the UI can show
 * pending, recorded, delayed, or failed reconciliation status.
 *
 * Security: No sensitive user data is stored — only public vote identifiers
 * and proposal references.
 */

export type VoteReceiptStatus = "pending" | "recorded" | "delayed" | "failed";

export interface VoteReceipt {
  receiptId: string;
  proposalId: string;
  voter: string;        // Stellar account address (public key only)
  choice: string;       // e.g. "yes" | "no" | "abstain"
  submittedAt: string;  // ISO timestamp of local submission
  status: VoteReceiptStatus;
  /** Populated once the indexed event is matched. */
  recordedAt?: string;
  /** Human-readable reason when status is "failed". */
  failureReason?: string;
  /** Incremented on each reconciliation attempt. */
  reconciliationAttempts: number;
  /** ISO timestamp of the last reconciliation check. */
  lastCheckedAt?: string;
}

/** Indexed governance event from the on-chain event indexer. */
export interface IndexedGovernanceEvent {
  proposalId: string;
  voter: string;
  choice: string;
  txHash: string;
  indexedAt: string;  // ISO timestamp
}

// ── Thresholds ──────────────────────────────────────────────────────────────

/** Votes not reconciled within this window are considered "delayed". */
const DELAY_THRESHOLD_MS = Number(
  process.env.VOTE_RECEIPT_DELAY_THRESHOLD_MS ?? 5 * 60 * 1000, // 5 min
);

/** Votes not reconciled within this window are considered "failed". */
const FAILURE_THRESHOLD_MS = Number(
  process.env.VOTE_RECEIPT_FAILURE_THRESHOLD_MS ?? 30 * 60 * 1000, // 30 min
);

// ── In-memory store (replace with DB persistence in production) ─────────────

const receiptStore = new Map<string, VoteReceipt>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateReceiptId(proposalId: string, voter: string): string {
  return `${proposalId}:${voter}:${Date.now()}`;
}

function ageMs(isoTimestamp: string): number {
  return Date.now() - new Date(isoTimestamp).getTime();
}

function deriveStatus(receipt: VoteReceipt): VoteReceiptStatus {
  if (receipt.status === "recorded") return "recorded";
  const age = ageMs(receipt.submittedAt);
  if (age >= FAILURE_THRESHOLD_MS) return "failed";
  if (age >= DELAY_THRESHOLD_MS) return "delayed";
  return "pending";
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a newly submitted vote and return a pending receipt.
 * Call this immediately after the user submits a vote transaction.
 */
export function submitVoteReceipt(
  proposalId: string,
  voter: string,
  choice: string,
): VoteReceipt {
  const receiptId = generateReceiptId(proposalId, voter);
  const receipt: VoteReceipt = {
    receiptId,
    proposalId,
    voter,
    choice,
    submittedAt: new Date().toISOString(),
    status: "pending",
    reconciliationAttempts: 0,
  };
  receiptStore.set(receiptId, receipt);
  return receipt;
}

/**
 * Match pending receipts against a batch of indexed governance events.
 * Returns the list of receipts whose status changed.
 */
export function reconcileVoteReceipts(
  indexedEvents: IndexedGovernanceEvent[],
): VoteReceipt[] {
  const updated: VoteReceipt[] = [];

  for (const [id, receipt] of receiptStore) {
    if (receipt.status === "recorded" || receipt.status === "failed") continue;

    const now = new Date().toISOString();
    const match = indexedEvents.find(
      (ev) =>
        ev.proposalId === receipt.proposalId &&
        ev.voter === receipt.voter &&
        ev.choice === receipt.choice,
    );

    const updatedReceipt: VoteReceipt = {
      ...receipt,
      reconciliationAttempts: receipt.reconciliationAttempts + 1,
      lastCheckedAt: now,
    };

    if (match) {
      updatedReceipt.status = "recorded";
      updatedReceipt.recordedAt = match.indexedAt;
    } else {
      const age = ageMs(receipt.submittedAt);
      if (age >= FAILURE_THRESHOLD_MS) {
        updatedReceipt.status = "failed";
        updatedReceipt.failureReason =
          "Vote was not indexed within the expected window. The transaction may have failed or the indexer may be lagging.";
      } else if (age >= DELAY_THRESHOLD_MS) {
        updatedReceipt.status = "delayed";
      }
    }

    receiptStore.set(id, updatedReceipt);
    updated.push(updatedReceipt);
  }

  return updated;
}

/**
 * Retrieve a single vote receipt by its ID.
 * Also refreshes the age-based status fields.
 */
export function getVoteReceipt(receiptId: string): VoteReceipt | undefined {
  const receipt = receiptStore.get(receiptId);
  if (!receipt) return undefined;

  const refreshed = { ...receipt, status: deriveStatus(receipt) };
  receiptStore.set(receiptId, refreshed);
  return refreshed;
}

/**
 * List all receipts for a specific proposal (optionally filtered by voter).
 */
export function listVoteReceipts(
  proposalId: string,
  voter?: string,
): VoteReceipt[] {
  const results: VoteReceipt[] = [];

  for (const receipt of receiptStore.values()) {
    if (receipt.proposalId !== proposalId) continue;
    if (voter && receipt.voter !== voter) continue;
    results.push({ ...receipt, status: deriveStatus(receipt) });
  }

  return results.sort(
    (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
  );
}

/** Clear all receipts — for testing only. */
export function clearReceiptStore(): void {
  receiptStore.clear();
}
