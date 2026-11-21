/**
 * Regression tests for the client-side review operation identity (#1888).
 * A retry must reuse the same stable on-chain `op_id`; changed inputs must get
 * a fresh identity so an old operation can never be applied to new parameters.
 */

import { describe, it, expect } from "vitest";
import {
  buildReviewPayload,
  resolveReviewOperation,
  toPersistedReviewOperation,
  type ReviewOperationInput,
} from "./reviewOperation";
import { computeTransactionReviewPayloadFingerprint } from "../../../../shared/types/transactionReviewOperation";

const INPUT: ReviewOperationInput = {
  walletAddress: "GUSER",
  inputTokenContract: "CXLM",
  vaultTokenContract: "CYVAULT",
  vaultContractId: "CVAULT",
  amountIn: 10_000_000n,
  minAmountOut: 9_500_000n,
  expectedAmountOut: 9_900_000n,
  allowPartial: true,
  deadlineUnixSeconds: 1_732_200_000n,
  routeHash: "route-a",
};

describe("client review operation identity", () => {
  it("binds all reviewed parameters into the payload", () => {
    const payload = buildReviewPayload(INPUT);
    expect(payload).toMatchObject({
      walletAddress: "GUSER",
      amountInStroops: "10000000",
      minAmountOutStroops: "9500000",
      expectedAmountOutStroops: "9900000",
      deadlineUnixSeconds: "1732200000",
      routeHash: "route-a",
    });
  });

  it("creates a fresh identity for a new review", () => {
    const first = resolveReviewOperation(buildReviewPayload(INPUT));
    const second = resolveReviewOperation(buildReviewPayload(INPUT));
    expect(first.operationId).not.toBe(second.operationId);
    expect(first.contractOpId).not.toBe(second.contractOpId);
  });

  it("restores the same identity and contract op id from a persisted draft", () => {
    const payload = buildReviewPayload(INPUT);
    const original = resolveReviewOperation(payload);
    const restored = resolveReviewOperation(payload, toPersistedReviewOperation(original));
    expect(restored).toEqual(original);
  });

  it("does not reuse an identity when reviewed inputs change", () => {
    const payload = buildReviewPayload(INPUT);
    const persisted = toPersistedReviewOperation(resolveReviewOperation(payload));
    const changed = buildReviewPayload({ ...INPUT, amountIn: 20_000_000n });
    const next = resolveReviewOperation(changed, persisted);

    expect(next.operationId).not.toBe(persisted.operationId);
    expect(next.payloadFingerprint).toBe(
      computeTransactionReviewPayloadFingerprint(changed).fingerprint,
    );
  });

  it("ignores malformed persisted identities", () => {
    const payload = buildReviewPayload(INPUT);
    const next = resolveReviewOperation(payload, {
      operationId: "bad id",
      payloadFingerprint: computeTransactionReviewPayloadFingerprint(payload).fingerprint,
      contractOpId: "1",
      createdAt: new Date().toISOString(),
    });
    expect(next.operationId).toMatch(/^txrev_/);
  });
});
