/**
 * Transaction review partial completion and retry (#1891).
 *
 * The zap router imports the vault pause service, which loads the contract
 * registry; that load currently fails its checksum in tests, so the service
 * is mocked here.
 */

jest.mock("../services/vaultPauseStateService", () => ({
  getVaultPauseState: jest.fn(async () => ({ status: "active" })),
}));

import express from "express";
import request from "supertest";
import zapRouter from "../routes/zap";
import {
  ReviewOperationInFlightError,
  beginOrResumeReviewOperation,
  getReviewOperation,
  recordReviewOperationEvent,
  resetReviewOperationStore,
} from "../services/transactionReviewOperationService";
import { TX_FAILED_ONCHAIN } from "../../../shared/types/transactionReviewOperation";

const WALLET = "GREVIEWWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const app = express();
app.use(express.json());
app.use("/api/zap", zapRouter);

function deposit(overrides: Record<string, unknown> = {}) {
  return {
    walletAddress: WALLET,
    routeHash: "route-1",
    amountInStroops: "10000000",
    minAmountOutStroops: "9900000",
    deadlineUnixSeconds: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

beforeEach(() => resetReviewOperationStore());

describe("review operation journal service (#1891)", () => {
  it("resumes the same operation and refuses a reused id for another deposit", () => {
    const first = beginOrResumeReviewOperation("op-review-1", deposit());
    expect(first).toMatchObject({ resumed: false, operation: { stage: "reviewed" } });

    const again = beginOrResumeReviewOperation("op-review-1", deposit());
    expect(again.resumed).toBe(true);

    expect(() => beginOrResumeReviewOperation("op-review-1", deposit({ amountInStroops: "20000000" }))).toThrow(
      expect.objectContaining({ code: "REVIEW_OPERATION_MISMATCH" }),
    );
  });

  it("refuses a second deposit while a signed one could still land", () => {
    beginOrResumeReviewOperation("op-review-1", deposit());
    recordReviewOperationEvent(WALLET, "op-review-1", { type: "signed", txHash: HASH_A });

    expect(() => beginOrResumeReviewOperation("op-review-2", deposit())).toThrow(ReviewOperationInFlightError);

    // A different wallet is unaffected.
    expect(() =>
      beginOrResumeReviewOperation("op-review-3", deposit({ walletAddress: "GOTHERWALLET" })),
    ).not.toThrow();
  });

  it("allows a new deposit once the signed one is confirmed, failed on-chain, or past its deadline", () => {
    const now = Date.now();
    beginOrResumeReviewOperation("op-confirmed", deposit(), now);
    recordReviewOperationEvent(WALLET, "op-confirmed", { type: "submitted", txHash: HASH_A });
    recordReviewOperationEvent(WALLET, "op-confirmed", { type: "confirmed", txHash: HASH_A });
    expect(() => beginOrResumeReviewOperation("op-next-1", deposit(), now)).not.toThrow();

    recordReviewOperationEvent(WALLET, "op-next-1", { type: "submitted", txHash: HASH_B });
    recordReviewOperationEvent(WALLET, "op-next-1", { type: "failed", code: TX_FAILED_ONCHAIN });
    expect(() => beginOrResumeReviewOperation("op-next-2", deposit(), now)).not.toThrow();

    const deadline = Math.floor(now / 1000) + 60;
    resetReviewOperationStore();
    beginOrResumeReviewOperation("op-expiring", deposit({ deadlineUnixSeconds: deadline }), now);
    recordReviewOperationEvent(WALLET, "op-expiring", { type: "signed", txHash: HASH_A });
    expect(() => beginOrResumeReviewOperation("op-next-3", deposit(), now)).toThrow(ReviewOperationInFlightError);
    expect(() => beginOrResumeReviewOperation("op-next-3", deposit(), (deadline + 1) * 1000)).not.toThrow();
  });

  it("keeps a timed-out submission in flight: the failure does not release the wallet", () => {
    beginOrResumeReviewOperation("op-timeout", deposit());
    recordReviewOperationEvent(WALLET, "op-timeout", { type: "submitted", txHash: HASH_A });
    const failed = recordReviewOperationEvent(WALLET, "op-timeout", { type: "failed", code: "CONFIRMATION_TIMEOUT" });
    expect(failed.failure).toEqual({ stage: "submitted", code: "CONFIRMATION_TIMEOUT", fundsMayHaveMoved: true });
    expect(() => beginOrResumeReviewOperation("op-other", deposit())).toThrow(ReviewOperationInFlightError);

    // The ledger later confirms the same transaction.
    const confirmed = recordReviewOperationEvent(WALLET, "op-timeout", { type: "confirmed", txHash: HASH_A });
    expect(confirmed.stage).toBe("confirmed");
    expect(confirmed.failure).toBeUndefined();
  });

  it("leaves the stored operation unchanged when an event is rejected", () => {
    beginOrResumeReviewOperation("op-guard", deposit());
    recordReviewOperationEvent(WALLET, "op-guard", { type: "signed", txHash: HASH_A });
    const before = getReviewOperation(WALLET, "op-guard");

    expect(() => recordReviewOperationEvent(WALLET, "op-guard", { type: "submitted", txHash: HASH_B })).toThrow(
      expect.objectContaining({ code: "REVIEW_OPERATION_TX_HASH_MISMATCH" }),
    );
    expect(getReviewOperation(WALLET, "op-guard")).toEqual(before);
  });
});

describe("review operation routes (#1891)", () => {
  it("starts, resumes and reports an operation", async () => {
    const body = { operationId: "op-http-1", ...deposit() };
    const created = await request(app).post("/api/zap/review-operations").send(body);
    expect(created.status).toBe(201);
    expect(created.body.operation).toMatchObject({ operationId: "op-http-1", stage: "reviewed" });

    const resumed = await request(app).post("/api/zap/review-operations").send(body);
    expect(resumed.status).toBe(200);
    expect(resumed.body.resumed).toBe(true);

    await request(app)
      .post("/api/zap/review-operations/op-http-1/events")
      .send({ walletAddress: WALLET, type: "signed", txHash: HASH_A })
      .expect(200);
    // A retried report is harmless.
    const replay = await request(app)
      .post("/api/zap/review-operations/op-http-1/events")
      .send({ walletAddress: WALLET, type: "signed", txHash: HASH_A });
    expect(replay.status).toBe(200);
    expect(replay.body.operation).toMatchObject({ stage: "signed", txHash: HASH_A });

    const got = await request(app).get("/api/zap/review-operations/op-http-1").query({ walletAddress: WALLET });
    expect(got.status).toBe(200);
    expect(got.body.operation.stage).toBe("signed");
  });

  it("answers a second deposit while one is in flight with a recoverable 409 naming it", async () => {
    await request(app).post("/api/zap/review-operations").send({ operationId: "op-http-a", ...deposit() }).expect(201);
    await request(app)
      .post("/api/zap/review-operations/op-http-a/events")
      .send({ walletAddress: WALLET, type: "submitted", txHash: HASH_A })
      .expect(200);

    const res = await request(app).post("/api/zap/review-operations").send({ operationId: "op-http-b", ...deposit() });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "REVIEW_OPERATION_IN_FLIGHT",
      recoverable: true,
      details: { operation: { operationId: "op-http-a", txHash: HASH_A } },
    });
  });

  it("rejects malformed input and unknown operations without recording anything", async () => {
    const bad = [
      { operationId: "short", ...deposit() },
      { operationId: "op-http-bad", ...deposit({ amountInStroops: "0" }) },
      { operationId: "op-http-bad", ...deposit({ amountInStroops: "1.5" }) },
      { operationId: "op-http-bad", ...deposit({ deadlineUnixSeconds: -1 }) },
    ];
    for (const body of bad) {
      const res = await request(app).post("/api/zap/review-operations").send(body);
      expect(res.status).toBe(400);
    }
    expect(getReviewOperation(WALLET, "op-http-bad")).toBeNull();

    const unknown = await request(app)
      .post("/api/zap/review-operations/op-http-missing/events")
      .send({ walletAddress: WALLET, type: "signed", txHash: HASH_A });
    expect(unknown.status).toBe(404);

    await request(app).post("/api/zap/review-operations").send({ operationId: "op-http-ev", ...deposit() }).expect(201);
    const badEvent = await request(app)
      .post("/api/zap/review-operations/op-http-ev/events")
      .send({ walletAddress: WALLET, type: "signed", txHash: "not-a-hash" });
    expect(badEvent.status).toBe(400);

    const backwards = await request(app)
      .post("/api/zap/review-operations/op-http-ev/events")
      .send({ walletAddress: WALLET, type: "confirmed", txHash: HASH_A });
    expect(backwards.status).toBe(409);
    expect(backwards.body.error).toBe("REVIEW_OPERATION_INVALID_TRANSITION");

    const missingWallet = await request(app).get("/api/zap/review-operations/op-http-ev");
    expect(missingWallet.status).toBe(400);
  });

  it("scopes operations to the wallet", async () => {
    await request(app).post("/api/zap/review-operations").send({ operationId: "op-http-w", ...deposit() }).expect(201);
    const other = await request(app)
      .get("/api/zap/review-operations/op-http-w")
      .query({ walletAddress: "GSOMEONEELSE" });
    expect(other.status).toBe(404);
  });
});
