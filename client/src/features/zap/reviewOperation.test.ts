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
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  beginReviewJournal,
  classifyZapSubmission,
  newReviewOperationId,
  planRetryFromDraft,
  recordReviewJournalEvent,
  TX_FAILED_ONCHAIN,
} from "./reviewOperation";
import type { DepositDraft } from "./depositDraft";

const HASH = "e".repeat(64);
const NOW_MS = 1_900_000_000_000;
const NOW_S = NOW_MS / 1000;

const draft = (overrides: Partial<DepositDraft> = {}): DepositDraft => ({
  amount: "10",
  vaultContractId: "CVAULT",
  vaultTokenSymbol: "yUSDC",
  inputTokenContract: "CUSDC",
  inputTokenSymbol: "USDC",
  submittedAt: NOW_MS - 5_000,
  operationId: "zap-op-1234",
  deadlineUnixSeconds: NOW_S + 60,
  txHash: HASH,
  ...overrides,
});

describe("classifyZapSubmission (#1891)", () => {
  it("confirms a successful submission", () => {
    expect(classifyZapSubmission({ success: true, hash: HASH }, HASH)).toEqual({ kind: "confirmed", txHash: HASH });
  });

  it("treats a failure before signing as settled", () => {
    expect(classifyZapSubmission({ success: false }, null)).toEqual({ kind: "failed", code: "NOT_SIGNED" });
  });

  it("treats a node rejection and an on-chain failure as settled", () => {
    expect(classifyZapSubmission({ success: false, rejected: true }, HASH)).toEqual({
      kind: "failed",
      code: "SUBMISSION_REJECTED",
    });
    expect(classifyZapSubmission({ success: false, hash: HASH }, HASH)).toEqual({
      kind: "failed",
      code: TX_FAILED_ONCHAIN,
    });
  });

  it("keeps a timed-out or unanswered submission in flight", () => {
    expect(classifyZapSubmission({ success: false, hash: HASH, pending: true }, HASH)).toEqual({
      kind: "in-flight",
      txHash: HASH,
      code: "CONFIRMATION_TIMEOUT",
    });
    // The send threw (dropped connection) after signing: it may have arrived.
    expect(classifyZapSubmission({ success: false }, HASH)).toEqual({
      kind: "in-flight",
      txHash: HASH,
      code: "SUBMISSION_OUTCOME_UNKNOWN",
    });
  });
});

describe("planRetryFromDraft (#1891)", () => {
  it("has nothing to plan without a signed draft", async () => {
    const lookup = vi.fn();
    expect(await planRetryFromDraft("G", null, lookup, NOW_MS)).toBeNull();
    expect(await planRetryFromDraft("G", draft({ txHash: undefined }), lookup, NOW_MS)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not ask the ledger again for a draft it already confirmed", async () => {
    const lookup = vi.fn();
    expect(await planRetryFromDraft("G", draft({ ledgerConfirmed: true }), lookup, NOW_MS)).toEqual({
      action: "done",
      txHash: HASH,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("waits while the ledger cannot be reached or has not seen it yet", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("rpc down"));
    expect((await planRetryFromDraft("G", draft(), failing, NOW_MS))?.action).toBe("await-confirmation");
    const notFound = vi.fn().mockResolvedValue("not_found");
    expect((await planRetryFromDraft("G", draft(), notFound, NOW_MS))?.action).toBe("await-confirmation");
  });

  it("allows a new deposit once the earlier one settled or expired unlanded", async () => {
    expect(
      (await planRetryFromDraft("G", draft(), vi.fn().mockResolvedValue("success"), NOW_MS))?.action,
    ).toBe("done");
    expect(
      (await planRetryFromDraft("G", draft(), vi.fn().mockResolvedValue("failed"), NOW_MS))?.action,
    ).toBe("resubmit");
    expect(
      (
        await planRetryFromDraft(
          "G",
          draft({ deadlineUnixSeconds: NOW_S - 1 }),
          vi.fn().mockResolvedValue("not_found"),
          NOW_MS,
        )
      )?.action,
    ).toBe("resubmit");
  });

  it("keeps a pre-#1891 draft without a deadline waiting until the ledger answers", async () => {
    const old = draft({ deadlineUnixSeconds: undefined, operationId: undefined });
    expect((await planRetryFromDraft("G", old, vi.fn().mockResolvedValue("not_found"), NOW_MS))?.action).toBe(
      "await-confirmation",
    );
  });
});

describe("journal client (#1891)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const request = {
    walletAddress: "GWALLET",
    routeHash: "route",
    amountInStroops: "100",
    minAmountOutStroops: "99",
    deadlineUnixSeconds: NOW_S + 60,
  };

  it("reports an in-flight deposit from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: "REVIEW_OPERATION_IN_FLIGHT",
          message: "Another deposit may still land.",
          details: { operation: { txHash: HASH } },
        }),
      }),
    );
    expect(await beginReviewJournal("zap-op-1234", request)).toEqual({
      kind: "in-flight",
      message: "Another deposit may still land.",
      txHash: HASH,
    });
  });

  it("degrades to unavailable when the journal cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await beginReviewJournal("zap-op-1234", request)).toEqual({ kind: "unavailable" });
    await expect(recordReviewJournalEvent("G", "zap-op-1234", { type: "signed", txHash: HASH })).resolves.toBeUndefined();
  });

  it("sends events to the operation's endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await recordReviewJournalEvent("GWALLET", "zap-op-1234", { type: "submitted", txHash: HASH });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/zap\/review-operations\/zap-op-1234\/events$/);
    expect(JSON.parse(init.body)).toEqual({ walletAddress: "GWALLET", type: "submitted", txHash: HASH });
  });

  it("generates distinct valid operation ids", () => {
    const a = newReviewOperationId();
    const b = newReviewOperationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^zap-[A-Za-z0-9-]{8,}$/);
  });
});
