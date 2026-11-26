/**
 * Strategy Comparison Concurrency & State Management Tests (#1919)
 *
 * Verifies optimistic concurrency control (OCC), serialization, atomic rollback,
 * state & balance preservation on failure, and safe retry idempotency.
 */

import express from "express";
import request from "supertest";
import strategiesRouter from "../routes/strategies";
import {
  getStrategyComparisonState,
  getStrategyComparisonVersion,
  updateStrategyComparisonState,
  selectStrategyAndAllocate,
  resetComparisonStateStore,
  clearComparisonOperationStore,
  StrategyComparisonVersionConflictError,
  StrategyComparisonOperationIdentityConflictError,
  StrategyComparisonValidationError,
  STRATEGY_COMPARISON_VERSION_CONFLICT,
  STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH,
  INVALID_STRATEGY_COMPARISON_STATE,
} from "../services/strategyComparisonConcurrencyService";

const WALLET = "GBALANCECONCURRENCYTEST123";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/strategies", strategiesRouter);
  return app;
}

beforeEach(() => {
  resetComparisonStateStore();
  clearComparisonOperationStore();
  jest.restoreAllMocks();
});

describe("Strategy Comparison Concurrency Service (#1919)", () => {
  it("1. Normal operation: starts at version 0 and increments once per committed write", () => {
    expect(getStrategyComparisonVersion(WALLET)).toBe(0);

    const first = updateStrategyComparisonState(WALLET, {
      selectedStrategyId: "blend",
      allocatedBalances: { blend: 5000 },
    });
    expect(first.state.version).toBe(1);
    expect(first.state.selectedStrategyId).toBe("blend");
    expect(first.state.allocatedBalances.blend).toBe(5000);
    expect(getStrategyComparisonVersion(WALLET)).toBe(1);

    const second = updateStrategyComparisonState(
      WALLET,
      {
        selectedStrategyId: "soroswap",
        allocatedBalances: { blend: 2500, soroswap: 2500 },
      },
      { expectedVersion: 1 },
    );
    expect(second.state.version).toBe(2);
    expect(second.state.selectedStrategyId).toBe("soroswap");
    expect(second.state.allocatedBalances.soroswap).toBe(2500);
    expect(getStrategyComparisonVersion(WALLET)).toBe(2);
  });

  it("2. Validation failure: rejects invalid assumptions or negative balances without corrupting state or balances", () => {
    // Initial valid state
    updateStrategyComparisonState(WALLET, {
      selectedStrategyId: "blend",
      allocatedBalances: { blend: 1000 },
      customAssumptions: { protocolFeeBps: 150 },
    });
    expect(getStrategyComparisonVersion(WALLET)).toBe(1);

    // Attempt negative allocation
    expect(() =>
      updateStrategyComparisonState(
        WALLET,
        { allocatedBalances: { blend: -50 } },
        { expectedVersion: 1 },
      ),
    ).toThrow(StrategyComparisonValidationError);

    // Attempt invalid fee > 10,000 bps
    expect(() =>
      updateStrategyComparisonState(
        WALLET,
        { customAssumptions: { protocolFeeBps: 12000 } },
        { expectedVersion: 1 },
      ),
    ).toThrow(StrategyComparisonValidationError);

    // Verify state and balances remain 100% UNCHANGED
    const current = getStrategyComparisonState(WALLET);
    expect(current.version).toBe(1);
    expect(current.allocatedBalances.blend).toBe(1000);
    expect(current.customAssumptions.protocolFeeBps).toBe(150);
  });

  it("3. Execution failure: side-effect exception causes complete atomic rollback, preserving previous state and balances", () => {
    updateStrategyComparisonState(WALLET, {
      selectedStrategyId: "blend",
      allocatedBalances: { blend: 3000 },
    });
    expect(getStrategyComparisonVersion(WALLET)).toBe(1);

    // Attempt update where balance transfer / side-effect fails
    expect(() =>
      updateStrategyComparisonState(
        WALLET,
        {
          selectedStrategyId: "soroswap",
          allocatedBalances: { blend: 0, soroswap: 3000 },
        },
        {
          expectedVersion: 1,
          sideEffect: () => {
            throw new Error("RPC transaction simulation failed: insufficient liquidity");
          },
        },
      ),
    ).toThrow("RPC transaction simulation failed: insufficient liquidity");

    // Verify atomic rollback restored previous state and version
    const restored = getStrategyComparisonState(WALLET);
    expect(restored.version).toBe(1);
    expect(restored.selectedStrategyId).toBe("blend");
    expect(restored.allocatedBalances.blend).toBe(3000);
    expect(restored.allocatedBalances.soroswap).toBeUndefined();
  });

  it("4. Concurrent state changes & version conflict: rejects stale writer holding same expectedVersion", () => {
    updateStrategyComparisonState(WALLET, {
      selectedStrategyId: "blend",
      allocatedBalances: { blend: 1000 },
    });
    const seenVersion = getStrategyComparisonVersion(WALLET); // 1

    // First writer commits change
    updateStrategyComparisonState(
      WALLET,
      { selectedStrategyId: "defindex", allocatedBalances: { defindex: 1000 } },
      { expectedVersion: seenVersion },
    );
    expect(getStrategyComparisonVersion(WALLET)).toBe(2);

    // Second writer attempts to commit using stale seenVersion 1
    let conflictError: unknown;
    try {
      updateStrategyComparisonState(
        WALLET,
        { selectedStrategyId: "soroswap", allocatedBalances: { soroswap: 1000 } },
        { expectedVersion: seenVersion },
      );
    } catch (err) {
      conflictError = err;
    }

    expect(conflictError).toBeInstanceOf(StrategyComparisonVersionConflictError);
    const conflict = conflictError as StrategyComparisonVersionConflictError;
    expect(conflict.code).toBe(STRATEGY_COMPARISON_VERSION_CONFLICT);
    expect(conflict.expectedVersion).toBe(1);
    expect(conflict.currentVersion).toBe(2);
    expect(conflict.currentState.selectedStrategyId).toBe("defindex");

    // State remains that of the first writer
    const state = getStrategyComparisonState(WALLET);
    expect(state.version).toBe(2);
    expect(state.selectedStrategyId).toBe("defindex");
  });

  it("5. Safe retry behavior: after conflict, reloading current version allows successful commit", () => {
    updateStrategyComparisonState(WALLET, {
      selectedStrategyId: "blend",
      allocatedBalances: { blend: 1000 },
    });
    const v1 = getStrategyComparisonVersion(WALLET);

    // Another actor updates
    updateStrategyComparisonState(WALLET, { pinnedStrategyIds: ["blend", "soroswap"] }, { expectedVersion: v1 });
    expect(getStrategyComparisonVersion(WALLET)).toBe(2);

    // Our write with v1 fails
    expect(() =>
      updateStrategyComparisonState(WALLET, { selectedStrategyId: "soroswap" }, { expectedVersion: v1 }),
    ).toThrow(StrategyComparisonVersionConflictError);

    // Reload latest state
    const latest = getStrategyComparisonState(WALLET);
    expect(latest.version).toBe(2);

    // Retry write with latest version succeeds cleanly
    const retried = updateStrategyComparisonState(
      WALLET,
      { selectedStrategyId: "soroswap" },
      { expectedVersion: latest.version },
    );
    expect(retried.state.version).toBe(3);
    expect(retried.state.selectedStrategyId).toBe("soroswap");
    expect(retried.state.pinnedStrategyIds).toEqual(["blend", "soroswap"]);
  });

  it("6. Confirmation that retries do not duplicate effects: idempotency key returns cached result", () => {
    const opKey = "op-alloc-999-blend";
    const sideEffect = jest.fn();

    const first = updateStrategyComparisonState(
      WALLET,
      { selectedStrategyId: "blend", allocatedBalances: { blend: 2000 } },
      { operationIdentity: opKey, sideEffect },
    );
    expect(first.isReplay).toBe(false);
    expect(first.state.version).toBe(1);

    // Duplicate submission with same operationIdentity
    const replay = updateStrategyComparisonState(
      WALLET,
      { selectedStrategyId: "blend", allocatedBalances: { blend: 2000 } },
      { operationIdentity: opKey, sideEffect },
    );
    expect(replay.isReplay).toBe(true);
    expect(replay.state.version).toBe(1);
    expect(getStrategyComparisonVersion(WALLET)).toBe(1);
    expect(sideEffect).toHaveBeenCalledTimes(1);
  });

  it("rejects an identity reused for different input and scopes identities to a wallet", () => {
    const opKey = "op-wallet-scoped";
    updateStrategyComparisonState(
      WALLET,
      { selectedStrategyId: "blend", allocatedBalances: { blend: 1000 } },
      { operationIdentity: opKey },
    );

    expect(() =>
      updateStrategyComparisonState(
        WALLET,
        { selectedStrategyId: "soroswap", allocatedBalances: { soroswap: 2000 } },
        { operationIdentity: opKey },
      ),
    ).toThrow(StrategyComparisonOperationIdentityConflictError);

    const otherWallet = "GOTHERWALLET123";
    const otherWalletResult = updateStrategyComparisonState(
      otherWallet,
      { selectedStrategyId: "soroswap", allocatedBalances: { soroswap: 2000 } },
      { operationIdentity: opKey },
    );

    expect(otherWalletResult.isReplay).toBe(false);
    expect(otherWalletResult.state.walletAddress).toBe(otherWallet);
    expect(getStrategyComparisonState(WALLET).selectedStrategyId).toBe("blend");
    expect(getStrategyComparisonState(WALLET).allocatedBalances.blend).toBe(1000);
    expect(getStrategyComparisonVersion(WALLET)).toBe(1);
  });

  it("replays the original selection after a later update without overwriting it", () => {
    const options = { operationIdentity: "op-select-retry" };
    const first = selectStrategyAndAllocate(WALLET, "blend", 1000, options);
    updateStrategyComparisonState(WALLET, {
      pinnedStrategyIds: ["blend"],
      allocatedBalances: { blend: 1000, soroswap: 500 },
    });

    const replay = selectStrategyAndAllocate(WALLET, "blend", 1000, {
      ...options,
      expectedVersion: first.state.version,
    });

    expect(replay.isReplay).toBe(true);
    expect(replay.state.version).toBe(1);
    expect(getStrategyComparisonState(WALLET).version).toBe(2);
    expect(getStrategyComparisonState(WALLET).allocatedBalances).toEqual({
      blend: 1000,
      soroswap: 500,
    });
  });

  it("does not consume an operation identity when execution fails, allowing a safe retry", () => {
    const input = {
      selectedStrategyId: "blend",
      allocatedBalances: { blend: 1200 },
    };
    const options = { operationIdentity: "op-retry-after-failure" };

    expect(() =>
      updateStrategyComparisonState(WALLET, input, {
        ...options,
        sideEffect: () => {
          throw new Error("execution failed");
        },
      }),
    ).toThrow("execution failed");
    expect(getStrategyComparisonVersion(WALLET)).toBe(0);

    const retry = updateStrategyComparisonState(WALLET, input, options);
    expect(retry.isReplay).toBe(false);
    expect(retry.state.version).toBe(1);
    expect(retry.state.allocatedBalances.blend).toBe(1200);
  });
});

describe("Strategy Comparison Concurrency HTTP Routes (#1919)", () => {
  const app = createTestApp();

  it("GET /api/strategies/comparison/state/:walletAddress returns state and version headers", async () => {
    updateStrategyComparisonState(WALLET, {
      selectedStrategyId: "blend",
      allocatedBalances: { blend: 4000 },
    });

    const res = await request(app).get(`/api/strategies/comparison/state/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.headers["x-comparison-version"]).toBe("1");
    expect(res.body.version).toBe(1);
    expect(res.body.state.allocatedBalances.blend).toBe(4000);
  });

  it("PUT /api/strategies/comparison/state commits under OCC and returns 409 on version conflict", async () => {
    // Initial write
    const initRes = await request(app)
      .put("/api/strategies/comparison/state")
      .send({
        walletAddress: WALLET,
        selectedStrategyId: "blend",
        allocatedBalances: { blend: 1000 },
      });
    expect(initRes.status).toBe(200);
    expect(initRes.body.version).toBe(1);

    // Concurrent writer 1 commits with If-Match: "1"
    const write1 = await request(app)
      .put("/api/strategies/comparison/state")
      .set("If-Match", '"1"')
      .send({
        walletAddress: WALLET,
        selectedStrategyId: "soroswap",
        allocatedBalances: { soroswap: 1000 },
      });
    expect(write1.status).toBe(200);
    expect(write1.body.version).toBe(2);

    // Concurrent writer 2 attempts with stale If-Match: "1"
    const write2 = await request(app)
      .put("/api/strategies/comparison/state")
      .set("If-Match", '"1"')
      .send({
        walletAddress: WALLET,
        selectedStrategyId: "defindex",
        allocatedBalances: { defindex: 1000 },
      });
    expect(write2.status).toBe(409);
    expect(write2.body.code).toBe(STRATEGY_COMPARISON_VERSION_CONFLICT);
    expect(write2.body.expectedVersion).toBe(1);
    expect(write2.body.currentVersion).toBe(2);
    expect(write2.body.state.selectedStrategyId).toBe("soroswap");
  });

  it("PUT /api/strategies/comparison/state rejects a reused identity with different input", async () => {
    const body = {
      walletAddress: WALLET,
      selectedStrategyId: "blend",
      allocatedBalances: { blend: 1000 },
    };
    const first = await request(app)
      .put("/api/strategies/comparison/state")
      .set("Idempotency-Key", "route-operation-1")
      .send(body);
    expect(first.status).toBe(200);

    const retry = await request(app)
      .put("/api/strategies/comparison/state")
      .set("Idempotency-Key", "route-operation-1")
      .send(body);
    expect(retry.status).toBe(200);
    expect(retry.body.isReplay).toBe(true);
    expect(retry.headers["x-idempotent-replayed"]).toBe("true");

    const duplicate = await request(app)
      .put("/api/strategies/comparison/state")
      .set("Idempotency-Key", "route-operation-1")
      .send({
        walletAddress: WALLET,
        selectedStrategyId: "soroswap",
        allocatedBalances: { soroswap: 2000 },
      });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.code).toBe(STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH);

    const current = await request(app).get(`/api/strategies/comparison/state/${WALLET}`);
    expect(current.body.state.selectedStrategyId).toBe("blend");
    expect(current.body.state.allocatedBalances).toEqual({ blend: 1000 });
    expect(current.body.version).toBe(1);
  });

  it("POST /api/strategies/comparison/select atomically updates selection and balance under OCC", async () => {
    const res = await request(app)
      .post("/api/strategies/comparison/select")
      .send({
        walletAddress: WALLET,
        strategyId: "defindex",
        allocationUsd: 7500,
      });

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.state.selectedStrategyId).toBe("defindex");
    expect(res.body.state.allocatedBalances.defindex).toBe(7500);

    // Invalid allocation rejected with 400
    const invalidRes = await request(app)
      .post("/api/strategies/comparison/select")
      .send({
        walletAddress: WALLET,
        strategyId: "blend",
        allocationUsd: -500,
        expectedVersion: 1,
      });
    expect(invalidRes.status).toBe(400);
    expect(invalidRes.body.code).toBe(INVALID_STRATEGY_COMPARISON_STATE);

    // State preserved
    const checkRes = await request(app).get(`/api/strategies/comparison/state/${WALLET}`);
    expect(checkRes.body.state.selectedStrategyId).toBe("defindex");
    expect(checkRes.body.state.allocatedBalances.defindex).toBe(7500);
  });
});

