/**
 * Strategy comparison partial completion and retry (#1923).
 *
 * A client that loses a response cannot tell whether its write was kept.
 * These tests pin the contract that makes retrying safe: a committed
 * operation replays instead of applying twice, a failed one leaves state and
 * balances untouched and may be retried with the same identity, a reused
 * identity for a different request is refused, and the outcome of any keyed
 * operation can be looked up.
 */

import express from "express";
import request from "supertest";
import strategiesRouter from "../routes/strategies";
import {
  clearComparisonOperationStore,
  getStrategyComparisonOperation,
  getStrategyComparisonState,
  resetComparisonStateStore,
  selectStrategyAndAllocate,
  StrategyComparisonIdempotencyMismatchError,
  StrategyComparisonValidationError,
  STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH,
  updateStrategyComparisonState,
} from "../services/strategyComparisonConcurrencyService";

const WALLET = "GRETRYWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_WALLET = "GRETRYWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/strategies", strategiesRouter);
  return app;
}

beforeEach(() => {
  resetComparisonStateStore();
  clearComparisonOperationStore();
});

describe("strategy comparison retry journal (#1923)", () => {
  it("records a committed operation and replays it after other writers moved on", () => {
    const first = selectStrategyAndAllocate(WALLET, "blend", 1000, {
      expectedVersion: 0,
      operationIdentity: "sel-1",
    });
    expect(first.isReplay).toBe(false);

    // Another session writes after ours committed; our response was lost.
    updateStrategyComparisonState(WALLET, { pinnedStrategyIds: ["soroswap"] }, { expectedVersion: 1 });

    // The retry carries the original expectedVersion. It must replay, not
    // fail with a conflict and not allocate again.
    const retry = selectStrategyAndAllocate(WALLET, "blend", 1000, {
      expectedVersion: 0,
      operationIdentity: "sel-1",
    });
    expect(retry.isReplay).toBe(true);
    expect(retry.state.version).toBe(1);

    const current = getStrategyComparisonState(WALLET);
    expect(current.version).toBe(2);
    expect(current.allocatedBalances).toEqual({ blend: 1000 });
    expect(current.pinnedStrategyIds).toEqual(["soroswap"]);

    expect(getStrategyComparisonOperation(WALLET, "sel-1")).toMatchObject({
      status: "committed",
      kind: "select",
      baseVersion: 0,
      version: 1,
      attempts: 1,
    });
  });

  it("refuses a reused identity for a different request without writing", () => {
    updateStrategyComparisonState(WALLET, { allocatedBalances: { blend: 500 } }, { operationIdentity: "op-a" });

    expect(() =>
      updateStrategyComparisonState(WALLET, { allocatedBalances: { blend: 9000 } }, { operationIdentity: "op-a" }),
    ).toThrow(StrategyComparisonIdempotencyMismatchError);

    expect(() => selectStrategyAndAllocate(WALLET, "blend", 1000, { operationIdentity: "sel-x" })).not.toThrow();
    expect(() => selectStrategyAndAllocate(WALLET, "blend", 2000, { operationIdentity: "sel-x" })).toThrow(
      StrategyComparisonIdempotencyMismatchError,
    );

    const current = getStrategyComparisonState(WALLET);
    expect(current.version).toBe(2);
    expect(current.allocatedBalances).toEqual({ blend: 1000 });
  });

  it("treats key order and absent fields as the same request", () => {
    updateStrategyComparisonState(
      WALLET,
      { customAssumptions: { protocolFeeBps: 10, slippageBps: 20 }, selectedStrategyId: undefined },
      { operationIdentity: "op-order" },
    );
    const retry = updateStrategyComparisonState(
      WALLET,
      { customAssumptions: { slippageBps: 20, protocolFeeBps: 10 } },
      { operationIdentity: "op-order" },
    );
    expect(retry.isReplay).toBe(true);
  });

  it("scopes identities to the wallet so one wallet cannot replay another's state", () => {
    selectStrategyAndAllocate(WALLET, "blend", 1000, { operationIdentity: "shared-key" });

    const other = selectStrategyAndAllocate(OTHER_WALLET, "blend", 1000, { operationIdentity: "shared-key" });
    expect(other.isReplay).toBe(false);
    expect(other.state.walletAddress).toBe(OTHER_WALLET.toUpperCase());
    expect(getStrategyComparisonOperation(OTHER_WALLET, "missing")).toBeNull();
  });

  it("rolls back a failed side effect, journals the failure and lets the same identity retry", () => {
    updateStrategyComparisonState(WALLET, { allocatedBalances: { blend: 1000 } });
    const before = getStrategyComparisonState(WALLET);

    const failing = () => {
      const err = new Error("ledger write failed") as Error & { code: string };
      err.code = "ALLOCATION_LEDGER_UNAVAILABLE";
      throw err;
    };
    expect(() =>
      selectStrategyAndAllocate(WALLET, "soroswap", 2500, {
        expectedVersion: 1,
        operationIdentity: "sel-retry",
        sideEffect: failing,
      }),
    ).toThrow("ledger write failed");

    expect(getStrategyComparisonState(WALLET)).toEqual(before);
    expect(getStrategyComparisonOperation(WALLET, "sel-retry")).toEqual({
      status: "failed",
      operationIdentity: "sel-retry",
      kind: "select",
      baseVersion: 1,
      errorCode: "ALLOCATION_LEDGER_UNAVAILABLE",
      attempts: 1,
    });

    const retried = selectStrategyAndAllocate(WALLET, "soroswap", 2500, {
      expectedVersion: 1,
      operationIdentity: "sel-retry",
    });
    expect(retried.isReplay).toBe(false);
    expect(retried.state.version).toBe(2);
    expect(retried.state.allocatedBalances).toEqual({ blend: 1000, soroswap: 2500 });
    expect(getStrategyComparisonOperation(WALLET, "sel-retry")).toMatchObject({
      status: "committed",
      attempts: 2,
    });

    // A third send of the same request is a replay; balances are not doubled.
    const replay = selectStrategyAndAllocate(WALLET, "soroswap", 2500, { operationIdentity: "sel-retry" });
    expect(replay.isReplay).toBe(true);
    expect(getStrategyComparisonState(WALLET).allocatedBalances).toEqual({ blend: 1000, soroswap: 2500 });
  });

  it("journals validation failures and conflicts as nothing kept", () => {
    updateStrategyComparisonState(WALLET, { allocatedBalances: { blend: 100 } });

    expect(() =>
      updateStrategyComparisonState(WALLET, { allocatedBalances: { blend: -1 } }, { operationIdentity: "bad" }),
    ).toThrow(StrategyComparisonValidationError);
    expect(getStrategyComparisonOperation(WALLET, "bad")).toMatchObject({
      status: "failed",
      errorCode: "INVALID_STRATEGY_COMPARISON_STATE",
      baseVersion: 1,
    });

    expect(() =>
      updateStrategyComparisonState(
        WALLET,
        { allocatedBalances: { blend: 200 } },
        { expectedVersion: 0, operationIdentity: "stale" },
      ),
    ).toThrow();
    expect(getStrategyComparisonOperation(WALLET, "stale")).toMatchObject({
      status: "failed",
      errorCode: "STRATEGY_COMPARISON_VERSION_CONFLICT",
      baseVersion: 1,
    });
    expect(getStrategyComparisonState(WALLET).allocatedBalances).toEqual({ blend: 100 });
  });
});

describe("strategy comparison retry routes (#1923)", () => {
  const app = createTestApp();

  it("returns 422 for a reused identity and keeps state", async () => {
    await request(app)
      .post("/api/strategies/comparison/select")
      .set("Idempotency-Key", "http-sel")
      .send({ walletAddress: WALLET, strategyId: "blend", allocationUsd: 1000 })
      .expect(200);

    const res = await request(app)
      .post("/api/strategies/comparison/select")
      .set("Idempotency-Key", "http-sel")
      .send({ walletAddress: WALLET, strategyId: "blend", allocationUsd: 5000 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe(STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH);
    expect(getStrategyComparisonState(WALLET).allocatedBalances).toEqual({ blend: 1000 });

    const put = await request(app)
      .put("/api/strategies/comparison/state")
      .set("Idempotency-Key", "http-put")
      .send({ walletAddress: WALLET, pinnedStrategyIds: ["blend"] });
    expect(put.status).toBe(200);
    const reused = await request(app)
      .put("/api/strategies/comparison/state")
      .set("Idempotency-Key", "http-put")
      .send({ walletAddress: WALLET, pinnedStrategyIds: ["soroswap"] });
    expect(reused.status).toBe(422);
  });

  it("replays a lost response with the replay header", async () => {
    const send = () =>
      request(app)
        .post("/api/strategies/comparison/select")
        .set("Idempotency-Key", "http-replay")
        .set("If-Match", '"0"')
        .send({ walletAddress: WALLET, strategyId: "blend", allocationUsd: 750 });

    const first = await send();
    expect(first.status).toBe(200);
    const second = await send();
    expect(second.status).toBe(200);
    expect(second.headers["x-idempotent-replayed"]).toBe("true");
    expect(second.body.version).toBe(1);
  });

  it("reports operation status: committed, failed, and unknown", async () => {
    await request(app)
      .post("/api/strategies/comparison/select")
      .set("Idempotency-Key", "status-ok")
      .send({ walletAddress: WALLET, strategyId: "blend", allocationUsd: 10 })
      .expect(200);
    await request(app)
      .put("/api/strategies/comparison/state")
      .set("Idempotency-Key", "status-bad")
      .send({ walletAddress: WALLET, allocatedBalances: { blend: -5 } })
      .expect(400);

    const ok = await request(app).get(`/api/strategies/comparison/operations/${WALLET}/status-ok`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "committed", kind: "select", version: 1 });
    expect(ok.body.state.allocatedBalances).toEqual({ blend: 10 });

    const bad = await request(app).get(`/api/strategies/comparison/operations/${WALLET}/status-bad?kind=update`);
    expect(bad.body).toMatchObject({ status: "failed", errorCode: "INVALID_STRATEGY_COMPARISON_STATE" });

    const unknown = await request(app).get(`/api/strategies/comparison/operations/${WALLET}/never-sent`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("STRATEGY_COMPARISON_OPERATION_NOT_FOUND");

    const wrongKind = await request(app).get(`/api/strategies/comparison/operations/${WALLET}/status-ok?kind=other`);
    expect(wrongKind.status).toBe(400);
  });
});
