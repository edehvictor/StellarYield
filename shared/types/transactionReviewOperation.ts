/**
 * Transaction review operation journal (#1891).
 *
 * A reviewed deposit moves through stages, and it can be interrupted between
 * any two of them (a closed tab, a wallet that hangs, a poll that times out).
 * The retry that follows must never submit a second deposit while the first
 * could still land, and must not leave the user stuck when nothing moved.
 *
 *   reviewed ──signed(hash)──▶ signed ──submitted(hash)──▶ submitted ──confirmed──▶ confirmed
 *      │                         │                            │
 *      └──────── failed ─────────┴────────── failed ──────────┘
 *
 * The transaction hash is recorded at `signed`, before the transaction is
 * sent, so an interrupted submission can always be looked up. Funds can only
 * move once a signed transaction exists; whether they did is a question for
 * the ledger, answered by `planReviewRetry`.
 *
 * Pure and dependency-free so the server and the client share one definition.
 */

export type ReviewOperationStage = "reviewed" | "signed" | "submitted" | "confirmed" | "failed";

/** What the caller asked for; a reused operation id must match it. */
export interface ReviewOperationRequest {
  walletAddress: string;
  routeHash: string;
  amountInStroops: string;
  minAmountOutStroops: string;
  /** Contract deadline: after it the deposit can no longer move funds. */
  deadlineUnixSeconds: number;
}

export interface ReviewOperationFailure {
  stage: Exclude<ReviewOperationStage, "confirmed" | "failed">;
  code: string;
  /** True when a signed transaction exists, so funds may have moved. */
  fundsMayHaveMoved: boolean;
}

export interface ReviewOperation {
  operationId: string;
  request: ReviewOperationRequest;
  stage: ReviewOperationStage;
  txHash?: string;
  failure?: ReviewOperationFailure;
  createdAt: number;
  updatedAt: number;
}

export type ReviewOperationEvent =
  | { type: "signed"; txHash: string }
  | { type: "submitted"; txHash: string }
  | { type: "confirmed"; txHash: string }
  | { type: "failed"; code: string };

export type ReviewOperationErrorCode =
  | "INVALID_REVIEW_OPERATION"
  | "REVIEW_OPERATION_MISMATCH"
  | "REVIEW_OPERATION_INVALID_TRANSITION"
  | "REVIEW_OPERATION_TX_HASH_MISMATCH";

/**
 * Failure code for a transaction the ledger recorded as failed. A failed
 * Soroban transaction applies none of its effects, so no funds moved.
 */
export const TX_FAILED_ONCHAIN = "TX_FAILED_ONCHAIN";

export class ReviewOperationError extends Error {
  readonly code: ReviewOperationErrorCode;
  constructor(code: ReviewOperationErrorCode, message: string) {
    super(message);
    this.name = "ReviewOperationError";
    this.code = code;
  }
}

const TX_HASH = /^[0-9a-f]{64}$/;
const STROOPS = /^\d+$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function isValidTxHash(value: unknown): value is string {
  return typeof value === "string" && TX_HASH.test(value);
}

export function isValidReviewOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an untrusted review request. Throws INVALID_REVIEW_OPERATION. */
export function parseReviewOperationRequest(raw: unknown): ReviewOperationRequest {
  const invalid = (message: string) => new ReviewOperationError("INVALID_REVIEW_OPERATION", message);
  if (!isPlainRecord(raw)) throw invalid("Review operation must be an object.");
  const { walletAddress, routeHash, amountInStroops, minAmountOutStroops, deadlineUnixSeconds } = raw;
  if (typeof walletAddress !== "string" || walletAddress.trim() === "") {
    throw invalid("walletAddress is required.");
  }
  if (typeof routeHash !== "string" || routeHash.trim() === "") throw invalid("routeHash is required.");
  if (typeof amountInStroops !== "string" || !STROOPS.test(amountInStroops) || BigInt(amountInStroops) <= 0n) {
    throw invalid("amountInStroops must be a positive integer string.");
  }
  if (typeof minAmountOutStroops !== "string" || !STROOPS.test(minAmountOutStroops)) {
    throw invalid("minAmountOutStroops must be a non-negative integer string.");
  }
  if (
    typeof deadlineUnixSeconds !== "number" ||
    !Number.isSafeInteger(deadlineUnixSeconds) ||
    deadlineUnixSeconds <= 0
  ) {
    throw invalid("deadlineUnixSeconds must be a positive integer.");
  }
  return {
    walletAddress: walletAddress.trim(),
    routeHash: routeHash.trim(),
    amountInStroops,
    minAmountOutStroops,
    deadlineUnixSeconds,
  };
}

/** Validate an untrusted event. Throws INVALID_REVIEW_OPERATION. */
export function parseReviewOperationEvent(raw: unknown): ReviewOperationEvent {
  const invalid = (message: string) => new ReviewOperationError("INVALID_REVIEW_OPERATION", message);
  if (!isPlainRecord(raw)) throw invalid("Event must be an object.");
  const { type, txHash, code } = raw;
  if (type === "signed" || type === "submitted" || type === "confirmed") {
    if (!isValidTxHash(txHash)) throw invalid("txHash must be a 64-character lowercase hex hash.");
    return { type, txHash };
  }
  if (type === "failed") {
    if (typeof code !== "string" || !/^[A-Z0-9_]{1,64}$/.test(code)) {
      throw invalid("code must be an upper-case error code.");
    }
    return { type, code };
  }
  throw invalid("type must be signed, submitted, confirmed or failed.");
}

export function sameReviewRequest(a: ReviewOperationRequest, b: ReviewOperationRequest): boolean {
  return (
    a.walletAddress === b.walletAddress &&
    a.routeHash === b.routeHash &&
    a.amountInStroops === b.amountInStroops &&
    a.minAmountOutStroops === b.minAmountOutStroops &&
    a.deadlineUnixSeconds === b.deadlineUnixSeconds
  );
}

export function beginReviewOperation(
  operationId: string,
  request: ReviewOperationRequest,
  now: number = Date.now(),
): ReviewOperation {
  if (!isValidReviewOperationId(operationId)) {
    throw new ReviewOperationError(
      "INVALID_REVIEW_OPERATION",
      "operationId must be 8-128 characters of letters, digits, '.', '_', ':' or '-'.",
    );
  }
  return { operationId, request: { ...request }, stage: "reviewed", createdAt: now, updatedAt: now };
}

const STAGE_ORDER: Record<ReviewOperationStage, number> = {
  reviewed: 0,
  signed: 1,
  submitted: 2,
  confirmed: 3,
  failed: 3,
};

/**
 * Apply an event. Replaying an event already applied returns the operation
 * unchanged, so a retried report is harmless. Moving backwards, reporting a
 * different hash, or changing a finished operation throws.
 */
export function applyReviewEvent(
  op: ReviewOperation,
  event: ReviewOperationEvent,
  now: number = Date.now(),
): ReviewOperation {
  const transitionError = (message: string) =>
    new ReviewOperationError("REVIEW_OPERATION_INVALID_TRANSITION", message);

  if (event.type === "failed") {
    if (op.stage === "failed" && op.failure?.code === event.code) return op;
    if (op.stage === "confirmed" || op.stage === "failed") {
      throw transitionError(`A ${op.stage} operation cannot be marked failed.`);
    }
    return {
      ...op,
      stage: "failed",
      failure: {
        stage: op.stage,
        code: event.code,
        fundsMayHaveMoved: op.txHash !== undefined && event.code !== TX_FAILED_ONCHAIN,
      },
      updatedAt: now,
    };
  }

  if (op.txHash !== undefined && op.txHash !== event.txHash) {
    throw new ReviewOperationError(
      "REVIEW_OPERATION_TX_HASH_MISMATCH",
      "This operation is already bound to a different transaction.",
    );
  }

  // The ledger is the authority: a confirmation is accepted even after a
  // reported failure (for example a poll that timed out but did land).
  if (event.type === "confirmed") {
    if (op.stage === "confirmed") return op;
    if (op.txHash === undefined) {
      throw transitionError("A transaction cannot be confirmed before it is signed.");
    }
    return { ...op, stage: "confirmed", failure: undefined, updatedAt: now };
  }

  if (op.stage === "failed" || op.stage === "confirmed") {
    throw transitionError(`A ${op.stage} operation cannot move to ${event.type}.`);
  }
  if (STAGE_ORDER[op.stage] >= STAGE_ORDER[event.type]) return op;
  return { ...op, stage: event.type, txHash: event.txHash, updatedAt: now };
}

/** What the ledger says about a signed transaction, when it can be asked. */
export type LedgerTransactionStatus = "success" | "failed" | "not_found" | "unknown";

export type ReviewRetryPlan =
  | { action: "done"; txHash: string }
  | { action: "resubmit"; requiresFreshQuote: boolean; reason: string }
  | { action: "await-confirmation"; txHash: string; reason: string };

/**
 * Decide what a retry may do.
 *
 * - Nothing signed: nothing can have moved; resubmit (with a fresh quote once
 *   the deadline has passed).
 * - Signed, and the ledger shows success: done.
 * - Signed, and the ledger shows failure: the transaction moved nothing;
 *   resubmit.
 * - Signed, not found, and the contract deadline has passed: it can no longer
 *   move funds; resubmit with a fresh quote.
 * - Otherwise: wait for the signed transaction. Never resubmit while it could
 *   still land.
 */
export function planReviewRetry(
  op: ReviewOperation,
  ledger: LedgerTransactionStatus,
  nowUnixSeconds: number,
): ReviewRetryPlan {
  const pastDeadline = nowUnixSeconds > op.request.deadlineUnixSeconds;

  if (op.txHash === undefined) {
    return {
      action: "resubmit",
      requiresFreshQuote: pastDeadline,
      reason: "No transaction was signed, so no funds moved.",
    };
  }
  if (op.stage === "confirmed" || ledger === "success") {
    return { action: "done", txHash: op.txHash };
  }
  if (ledger === "failed") {
    return {
      action: "resubmit",
      requiresFreshQuote: pastDeadline,
      reason: "The transaction failed on-chain and moved no funds.",
    };
  }
  if (ledger === "not_found" && pastDeadline) {
    return {
      action: "resubmit",
      requiresFreshQuote: true,
      reason: "The transaction never landed and its deadline has passed, so it can no longer move funds.",
    };
  }
  return {
    action: "await-confirmation",
    txHash: op.txHash,
    reason: "A signed deposit may still land. It will not be submitted again until it is confirmed or its deadline passes.",
  };
}

/**
 * True while the operation holds a signed transaction that could still move
 * funds: not confirmed, not recorded as failed on-chain, and its contract
 * deadline has not passed. A new deposit for the same wallet must wait.
 */
export function isReviewOperationInFlight(op: ReviewOperation, nowUnixSeconds: number): boolean {
  if (op.txHash === undefined) return false;
  if (op.stage === "confirmed") return false;
  if (op.stage === "failed" && op.failure && !op.failure.fundsMayHaveMoved) return false;
  return nowUnixSeconds <= op.request.deadlineUnixSeconds;
}
