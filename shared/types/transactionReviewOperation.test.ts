import { describe, expect, it } from "vitest";
import {
  TX_FAILED_ONCHAIN,
  applyReviewEvent,
  beginReviewOperation,
  isReviewOperationInFlight,
  parseReviewOperationEvent,
  parseReviewOperationRequest,
  planReviewRetry,
  type ReviewOperation,
} from "./transactionReviewOperation";

const HASH = "c".repeat(64);
const OTHER = "d".repeat(64);
const DEADLINE = 2_000_000_000;

const request = {
  walletAddress: "GWALLET",
  routeHash: "route",
  amountInStroops: "100",
  minAmountOutStroops: "99",
  deadlineUnixSeconds: DEADLINE,
};

const begin = () => beginReviewOperation("op-12345678", request, 1);
const signed = () => applyReviewEvent(begin(), { type: "signed", txHash: HASH }, 2);

describe("applyReviewEvent", () => {
  it("moves forward through the stages and keeps the hash", () => {
    const submitted = applyReviewEvent(signed(), { type: "submitted", txHash: HASH }, 3);
    const confirmed = applyReviewEvent(submitted, { type: "confirmed", txHash: HASH }, 4);
    expect(confirmed).toMatchObject({ stage: "confirmed", txHash: HASH, updatedAt: 4 });
  });

  it("treats a replayed or older event as a no-op", () => {
    const submitted = applyReviewEvent(signed(), { type: "submitted", txHash: HASH }, 3);
    expect(applyReviewEvent(submitted, { type: "signed", txHash: HASH }, 9)).toBe(submitted);
    expect(applyReviewEvent(submitted, { type: "submitted", txHash: HASH }, 9)).toBe(submitted);
  });

  it("refuses a different hash and confirming before signing", () => {
    expect(() => applyReviewEvent(signed(), { type: "submitted", txHash: OTHER })).toThrow(
      expect.objectContaining({ code: "REVIEW_OPERATION_TX_HASH_MISMATCH" }),
    );
    expect(() => applyReviewEvent(begin(), { type: "confirmed", txHash: HASH })).toThrow(
      expect.objectContaining({ code: "REVIEW_OPERATION_INVALID_TRANSITION" }),
    );
  });

  it("records whether funds may have moved when a stage fails", () => {
    expect(applyReviewEvent(begin(), { type: "failed", code: "WALLET_REJECTED" }).failure).toEqual({
      stage: "reviewed",
      code: "WALLET_REJECTED",
      fundsMayHaveMoved: false,
    });
    expect(applyReviewEvent(signed(), { type: "failed", code: "CONFIRMATION_TIMEOUT" }).failure).toMatchObject({
      fundsMayHaveMoved: true,
    });
    expect(applyReviewEvent(signed(), { type: "failed", code: TX_FAILED_ONCHAIN }).failure).toMatchObject({
      fundsMayHaveMoved: false,
    });
  });

  it("accepts a later confirmation of a failed-looking submission, but nothing else", () => {
    const timedOut = applyReviewEvent(signed(), { type: "failed", code: "CONFIRMATION_TIMEOUT" });
    expect(applyReviewEvent(timedOut, { type: "confirmed", txHash: HASH })).toMatchObject({
      stage: "confirmed",
      failure: undefined,
    });
    expect(() => applyReviewEvent(timedOut, { type: "submitted", txHash: HASH })).toThrow();
    const confirmed = applyReviewEvent(timedOut, { type: "confirmed", txHash: HASH });
    expect(() => applyReviewEvent(confirmed, { type: "failed", code: "X" })).toThrow();
  });
});

describe("planReviewRetry", () => {
  const before = DEADLINE - 10;
  const after = DEADLINE + 10;

  it("resubmits when nothing was signed", () => {
    expect(planReviewRetry(begin(), "unknown", before)).toMatchObject({ action: "resubmit", requiresFreshQuote: false });
    expect(planReviewRetry(begin(), "unknown", after)).toMatchObject({ action: "resubmit", requiresFreshQuote: true });
  });

  it("is done once the ledger shows success", () => {
    expect(planReviewRetry(signed(), "success", before)).toEqual({ action: "done", txHash: HASH });
  });

  it("resubmits after an on-chain failure", () => {
    expect(planReviewRetry(signed(), "failed", before).action).toBe("resubmit");
  });

  it("waits while a signed transaction could still land", () => {
    for (const ledger of ["not_found", "unknown"] as const) {
      expect(planReviewRetry(signed(), ledger, before)).toMatchObject({ action: "await-confirmation", txHash: HASH });
    }
    // Past the deadline the ledger must still be asked: "unknown" is not "absent".
    expect(planReviewRetry(signed(), "unknown", after).action).toBe("await-confirmation");
  });

  it("resubmits with a fresh quote once an unlanded transaction's deadline has passed", () => {
    expect(planReviewRetry(signed(), "not_found", after)).toMatchObject({ action: "resubmit", requiresFreshQuote: true });
  });
});

describe("isReviewOperationInFlight", () => {
  const op = (o: ReviewOperation) => isReviewOperationInFlight(o, DEADLINE - 1);

  it("is true only for a signed, unsettled transaction before its deadline", () => {
    expect(op(begin())).toBe(false);
    expect(op(signed())).toBe(true);
    expect(isReviewOperationInFlight(signed(), DEADLINE + 1)).toBe(false);
    expect(op(applyReviewEvent(signed(), { type: "confirmed", txHash: HASH }))).toBe(false);
    expect(op(applyReviewEvent(signed(), { type: "failed", code: TX_FAILED_ONCHAIN }))).toBe(false);
    expect(op(applyReviewEvent(signed(), { type: "failed", code: "CONFIRMATION_TIMEOUT" }))).toBe(true);
  });
});

describe("parsing", () => {
  it("validates requests and events", () => {
    expect(parseReviewOperationRequest({ ...request, walletAddress: " GWALLET " }).walletAddress).toBe("GWALLET");
    expect(() => parseReviewOperationRequest({ ...request, amountInStroops: "-1" })).toThrow();
    expect(() => parseReviewOperationRequest({ ...request, deadlineUnixSeconds: 1.5 })).toThrow();
    expect(parseReviewOperationEvent({ type: "signed", txHash: HASH })).toEqual({ type: "signed", txHash: HASH });
    expect(() => parseReviewOperationEvent({ type: "signed", txHash: "0xabc" })).toThrow();
    expect(() => parseReviewOperationEvent({ type: "failed", code: "lower" })).toThrow();
    expect(() => parseReviewOperationEvent({ type: "rolled-back" })).toThrow();
  });

  it("rejects unsafe operation ids", () => {
    expect(() => beginReviewOperation("short", request)).toThrow();
    expect(() => beginReviewOperation("has space in it", request)).toThrow();
  });
});
