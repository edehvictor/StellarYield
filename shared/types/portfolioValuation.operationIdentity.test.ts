/**
 * Regression tests for portfolio valuation duplicate-submission protection (#1864).
 *
 * Covers all acceptance criteria:
 *  A. Operation identity and payload fingerprint
 *  B. State and balance preservation on failure
 *  C. Safe retry behavior
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  canonicalizeValuationPayload,
  computeValuationPayloadFingerprint,
  createValuationOperationIdentity,
  ValuationOperationManager,
  PortfolioValuationPayload,
} from "./portfolioValuation";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_PAYLOAD: PortfolioValuationPayload = {
  walletAddress: "0xABCDEF1234567890",
  currency: "USD",
  context: { network: "testnet", ledgerSequence: 123456 },
  positions: [
    {
      asset: "USDC",
      protocol: "Aave",
      deposited: 1000,
      currentValue: 1050,
      shares: 950,
      apy: 0.045,
      isPriceUnavailable: false,
      priceStatus: "priced",
    },
    {
      asset: "ETH",
      protocol: "Compound",
      deposited: 2,
      currentValue: 3800,
      shares: 1.9,
      apy: 0.025,
      isPriceUnavailable: false,
      priceStatus: "priced",
    },
  ],
};

const ALTERED_PAYLOAD: PortfolioValuationPayload = {
  ...BASE_PAYLOAD,
  positions: [
    {
      ...BASE_PAYLOAD.positions[0],
      currentValue: 1100, // changed value
    },
    BASE_PAYLOAD.positions[1],
  ],
};

interface TestState {
  balance: number;
  lastUpdated: string | null;
}

const INITIAL_STATE: TestState = { balance: 5000, lastUpdated: null };

// ─── canonicalizeValuationPayload ─────────────────────────────────────────────

describe("canonicalizeValuationPayload", () => {
  it("produces deterministic output regardless of position order", () => {
    const reversed: PortfolioValuationPayload = {
      ...BASE_PAYLOAD,
      positions: [...BASE_PAYLOAD.positions].reverse(),
    };
    const c1 = canonicalizeValuationPayload(BASE_PAYLOAD);
    const c2 = canonicalizeValuationPayload(reversed);
    expect(JSON.stringify(c1)).toBe(JSON.stringify(c2));
  });

  it("normalises walletAddress to uppercase", () => {
    const lower: PortfolioValuationPayload = {
      ...BASE_PAYLOAD,
      walletAddress: "0xabcdef1234567890",
    };
    const result = canonicalizeValuationPayload(lower);
    expect(result.walletAddress).toBe("0XABCDEF1234567890");
  });

  it("defaults missing currency to USD", () => {
    const noCurrency: PortfolioValuationPayload = { ...BASE_PAYLOAD, currency: undefined };
    const result = canonicalizeValuationPayload(noCurrency);
    expect(result.currency).toBe("USD");
  });

  it("rounds numeric fields to 4 decimal places", () => {
    const payload: PortfolioValuationPayload = {
      walletAddress: "0x1",
      positions: [
        {
          asset: "DAI",
          protocol: "Yearn",
          deposited: 100.123456789,
          currentValue: 101.987654321,
          apy: 0.0333333,
          isPriceUnavailable: false,
          priceStatus: "priced",
        },
      ],
    };
    const result = canonicalizeValuationPayload(payload);
    const pos = (result.positions as Array<Record<string, unknown>>)[0];
    expect(pos.deposited).toBe(100.1235);
    expect(pos.currentValue).toBe(101.9877);
    expect(pos.apy).toBe(0.0333);
  });

  it("normalizes and retains network and ledger context", () => {
    const payload = {
      ...BASE_PAYLOAD,
      context: { network: " TESTNET ", ledgerSequence: 123456 },
    };
    expect(canonicalizeValuationPayload(payload).context).toEqual({
      network: "testnet",
      ledgerSequence: 123456,
    });
  });
});

// ─── computeValuationPayloadFingerprint ──────────────────────────────────────

describe("computeValuationPayloadFingerprint", () => {
  it("produces a stable 64-char hex fingerprint", () => {
    const { fingerprint } = computeValuationPayloadFingerprint(BASE_PAYLOAD);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same payload → same fingerprint (deterministic)", () => {
    const r1 = computeValuationPayloadFingerprint(BASE_PAYLOAD);
    const r2 = computeValuationPayloadFingerprint(BASE_PAYLOAD);
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it("different payload value → different fingerprint (stale detection)", () => {
    const r1 = computeValuationPayloadFingerprint(BASE_PAYLOAD);
    const r2 = computeValuationPayloadFingerprint(ALTERED_PAYLOAD);
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it("different network or ledger context produces a different fingerprint", () => {
    const networkChanged = computeValuationPayloadFingerprint({
      ...BASE_PAYLOAD,
      context: { network: "mainnet", ledgerSequence: 123456 },
    });
    const ledgerChanged = computeValuationPayloadFingerprint({
      ...BASE_PAYLOAD,
      context: { network: "testnet", ledgerSequence: 123457 },
    });
    const baseline = computeValuationPayloadFingerprint(BASE_PAYLOAD);

    expect(networkChanged.fingerprint).not.toBe(baseline.fingerprint);
    expect(ledgerChanged.fingerprint).not.toBe(baseline.fingerprint);
  });

  it("shortId starts with 'vop-'", () => {
    const { shortId } = computeValuationPayloadFingerprint(BASE_PAYLOAD);
    expect(shortId).toMatch(/^vop-/);
  });
});

// ─── createValuationOperationIdentity ────────────────────────────────────────

describe("createValuationOperationIdentity", () => {
  it("creates identity with correct fingerprint", () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD, "op-001");
    const { fingerprint } = computeValuationPayloadFingerprint(BASE_PAYLOAD);
    expect(identity.operationId).toBe("op-001");
    expect(identity.payloadFingerprint).toBe(fingerprint);
  });

  it("auto-generates operationId when not provided", () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD);
    expect(identity.operationId).toMatch(/^val_/);
  });

  it("createdAt is a valid ISO string", () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD, "op-002");
    expect(() => new Date(identity.createdAt)).not.toThrow();
    expect(new Date(identity.createdAt).toISOString()).toBe(identity.createdAt);
  });
});

// ─── ValuationOperationManager ───────────────────────────────────────────────

describe("ValuationOperationManager", () => {
  let manager: ValuationOperationManager;
  let state: TestState;

  beforeEach(() => {
    manager = new ValuationOperationManager();
    state = { ...INITIAL_STATE };
  });

  // ── 1. Normal operation ────────────────────────────────────────────────────

  it("1. executes a normal valuation successfully and updates state", async () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD, "op-normal-1");

    const result = await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
      onSuccessStateUpdate: (s, summary) => ({
        balance: summary.pricedValueUsd,
        lastUpdated: new Date().toISOString(),
      }),
    });

    expect(result.success).toBe(true);
    expect(result.replayed).toBe(false);
    expect(result.duplicate).toBe(false);
    expect(result.summary).toBeDefined();
    expect(result.state.balance).not.toBe(INITIAL_STATE.balance);
    expect(result.effects).toHaveLength(1);
    expect(result.effects?.[0].context).toEqual(BASE_PAYLOAD.context);
    expect(result.effects![0].type).toBe("PORTFOLIO_VALUATION_RECORDED");
    expect(manager.getOperation("op-normal-1")?.status).toBe("committed");
    expect(manager.getOperation("op-normal-1")?.context).toEqual(BASE_PAYLOAD.context);
  });

  // ── 2. Duplicate submission — same operationId + same payload ──────────────

  it("2. replays committed result for same operationId + same payload fingerprint", async () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD, "op-dup-1");

    // First execution
    const first = await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
    });
    expect(first.success).toBe(true);

    // Duplicate submission
    const second = await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
    });

    expect(second.success).toBe(true);
    expect(second.replayed).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.summary).toEqual(first.summary);
    // State must NOT be mutated — preserved as supplied
    expect(second.state).toEqual(state);
  });

  // ── 3. Concurrent duplicate — same operationId while in-flight ────────────

  it("3. rejects concurrent duplicate while in-flight (DUPLICATE_VALUATION_IN_PROGRESS)", async () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD, "op-inflight-1");

    // Simulate in-flight operation: inject it manually
    (manager as any).operations.set("op-inflight-1", {
      operationId: "op-inflight-1",
      payloadFingerprint: identity.payloadFingerprint,
      walletAddress: BASE_PAYLOAD.walletAddress,
      context: BASE_PAYLOAD.context,
      status: "in_flight",
      createdAt: new Date().toISOString(),
      replayedCount: 0,
    });

    const result = await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("DUPLICATE_VALUATION_IN_PROGRESS");
    expect(result.isRecoverable).toBe(true);
    // State preserved
    expect(result.state).toEqual(state);
  });

  // ── 4. Identity conflict — same operationId, different payload ─────────────

  it("4. rejects OPERATION_IDENTITY_CONFLICT for same operationId with different payload", async () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD, "op-conflict-1");

    // Commit with original payload
    await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
    });

    // Reuse same operationId with different payload
    const alteredIdentity = createValuationOperationIdentity(ALTERED_PAYLOAD, "op-conflict-1");

    const result = await manager.executeValuation<TestState, void>({
      payload: ALTERED_PAYLOAD,
      operationIdentity: alteredIdentity,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("OPERATION_IDENTITY_CONFLICT");
    expect(result.isRecoverable).toBe(false);
    // State preserved
    expect(result.state).toEqual(state);
  });

  // ── 5. Validation failure — state and balances preserved ─────────────────

  it("5. preserves state and balances when validation fails", async () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD, "op-valfail-1");

    const result = await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
      validate: () => "Validation rejected: positions do not meet minimum threshold",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("VALIDATION_FAILED");
    expect(result.isRecoverable).toBe(true);
    // Critical: state and balances UNCHANGED
    expect(result.state).toEqual(INITIAL_STATE);
    expect(result.state.balance).toBe(5000);
  });

  // ── 6. Execution failure — state and balances preserved ──────────────────

  it("6. preserves state and balances when execution fails", async () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD, "op-execfail-1");

    const result = await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
      execute: async () => {
        throw new Error("Storage layer unavailable");
      },
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("EXECUTION_FAILED");
    expect(result.isRecoverable).toBe(true);
    // Critical: state and balances UNCHANGED
    expect(result.state).toEqual(INITIAL_STATE);
    expect(result.state.balance).toBe(5000);
    // Operation should be in failed status (safe for retry with new operationId)
    expect(manager.getOperation("op-execfail-1")?.status).toBe("failed");
  });

  // ── 7. Safe retry after failure using a new operationId ──────────────────

  it("7. safe retry with new operationId succeeds after a previous failure", async () => {
    const failId = createValuationOperationIdentity(BASE_PAYLOAD, "op-retry-fail");
    let attemptCount = 0;

    // First attempt — fails
    await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: failId,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
      execute: async () => {
        attemptCount++;
        throw new Error("Transient error");
      },
    });

    expect(manager.getOperation("op-retry-fail")?.status).toBe("failed");

    // Retry with a fresh operationId (new identity, same payload)
    const retryId = createValuationOperationIdentity(BASE_PAYLOAD, "op-retry-success");
    const retryResult = await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: retryId,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
      execute: async () => {
        attemptCount++;
        // succeeds this time
      },
    });

    expect(retryResult.success).toBe(true);
    expect(retryResult.replayed).toBe(false);
    expect(retryResult.duplicate).toBe(false);
    expect(manager.getOperation("op-retry-success")?.status).toBe("committed");
    expect(attemptCount).toBe(2); // Both attempts ran
  });

  // ── 8. No side effects on validation failure ──────────────────────────────

  it("8. no operation record is committed when validation fails", async () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD, "op-no-commit");

    await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
      validate: () => false,
    });

    // Record should NOT be committed (may be absent or in failed/rejected status)
    const record = manager.getOperation("op-no-commit");
    expect(record?.status ?? "absent").not.toBe("committed");
  });

  // ── 9. Fingerprint mismatch in replay guard ───────────────────────────────

  it("9. detects fingerprint mismatch when operation record fingerprint is tampered", async () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD, "op-tamper-1");

    // Manually inject an operation with a different fingerprint under the same ID
    (manager as any).operations.set("op-tamper-1", {
      operationId: "op-tamper-1",
      payloadFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
      walletAddress: BASE_PAYLOAD.walletAddress,
      context: BASE_PAYLOAD.context,
      status: "committed",
      createdAt: new Date().toISOString(),
      replayedCount: 0,
    });

    // Try to replay with real identity (fingerprint mismatch)
    const result = await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: state,
      getCurrentContext: () => BASE_PAYLOAD.context,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("OPERATION_IDENTITY_CONFLICT");
    // State preserved
    expect(result.state).toEqual(state);
  });

  it("rejects a request read on a different network or ledger without changing state", async () => {
    const mismatchedContexts = [
      { network: "mainnet", ledgerSequence: BASE_PAYLOAD.context.ledgerSequence },
      { network: "testnet", ledgerSequence: BASE_PAYLOAD.context.ledgerSequence + 1 },
    ];

    for (const [index, currentContext] of mismatchedContexts.entries()) {
      const identity = createValuationOperationIdentity(BASE_PAYLOAD, `op-context-${index}`);
      const execute = vi.fn();
      const result = await manager.executeValuation<TestState, void>({
        payload: BASE_PAYLOAD,
        operationIdentity: identity,
        currentState: state,
        getCurrentContext: () => currentContext,
        execute,
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("VALUATION_CONTEXT_MISMATCH");
      expect(result.state).toEqual(INITIAL_STATE);
      expect(execute).not.toHaveBeenCalled();
      expect(manager.getOperation(identity.operationId)).toBeUndefined();
    }
  });

  it("rejects a mid-execution ledger transition and safely retries in the original context", async () => {
    const identity = createValuationOperationIdentity(BASE_PAYLOAD, "op-context-retry");
    let activeContext = BASE_PAYLOAD.context;
    let attemptCount = 0;
    const result = await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: state,
      getCurrentContext: () => activeContext,
      execute: async (_summary, context) => {
        expect(context).toEqual(BASE_PAYLOAD.context);
        attemptCount += 1;
        if (attemptCount === 1) {
          activeContext = { ...BASE_PAYLOAD.context, ledgerSequence: 123457 };
        }
      },
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("VALUATION_CONTEXT_MISMATCH");
    expect(result.state).toEqual(INITIAL_STATE);
    expect(manager.getOperation(identity.operationId)?.status).toBe("rejected");

    activeContext = BASE_PAYLOAD.context;
    const retry = await manager.executeValuation<TestState, void>({
      payload: BASE_PAYLOAD,
      operationIdentity: identity,
      currentState: state,
      getCurrentContext: () => activeContext,
      onSuccessStateUpdate: (_current, summary) => ({
        balance: summary.pricedValueUsd,
        lastUpdated: "retried",
      }),
    });

    expect(retry.success).toBe(true);
    expect(retry.state.balance).not.toBe(INITIAL_STATE.balance);
    expect(retry.effects?.[0].context).toEqual(BASE_PAYLOAD.context);
    expect(manager.getOperation(identity.operationId)?.status).toBe("committed");
  });
});
