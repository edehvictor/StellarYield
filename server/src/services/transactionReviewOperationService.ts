/**
 * Transaction review operation journal (#1891).
 *
 * Records each reviewed deposit's progress (reviewed → signed → submitted →
 * confirmed, or failed) so an interrupted flow can be resumed from another
 * tab or after a reload, and so a second deposit is refused while a signed
 * one could still land. The state machine lives in
 * shared/types/transactionReviewOperation.ts.
 *
 * In memory, like the other review and comparison stores. The journal never
 * moves funds; it only records what the client reports.
 */

import {
  ReviewOperationError,
  applyReviewEvent,
  beginReviewOperation,
  isReviewOperationInFlight,
  sameReviewRequest,
  type ReviewOperation,
  type ReviewOperationEvent,
  type ReviewOperationRequest,
} from "../../../shared/types/transactionReviewOperation";

export const REVIEW_OPERATION_IN_FLIGHT = "REVIEW_OPERATION_IN_FLIGHT";
export const REVIEW_OPERATION_NOT_FOUND = "REVIEW_OPERATION_NOT_FOUND";

export class ReviewOperationInFlightError extends Error {
  readonly code = REVIEW_OPERATION_IN_FLIGHT;
  constructor(readonly inFlight: ReviewOperation) {
    super(
      "Another deposit from this wallet is signed and may still land. Wait for it to confirm or for its deadline to pass before submitting a new one.",
    );
    this.name = "ReviewOperationInFlightError";
  }
}

export class ReviewOperationNotFoundError extends Error {
  readonly code = REVIEW_OPERATION_NOT_FOUND;
  constructor(readonly operationId: string) {
    super(`No review operation "${operationId}" is recorded for this wallet.`);
    this.name = "ReviewOperationNotFoundError";
  }
}

const operations = new Map<string, ReviewOperation>();

function normalizeWallet(wallet: string): string {
  return wallet.trim().toUpperCase();
}

function key(walletAddress: string, operationId: string): string {
  return JSON.stringify([normalizeWallet(walletAddress), operationId]);
}

function clone(op: ReviewOperation): ReviewOperation {
  return JSON.parse(JSON.stringify(op)) as ReviewOperation;
}

export function resetReviewOperationStore(): void {
  operations.clear();
}

/**
 * Start (or resume) a review operation.
 * - The same id with the same request returns the stored operation.
 * - The same id with a different request is refused (REVIEW_OPERATION_MISMATCH).
 * - A new operation is refused while another one for the wallet is in flight.
 */
export function beginOrResumeReviewOperation(
  operationId: string,
  request: ReviewOperationRequest,
  now: number = Date.now(),
): { operation: ReviewOperation; resumed: boolean } {
  const normalizedRequest = { ...request, walletAddress: normalizeWallet(request.walletAddress) };
  const existing = operations.get(key(request.walletAddress, operationId));
  if (existing) {
    if (!sameReviewRequest(existing.request, normalizedRequest)) {
      throw new ReviewOperationError(
        "REVIEW_OPERATION_MISMATCH",
        "This operation id was already used for a different deposit. Use a new id for a new deposit.",
      );
    }
    return { operation: clone(existing), resumed: true };
  }

  const nowSeconds = Math.floor(now / 1000);
  for (const op of operations.values()) {
    if (op.request.walletAddress === normalizedRequest.walletAddress && isReviewOperationInFlight(op, nowSeconds)) {
      throw new ReviewOperationInFlightError(clone(op));
    }
  }

  const operation = beginReviewOperation(operationId, normalizedRequest, now);
  operations.set(key(request.walletAddress, operationId), operation);
  return { operation: clone(operation), resumed: false };
}

/** Record a stage change. Replays are harmless; invalid transitions throw. */
export function recordReviewOperationEvent(
  walletAddress: string,
  operationId: string,
  event: ReviewOperationEvent,
  now: number = Date.now(),
): ReviewOperation {
  const k = key(walletAddress, operationId);
  const existing = operations.get(k);
  if (!existing) throw new ReviewOperationNotFoundError(operationId);
  // applyReviewEvent is pure: on a throw the stored operation is unchanged.
  const next = applyReviewEvent(existing, event, now);
  operations.set(k, next);
  return clone(next);
}

export function getReviewOperation(walletAddress: string, operationId: string): ReviewOperation | null {
  const op = operations.get(key(walletAddress, operationId));
  return op ? clone(op) : null;
}
