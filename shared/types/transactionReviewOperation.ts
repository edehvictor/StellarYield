/**
 * Immutable operation identity and duplicate-submission protection for the
 * transaction review flow (#1888).
 *
 * A review can be submitted more than once: a user double-clicks confirm, a
 * wallet prompt is dismissed and reopened, or a network poll times out after
 * the transaction was already accepted. Re-running the effect with a fresh
 * identity in those cases would apply the deposit twice.
 *
 * The identity created here travels with the review from quote to signing. Its
 * `contractOpId` is the stable `u64` `op_id` understood by the zap contract, so
 * a replay is rejected on-chain (`OpAlreadySettled`) or resumed from `Pending`
 * instead of pulling the user's input a second time. The manager below wraps
 * the state transition so a replay never applies an effect twice and a failed
 * validation/execution never mutates the supplied state.
 */

import { sha256Pure, stableStringify } from "./quoteAssumptionFingerprint";

/** Canonical inputs that define the effect of one review operation. */
export interface TransactionReviewPayload {
  walletAddress: string;
  inputTokenContract: string;
  vaultTokenContract: string;
  vaultContractId: string;
  /** Integer string in stroops. */
  amountInStroops: string;
  /** Integer string in stroops. */
  minAmountOutStroops: string;
  /** Integer string in stroops; `0` disables partial-fill detection. */
  expectedAmountOutStroops: string;
  allowPartial: boolean;
  /** Quote deadline as a Unix timestamp in seconds (integer string). */
  deadlineUnixSeconds: string;
  /** Route hash of the reviewed quote, when available. */
  routeHash?: string;
}

/** Stable identity for one logical review operation. */
export interface TransactionReviewOperationIdentity {
  /** UUID-like identifier for the logical operation. */
  operationId: string;
  /** SHA-256 fingerprint of the canonical review payload. */
  payloadFingerprint: string;
  /** Decimal `u64` passed to the zap contract as `op_id`. */
  contractOpId: string;
  /** Compact display form of the fingerprint. */
  shortId: string;
  /** ISO timestamp when this identity was created. */
  createdAt: string;
}

export type TransactionReviewOperationStatus =
  | "in_flight"
  | "committed"
  | "failed"
  | "rejected";

/** A recorded review effect, emitted at most once per operation identity. */
export interface TransactionReviewEffect {
  effectId: string;
  type: "ZAP_DEPOSIT_APPLIED";
  operationId: string;
  contractOpId: string;
  walletAddress: string;
  appliedAt: string;
}

export interface TransactionReviewOperationRecord {
  operationId: string;
  payloadFingerprint: string;
  contractOpId: string;
  walletAddress: string;
  status: TransactionReviewOperationStatus;
  effects?: TransactionReviewEffect[];
  error?: string;
  errorCode?: TransactionReviewErrorCode;
  createdAt: string;
  committedAt?: string;
  replayedCount: number;
}

export type TransactionReviewErrorCode =
  | "REVIEW_VALIDATION_FAILED"
  | "REVIEW_EXECUTION_FAILED"
  | "REVIEW_OPERATION_IDENTITY_CONFLICT"
  | "DUPLICATE_REVIEW_IN_PROGRESS";

export interface SafeTransactionReviewOptions<TState, TResult> {
  payload: TransactionReviewPayload;
  operationIdentity: TransactionReviewOperationIdentity;
  currentState: TState;
  /** Runs before any effect; a `false`/string result rejects the operation. */
  validate?: (payload: TransactionReviewPayload) => boolean | string;
  /** Applies the review effect (signing, submission, storage write, ...). */
  execute?: (identity: TransactionReviewOperationIdentity) => Promise<TResult> | TResult;
  /** Computes the state to return after a successful, non-replayed effect. */
  onSuccessStateUpdate?: (currentState: TState, effect: TransactionReviewEffect) => TState;
}

export interface SafeTransactionReviewResult<TState, TResult> {
  success: boolean;
  /** Original state on every failure and on replay; never mutated twice. */
  state: TState;
  result?: TResult;
  effects?: TransactionReviewEffect[];
  replayed?: boolean;
  duplicate?: boolean;
  error?: string;
  errorCode?: TransactionReviewErrorCode;
  isRecoverable: boolean;
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Validates an untrusted operation id received from a header or persisted draft. */
export function isValidTransactionReviewOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID_PATTERN.test(value);
}

function normalizeIntegerString(value: string | undefined): string {
  const raw = String(value ?? "").trim();
  if (!/^-?\d+$/.test(raw)) return "0";
  const normalized = BigInt(raw).toString();
  return normalized === "-0" ? "0" : normalized;
}

/** Canonicalizes a review payload so equivalent inputs share a fingerprint. */
export function canonicalizeTransactionReviewPayload(
  payload: TransactionReviewPayload,
): Record<string, unknown> {
  return {
    walletAddress: String(payload.walletAddress ?? "").trim().toUpperCase(),
    inputTokenContract: String(payload.inputTokenContract ?? "").trim().toUpperCase(),
    vaultTokenContract: String(payload.vaultTokenContract ?? "").trim().toUpperCase(),
    vaultContractId: String(payload.vaultContractId ?? "").trim().toUpperCase(),
    amountInStroops: normalizeIntegerString(payload.amountInStroops),
    minAmountOutStroops: normalizeIntegerString(payload.minAmountOutStroops),
    expectedAmountOutStroops: normalizeIntegerString(payload.expectedAmountOutStroops),
    allowPartial: Boolean(payload.allowPartial),
    deadlineUnixSeconds: normalizeIntegerString(payload.deadlineUnixSeconds),
    routeHash: String(payload.routeHash ?? "").trim().toUpperCase(),
  };
}

/** Computes the deterministic SHA-256 fingerprint of a review payload. */
export function computeTransactionReviewPayloadFingerprint(
  payload: TransactionReviewPayload,
): { fingerprint: string; shortId: string; canonicalPayload: string } {
  const canonicalPayload = stableStringify(canonicalizeTransactionReviewPayload(payload));
  const fingerprint = sha256Pure(canonicalPayload);
  return {
    fingerprint,
    shortId: `txr-${fingerprint.slice(0, 6)}…${fingerprint.slice(-4)}`,
    canonicalPayload,
  };
}

/**
 * Derives the stable on-chain `u64` operation id from a logical operation id.
 * Returned as a decimal string so it survives JSON/localStorage round trips.
 */
export function operationIdToContractOpId(operationId: string): string {
  const digest = sha256Pure(operationId);
  return BigInt(`0x${digest.slice(0, 16)}`).toString();
}

function createOperationId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  const fallback = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `txrev_${(random ?? fallback).replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** Creates (or restores, when `operationId` is supplied) a review identity. */
export function createTransactionReviewOperationIdentity(
  payload: TransactionReviewPayload,
  options: { operationId?: string; createdAt?: string } = {},
): TransactionReviewOperationIdentity {
  const operationId = isValidTransactionReviewOperationId(options.operationId)
    ? options.operationId
    : createOperationId();
  const { fingerprint, shortId } = computeTransactionReviewPayloadFingerprint(payload);
  return {
    operationId,
    payloadFingerprint: fingerprint,
    contractOpId: operationIdToContractOpId(operationId),
    shortId,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

/**
 * In-memory guard around the state-changing part of a review. The effect and
 * the committed record are applied as one logical step: a replay returns the
 * recorded effect without executing again, and failures return the caller's
 * original state untouched.
 */
export class TransactionReviewOperationManager {
  private readonly operations = new Map<string, TransactionReviewOperationRecord>();

  constructor(private readonly ttlMs: number = 24 * 60 * 60 * 1000) {}

  public getOperation(operationId: string): TransactionReviewOperationRecord | undefined {
    const record = this.operations.get(operationId);
    if (!record) return undefined;
    if (Date.now() - Date.parse(record.createdAt) > this.ttlMs) {
      this.operations.delete(operationId);
      return undefined;
    }
    return record;
  }

  public clear(): void {
    this.operations.clear();
  }

  public async executeTransactionReview<TState, TResult>(
    options: SafeTransactionReviewOptions<TState, TResult>,
  ): Promise<SafeTransactionReviewResult<TState, TResult>> {
    const { payload, operationIdentity, currentState, validate, execute, onSuccessStateUpdate } =
      options;
    const { operationId, payloadFingerprint, contractOpId } = operationIdentity;
    const actualFingerprint = computeTransactionReviewPayloadFingerprint(payload).fingerprint;

    // The identity must describe the payload actually being submitted. This
    // also catches a persisted identity being replayed against edited inputs.
    if (actualFingerprint !== payloadFingerprint) {
      return {
        success: false,
        state: currentState,
        error: "Operation identity conflict: review parameters changed after submission.",
        errorCode: "REVIEW_OPERATION_IDENTITY_CONFLICT",
        isRecoverable: false,
      };
    }

    const existing = this.getOperation(operationId);

    if (existing) {
      if (existing.payloadFingerprint !== payloadFingerprint) {
        return {
          success: false,
          state: currentState,
          error: "Operation identity conflict: review parameters changed after submission.",
          errorCode: "REVIEW_OPERATION_IDENTITY_CONFLICT",
          isRecoverable: false,
        };
      }
      if (existing.status === "in_flight") {
        return {
          success: false,
          state: currentState,
          error: "A review with this operation identity is already in progress.",
          errorCode: "DUPLICATE_REVIEW_IN_PROGRESS",
          isRecoverable: true,
        };
      }
      if (existing.status === "committed") {
        existing.replayedCount += 1;
        return {
          success: true,
          state: currentState,
          effects: existing.effects,
          replayed: true,
          duplicate: true,
          isRecoverable: false,
        };
      }
    }

    if (validate) {
      const verdict = validate(payload);
      if (verdict !== true) {
        this.operations.set(operationId, {
          operationId,
          payloadFingerprint,
          contractOpId,
          walletAddress: payload.walletAddress,
          status: "rejected",
          error: typeof verdict === "string" ? verdict : "Review validation failed.",
          errorCode: "REVIEW_VALIDATION_FAILED",
          createdAt: new Date().toISOString(),
          replayedCount: 0,
        });
        return {
          success: false,
          state: currentState,
          error: typeof verdict === "string" ? verdict : "Review validation failed.",
          errorCode: "REVIEW_VALIDATION_FAILED",
          isRecoverable: true,
        };
      }
    }

    this.operations.set(operationId, {
      operationId,
      payloadFingerprint,
      contractOpId,
      walletAddress: payload.walletAddress,
      status: "in_flight",
      createdAt: new Date().toISOString(),
      replayedCount: 0,
    });

    try {
      const result = await execute?.(operationIdentity);
      const effect: TransactionReviewEffect = {
        effectId: `txreff_${operationId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`,
        type: "ZAP_DEPOSIT_APPLIED",
        operationId,
        contractOpId,
        walletAddress: payload.walletAddress,
        appliedAt: new Date().toISOString(),
      };
      const effects = [effect];
      const createdAt = this.getOperation(operationId)?.createdAt ?? new Date().toISOString();
      this.operations.set(operationId, {
        operationId,
        payloadFingerprint,
        contractOpId,
        walletAddress: payload.walletAddress,
        status: "committed",
        effects,
        createdAt,
        committedAt: new Date().toISOString(),
        replayedCount: 0,
      });

      return {
        success: true,
        state: onSuccessStateUpdate ? onSuccessStateUpdate(currentState, effect) : currentState,
        result,
        effects,
        replayed: false,
        duplicate: false,
        isRecoverable: false,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Review execution failed.";
      const createdAt = this.getOperation(operationId)?.createdAt ?? new Date().toISOString();
      this.operations.set(operationId, {
        operationId,
        payloadFingerprint,
        contractOpId,
        walletAddress: payload.walletAddress,
        status: "failed",
        error,
        errorCode: "REVIEW_EXECUTION_FAILED",
        createdAt,
        replayedCount: 0,
      });

      return {
        success: false,
        state: currentState,
        error,
        errorCode: "REVIEW_EXECUTION_FAILED",
        isRecoverable: true,
      };
    }
  }
}

/** Shared default manager for callers that do not need isolated registries. */
export const defaultTransactionReviewOperationManager = new TransactionReviewOperationManager();
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
