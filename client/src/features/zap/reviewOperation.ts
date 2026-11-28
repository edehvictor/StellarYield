/**
 * Client-side wiring for transaction review operation identities (#1888).
 *
 * One logical review (quote → verify → sign → submit → retry) owns exactly one
 * identity. The identity is derived from the reviewed parameters and persisted
 * with the deposit draft so a reload or a double-click reuses the same on-chain
 * `op_id` instead of creating a second deposit.
 */

import {
  computeTransactionReviewPayloadFingerprint,
  createTransactionReviewOperationIdentity,
  isValidTransactionReviewOperationId,
  type TransactionReviewOperationIdentity,
  type TransactionReviewPayload,
} from "../../../../shared/types/transactionReviewOperation";

export interface ReviewOperationInput {
  walletAddress: string;
  inputTokenContract: string;
  vaultTokenContract: string;
  vaultContractId: string;
  amountIn: bigint;
  minAmountOut: bigint;
  expectedAmountOut: bigint;
  allowPartial: boolean;
  deadlineUnixSeconds: bigint;
  routeHash?: string;
}

export interface PersistedReviewOperation {
  operationId: string;
  payloadFingerprint: string;
  contractOpId: string;
  createdAt: string;
}

/** Builds the canonical payload that a review identity is bound to. */
export function buildReviewPayload(input: ReviewOperationInput): TransactionReviewPayload {
  return {
    walletAddress: input.walletAddress,
    inputTokenContract: input.inputTokenContract,
    vaultTokenContract: input.vaultTokenContract,
    vaultContractId: input.vaultContractId,
    amountInStroops: input.amountIn.toString(),
    minAmountOutStroops: input.minAmountOut.toString(),
    expectedAmountOutStroops: input.expectedAmountOut.toString(),
    allowPartial: input.allowPartial,
    deadlineUnixSeconds: input.deadlineUnixSeconds.toString(),
    routeHash: input.routeHash,
  };
}

/** Serializes an identity for the deposit draft (JSON/localStorage safe). */
export function toPersistedReviewOperation(
  identity: TransactionReviewOperationIdentity,
): PersistedReviewOperation {
  return {
    operationId: identity.operationId,
    payloadFingerprint: identity.payloadFingerprint,
    contractOpId: identity.contractOpId,
    createdAt: identity.createdAt,
  };
}

/**
 * Restores an identity from a draft only when it is well formed and still
 * describes the exact payload being reviewed. Otherwise a fresh identity is
 * created, so edited inputs can never be submitted under an old `op_id`.
 */
export function resolveReviewOperation(
  payload: TransactionReviewPayload,
  persisted?: PersistedReviewOperation | null,
): TransactionReviewOperationIdentity {
  const fingerprint = computeTransactionReviewPayloadFingerprint(payload).fingerprint;
  if (
    persisted &&
    isValidTransactionReviewOperationId(persisted.operationId) &&
    persisted.payloadFingerprint === fingerprint
  ) {
    return createTransactionReviewOperationIdentity(payload, {
      operationId: persisted.operationId,
      createdAt: persisted.createdAt,
    });
  }
  return createTransactionReviewOperationIdentity(payload);
 * Client side of the transaction review operation journal (#1891).
 *
 * Decides whether a reviewed deposit may be submitted, given what was left
 * behind by an earlier attempt, and keeps the server journal informed. The
 * local deposit draft is the source of truth on this device; the server
 * journal makes an in-flight deposit visible to other tabs and devices.
 * Journal calls are best effort: if the server cannot be reached, the local
 * guard still applies.
 */

import { apiFetch, apiUrl } from "../../lib/api";
import {
  TX_FAILED_ONCHAIN,
  beginReviewOperation,
  applyReviewEvent,
  planReviewRetry,
  type LedgerTransactionStatus,
  type ReviewOperation,
  type ReviewOperationEvent,
  type ReviewOperationRequest,
  type ReviewRetryPlan,
} from "../../../../shared/types/transactionReviewOperation";
import type { DepositDraft } from "./depositDraft";

export { TX_FAILED_ONCHAIN };
export type { ReviewRetryPlan, LedgerTransactionStatus };

/** A fresh id for one reviewed deposit. */
export function newReviewOperationId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return `zap-${cryptoApi.randomUUID()}`;
  return `zap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Rebuild the journal view of an earlier attempt from its local draft. A
 * draft from before #1891 has no deadline; it is treated as still able to
 * land until the ledger says otherwise.
 */
export function operationFromDraft(walletAddress: string, draft: DepositDraft): ReviewOperation {
  const request: ReviewOperationRequest = {
    walletAddress,
    routeHash: "unknown",
    amountInStroops: "1",
    minAmountOutStroops: "0",
    deadlineUnixSeconds: draft.deadlineUnixSeconds ?? Number.MAX_SAFE_INTEGER,
  };
  let op = beginReviewOperation(
    draft.operationId ?? `draft-${draft.submittedAt}`,
    request,
    draft.submittedAt,
  );
  if (draft.txHash) op = applyReviewEvent(op, { type: "submitted", txHash: draft.txHash }, draft.submittedAt);
  return op;
}

/**
 * What a new submission may do, given an earlier attempt's draft.
 * `lookup` asks the ledger; any failure counts as "unknown".
 */
export async function planRetryFromDraft(
  walletAddress: string,
  draft: DepositDraft | null,
  lookup: (hash: string) => Promise<LedgerTransactionStatus>,
  nowMs: number = Date.now(),
): Promise<ReviewRetryPlan | null> {
  if (!draft || !draft.txHash) return null;
  if (draft.ledgerConfirmed) return { action: "done", txHash: draft.txHash };
  let ledger: LedgerTransactionStatus = "unknown";
  try {
    ledger = await lookup(draft.txHash);
  } catch {
    ledger = "unknown";
  }
  return planReviewRetry(operationFromDraft(walletAddress, draft), ledger, Math.floor(nowMs / 1000));
}

export type ZapSubmissionOutcome =
  /** Confirmed on the ledger. */
  | { kind: "confirmed"; txHash: string }
  /** Signed and possibly sent, but not settled: it may still land. */
  | { kind: "in-flight"; txHash: string; code: string }
  /** Settled without moving funds: safe to try again. */
  | { kind: "failed"; code: string };

/**
 * Classify a submission result. Anything after signing that is not a
 * confirmation, an on-chain failure or a node rejection is in flight: the
 * transaction may have reached the network even though no answer came back.
 */
export function classifyZapSubmission(
  result: { success: boolean; hash?: string; pending?: boolean; rejected?: boolean },
  signedHash: string | null,
): ZapSubmissionOutcome {
  const txHash = result.hash ?? signedHash ?? undefined;
  if (result.success && txHash) return { kind: "confirmed", txHash };
  if (!signedHash && !result.hash) return { kind: "failed", code: "NOT_SIGNED" };
  if (result.rejected) return { kind: "failed", code: "SUBMISSION_REJECTED" };
  if (result.pending) return { kind: "in-flight", txHash: txHash!, code: "CONFIRMATION_TIMEOUT" };
  if (result.hash) return { kind: "failed", code: TX_FAILED_ONCHAIN };
  return { kind: "in-flight", txHash: txHash!, code: "SUBMISSION_OUTCOME_UNKNOWN" };
}

export type BeginJournalResult =
  | { kind: "started" }
  | { kind: "in-flight"; message: string; txHash?: string }
  | { kind: "unavailable" };

/** Register the operation with the server journal before signing. */
export async function beginReviewJournal(
  operationId: string,
  request: ReviewOperationRequest,
): Promise<BeginJournalResult> {
  try {
    const res = await apiFetch(apiUrl("/api/zap/review-operations"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId, ...request }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        details?: { operation?: { txHash?: string } };
      };
      if (body.error === "REVIEW_OPERATION_IN_FLIGHT") {
        return {
          kind: "in-flight",
          message: body.message ?? "Another deposit from this wallet may still land.",
          txHash: body.details?.operation?.txHash,
        };
      }
    }
    return res.ok ? { kind: "started" } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Report a stage change. Never throws; the local draft is authoritative. */
export async function recordReviewJournalEvent(
  walletAddress: string,
  operationId: string,
  event: ReviewOperationEvent,
): Promise<void> {
  try {
    await apiFetch(apiUrl(`/api/zap/review-operations/${encodeURIComponent(operationId)}/events`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress, ...event }),
    });
  } catch {
    // Best effort.
  }
}
