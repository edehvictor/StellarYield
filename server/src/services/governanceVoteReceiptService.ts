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

/**
 * Operation identity for a vote: one voter, one proposal. Maps to the receipt
 * that currently owns that operation, so a retried submission finds it instead
 * of recording the same vote twice. A receipt that ended "failed" releases its
 * identity, because that vote never reached the chain and may be resubmitted.
 */
const activeByOperation = new Map<string, string>();

/** Monotonic suffix so two submissions in the same millisecond never share an id. */
let receiptSequence = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateReceiptId(proposalId: string, voter: string): string {
  receiptSequence += 1;
  return `${proposalId}:${voter}:${Date.now()}:${receiptSequence}`;
}

/** JSON-encoded so ids containing any delimiter cannot collide across fields. */
function operationKey(proposalId: string, voter: string): string {
  return JSON.stringify([proposalId, voter]);
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

export type SubmitVoteOutcome = "created" | "replayed" | "conflict";

export interface SubmitVoteResult {
  outcome: SubmitVoteOutcome;
  /** The new receipt, the receipt a retry resolved to, or the receipt that blocks a conflicting choice. */
  receipt: VoteReceipt;
}

/**
 * Record a vote once per (proposal, voter).
 *
 * - First submission: a pending receipt is created (`created`).
 * - Retry with the same choice while the vote is pending, delayed or recorded:
 *   the existing receipt is returned and nothing is written (`replayed`).
 * - Different choice for an operation that is already in flight or recorded:
 *   nothing is written and the blocking receipt is returned (`conflict`).
 * - Resubmission after the earlier receipt failed: a new receipt is created,
 *   because that vote never reached the chain.
 *
 * The check and the write run in one synchronous step, so concurrent requests
 * cannot both observe "no receipt yet".
 */
export function submitVoteReceiptOnce(
  proposalId: string,
  voter: string,
  choice: string,
): SubmitVoteResult {
  const key = operationKey(proposalId, voter);
  const existingId = activeByOperation.get(key);
  if (existingId !== undefined) {
    const existing = getVoteReceipt(existingId);
    if (existing && existing.status !== "failed") {
      return {
        outcome: existing.choice === choice ? "replayed" : "conflict",
        receipt: existing,
      };
    }
    activeByOperation.delete(key);
  }

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
  activeByOperation.set(key, receiptId);
  return { outcome: "created", receipt };
}

/**
 * Record a newly submitted vote and return its receipt.
 * Retries of the same vote return the existing receipt; see
 * {@link submitVoteReceiptOnce} for the outcome and for conflicting choices.
 */
export function submitVoteReceipt(
  proposalId: string,
  voter: string,
  choice: string,
): VoteReceipt {
  return submitVoteReceiptOnce(proposalId, voter, choice).receipt;
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
  activeByOperation.clear();
  receiptSequence = 0;
}
