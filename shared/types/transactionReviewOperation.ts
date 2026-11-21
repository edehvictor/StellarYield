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
