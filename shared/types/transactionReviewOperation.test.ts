/**
 * Regression tests for transaction review duplicate-submission protection (#1888).
 *
 * Covers: stable operation identity, normal execution, validation/execution
 * failure state preservation, duplicate replay, identity conflict, and safe
 * retry of a previously failed review.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  canonicalizeTransactionReviewPayload,
  computeTransactionReviewPayloadFingerprint,
  createTransactionReviewOperationIdentity,
  isValidTransactionReviewOperationId,
  operationIdToContractOpId,
  TransactionReviewOperationManager,
  type TransactionReviewPayload,
} from "./transactionReviewOperation";

const BASE_PAYLOAD: TransactionReviewPayload = {
  walletAddress: "GABC...123".toLowerCase(),
  inputTokenContract: "input_contract".toUpperCase(),
  vaultTokenContract: "vault_token_contract",
  vaultContractId: "vault_contract",
  amountInStroops: "10000000",
  minAmountOutStroops: "9500000",
  expectedAmountOutStroops: "9900000",
  allowPartial: true,
  deadlineUnixSeconds: "1732200000",
  routeHash: "route-hash",
};

const ALTERED_PAYLOAD: TransactionReviewPayload = {
  ...BASE_PAYLOAD,
  amountInStroops: "20000000",
};

interface TestState {
  balance: number;
  appliedIds: string[];
}

const INITIAL_STATE: TestState = { balance: 100, appliedIds: [] };

function makeManager() {
  return new TransactionReviewOperationManager();
}

function identityFor(
  payload: TransactionReviewPayload = BASE_PAYLOAD,
  options: { operationId?: string; createdAt?: string } = {},
) {
  return createTransactionReviewOperationIdentity(payload, options);
}

describe("transaction review operation identity", () => {
  it("canonicalizes equivalent payloads to the same shape", () => {
    const canonical = canonicalizeTransactionReviewPayload(BASE_PAYLOAD);
    expect(canonicalizeTransactionReviewPayload(BASE_PAYLOAD)).toEqual(canonical);
    expect(canonical).toMatchObject({
      walletAddress: "GABC...123".toUpperCase(),
      amountInStroops: "10000000",
      allowPartial: true,
    });
  });

  it("produces a stable fingerprint and short id for a payload", () => {
    const first = computeTransactionReviewPayloadFingerprint(BASE_PAYLOAD);
    const second = computeTransactionReviewPayloadFingerprint(BASE_PAYLOAD);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.shortId).toBe(second.shortId);
  });

  it("changes the fingerprint when a reviewed amount changes", () => {
    expect(
      computeTransactionReviewPayloadFingerprint(ALTERED_PAYLOAD).fingerprint,
    ).not.toBe(computeTransactionReviewPayloadFingerprint(BASE_PAYLOAD).fingerprint);
  });

  it("restores the same identity and contract op id from a stored operation id", () => {
    const original = identityFor();
    const restored = identityFor(BASE_PAYLOAD, {
      operationId: original.operationId,
      createdAt: original.createdAt,
    });
    expect(restored).toEqual(original);
    expect(operationIdToContractOpId(original.operationId)).toBe(original.contractOpId);
  });

  it("derives distinct contract op ids for distinct logical operations", () => {
    expect(identityFor().contractOpId).not.toBe(identityFor().contractOpId);
  });

  it("rejects malformed untrusted operation ids", () => {
    expect(isValidTransactionReviewOperationId(identityFor().operationId)).toBe(true);
    expect(isValidTransactionReviewOperationId("short")).toBe(false);
    expect(isValidTransactionReviewOperationId("bad id with spaces")).toBe(false);
    expect(isValidTransactionReviewOperationId(42)).toBe(false);
  });
});

describe("TransactionReviewOperationManager", () => {
  let manager: TransactionReviewOperationManager;

  beforeEach(() => {
    manager = makeManager();
  });

  it("applies a normal review exactly once and records the effect", async () => {
    const identity = identityFor();
    const applied: string[] = [];
    const result = await manager.executeTransactionReview({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: INITIAL_STATE,
      execute: async (op) => {
        applied.push(op.contractOpId);
        return { hash: "tx-hash" };
      },
      onSuccessStateUpdate: (state, effect) => ({
        balance: state.balance - 100,
        appliedIds: [...state.appliedIds, effect.effectId],
      }),
    });

    expect(result.success).toBe(true);
    expect(result.replayed).toBe(false);
    expect(applied).toEqual([identity.contractOpId]);
    expect(result.state.balance).toBe(0);
    expect(result.state.appliedIds).toHaveLength(1);
    expect(result.effects).toHaveLength(1);
    expect(result.effects?.[0]).toMatchObject({
      type: "ZAP_DEPOSIT_APPLIED",
      operationId: identity.operationId,
      contractOpId: identity.contractOpId,
    });
    expect(manager.getOperation(identity.operationId)?.status).toBe("committed");
  });

  it("returns the recorded effect on a duplicate retry without applying it twice", async () => {
    const identity = identityFor();
    let calls = 0;
    const options = {
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: INITIAL_STATE,
      execute: async () => {
        calls += 1;
        return { hash: "tx-hash" };
      },
      onSuccessStateUpdate: (state: TestState) => ({ ...state, balance: state.balance - 100 }),
    };

    const first = await manager.executeTransactionReview(options);
    const replay = await manager.executeTransactionReview(options);

    expect(calls).toBe(1);
    expect(first.success).toBe(true);
    expect(replay.success).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.effects).toEqual(first.effects);
    expect(replay.state).toBe(INITIAL_STATE);
    expect(manager.getOperation(identity.operationId)?.replayedCount).toBe(1);
  });

  it("preserves state and marks the operation rejected when validation fails", async () => {
    const identity = identityFor();
    let executed = false;
    const result = await manager.executeTransactionReview({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: INITIAL_STATE,
      validate: () => "Amount is below the minimum",
      execute: () => {
        executed = true;
        return null;
      },
      onSuccessStateUpdate: (state) => ({ ...state, balance: 0 }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("REVIEW_VALIDATION_FAILED");
    expect(result.state).toBe(INITIAL_STATE);
    expect(executed).toBe(false);
    expect(manager.getOperation(identity.operationId)?.status).toBe("rejected");
  });

  it("preserves balances when execution fails and records a retryable failure", async () => {
    const identity = identityFor();
    const result = await manager.executeTransactionReview({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: INITIAL_STATE,
      execute: () => {
        throw new Error("wallet signing rejected");
      },
      onSuccessStateUpdate: (state) => ({ ...state, balance: 0 }),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("REVIEW_EXECUTION_FAILED");
    expect(result.isRecoverable).toBe(true);
    expect(result.state).toBe(INITIAL_STATE);
    expect(result.state.balance).toBe(100);
    expect(manager.getOperation(identity.operationId)?.status).toBe("failed");
  });

  it("allows a safe retry after a failed execution with the same identity", async () => {
    const identity = identityFor();
    let attempts = 0;
    const options = {
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: INITIAL_STATE,
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("network timeout");
        return { hash: "retry-hash" };
      },
      onSuccessStateUpdate: (state: TestState) => ({ ...state, balance: state.balance - 100 }),
    };

    const failed = await manager.executeTransactionReview(options);
    const retried = await manager.executeTransactionReview(options);

    expect(failed.success).toBe(false);
    expect(failed.state.balance).toBe(100);
    expect(retried.success).toBe(true);
    expect(attempts).toBe(2);
    expect(retried.state.balance).toBe(0);
    expect(manager.getOperation(identity.operationId)?.status).toBe("committed");
  });

  it("rejects an in-flight duplicate review", async () => {
    const identity = identityFor();
    let release: ((value: string) => void) | undefined;
    const inFlight = new Promise<string>((resolve) => {
      release = resolve;
    });

    const first = manager.executeTransactionReview({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: INITIAL_STATE,
      execute: () => inFlight,
    });
    const duplicate = await manager.executeTransactionReview({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: INITIAL_STATE,
      execute: () => {
        throw new Error("duplicate should not execute");
      },
    });

    expect(duplicate.success).toBe(false);
    expect(duplicate.errorCode).toBe("DUPLICATE_REVIEW_IN_PROGRESS");
    expect(duplicate.state).toBe(INITIAL_STATE);
    release?.("done");
    await expect(first).resolves.toMatchObject({ success: true });
  });

  it("blocks identity reuse when the reviewed payload changes", async () => {
    const identity = identityFor();
    await manager.executeTransactionReview({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: INITIAL_STATE,
      execute: () => "first",
    });

    const conflict = await manager.executeTransactionReview({
      payload: ALTERED_PAYLOAD,
      operationIdentity: identity,
      currentState: INITIAL_STATE,
      execute: () => {
        throw new Error("conflicting review should not execute");
      },
    });

    expect(conflict.success).toBe(false);
    expect(conflict.errorCode).toBe("REVIEW_OPERATION_IDENTITY_CONFLICT");
    expect(conflict.state).toBe(INITIAL_STATE);
  });
});
