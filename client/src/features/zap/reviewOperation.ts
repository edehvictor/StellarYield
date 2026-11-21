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
}
