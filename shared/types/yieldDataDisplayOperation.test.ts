import { describe, expect, it, vi } from "vitest";
import {
  YieldDisplayOperationManager,
  computeYieldDisplayPayloadFingerprint,
  createYieldDisplayOperationIdentity,
  isValidYieldDisplayOperationId,
  resolveYieldDisplayOperationIdentity,
  type NetYieldDisplayPayload,
  type YieldCurveDisplayPayload,
} from "./yieldDataDisplayOperation";

const curvePayload: YieldCurveDisplayPayload = {
  scope: "yield-curve",
  horizon: "90d",
  principalUsd: 10_000,
  compounding: "daily",
  feeDragPct: 1,
  allocations: [
    { id: "blend", apyPct: 6.5, weightPct: 40 },
    { id: "soroswap", apyPct: 12.2, weightPct: 60 },
  ],
};

const netPayload: NetYieldDisplayPayload = {
  scope: "net-yield",
  grossApy: 12,
  protocols: [
    { protocol: "blend", grossApy: 6.5 },
    { protocol: "soroswap", grossApy: 5.5 },
  ],
  assumptions: { protocolFeeBps: 45, vaultFeeBps: 80 },
};

describe("yield display operation identity", () => {
  it("canonicalizes equivalent payloads into one fingerprint", () => {
    const reordered: YieldCurveDisplayPayload = {
      ...curvePayload,
      compounding: "DAILY",
      allocations: [...curvePayload.allocations].reverse(),
      principalUsd: 10_000.001,
    };
    expect(computeYieldDisplayPayloadFingerprint(reordered).fingerprint).toBe(
      computeYieldDisplayPayloadFingerprint(curvePayload).fingerprint,
    );
    expect(computeYieldDisplayPayloadFingerprint(netPayload).fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects malformed operation ids and restores a matching identity", () => {
    expect(isValidYieldDisplayOperationId("valid_op-1234")).toBe(true);
    expect(isValidYieldDisplayOperationId("short")).toBe(false);
    expect(isValidYieldDisplayOperationId("../escape")).toBe(false);

    const identity = createYieldDisplayOperationIdentity(curvePayload, {
      operationId: "retry_key_1234",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(identity.operationId).toBe("retry_key_1234");
    expect(resolveYieldDisplayOperationIdentity(curvePayload, identity)).toBe(identity);
    expect(
      resolveYieldDisplayOperationIdentity(
        { ...curvePayload, principalUsd: 20_000 },
        identity,
      ).operationId,
    ).not.toBe(identity.operationId);
  });
});

describe("YieldDisplayOperationManager", () => {
  it("applies a normal operation once and updates state", async () => {
    const manager = new YieldDisplayOperationManager();
    const identity = createYieldDisplayOperationIdentity(curvePayload, {
      operationId: "normal_op_1234",
    });
    const execute = vi.fn(() => ({ netApy: 9.5 }));
    const state = { netApy: 0, effects: 0 };
    const result = await manager.executeYieldDisplay({
      payload: curvePayload,
      operationIdentity: identity,
      currentState: state,
      execute,
      onSuccessStateUpdate: (current, _effect, net) => ({
        netApy: net?.netApy ?? 0,
        effects: current.effects + 1,
      }),
    });

    expect(result.success).toBe(true);
    expect(result.state).toEqual({ netApy: 9.5, effects: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(manager.getOperation(identity.operationId)?.status).toBe("committed");
  });

  it("replays a committed operation without applying the effect twice", async () => {
    const manager = new YieldDisplayOperationManager();
    const identity = createYieldDisplayOperationIdentity(netPayload, {
      operationId: "replay_op_1234",
    });
    const execute = vi.fn(() => ({ netApy: 11 }));
    const currentState = { netApy: 0, balanceUsd: 500 };
    const options = {
      payload: netPayload,
      operationIdentity: identity,
      currentState,
      execute,
      onSuccessStateUpdate: () => ({ netApy: 11, balanceUsd: 500 }),
    };

    const first = await manager.executeYieldDisplay(options);
    const retry = await manager.executeYieldDisplay(options);

    expect(first.success).toBe(true);
    expect(retry.success).toBe(true);
    expect(retry.replayed).toBe(true);
    expect(retry.duplicate).toBe(true);
    expect(retry.result).toEqual(first.result);
    expect(retry.state).toBe(currentState);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(manager.getOperation(identity.operationId)?.replayedCount).toBe(1);
  });

  it("rejects concurrent duplicates and identity conflicts without changing state", async () => {
    const manager = new YieldDisplayOperationManager();
    const identity = createYieldDisplayOperationIdentity(curvePayload, {
      operationId: "concurrent_op_1234",
    });
    let release!: () => void;
    const pending = new Promise<{ netApy: number }>((resolve) => {
      release = () => resolve({ netApy: 9 });
    });
    const execute = vi.fn(() => pending);
    const currentState = { balanceUsd: 1000 };

    const inFlight = manager.executeYieldDisplay({
      payload: curvePayload,
      operationIdentity: identity,
      currentState,
      execute,
    });
    const duplicate = await manager.executeYieldDisplay({
      payload: curvePayload,
      operationIdentity: identity,
      currentState,
      execute,
    });
    expect(duplicate.errorCode).toBe("DUPLICATE_YIELD_DISPLAY_IN_PROGRESS");
    expect(duplicate.state).toBe(currentState);
    expect(execute).toHaveBeenCalledTimes(1);

    release();
    await inFlight;

    const conflict = await manager.executeYieldDisplay({
      payload: { ...curvePayload, principalUsd: 25_000 },
      operationIdentity: identity,
      currentState,
      execute,
    });
    expect(conflict.errorCode).toBe("YIELD_DISPLAY_OPERATION_IDENTITY_CONFLICT");
    expect(conflict.state).toBe(currentState);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves balances on validation failure", async () => {
    const manager = new YieldDisplayOperationManager();
    const identity = createYieldDisplayOperationIdentity(curvePayload, {
      operationId: "validation_op_1234",
    });
    const execute = vi.fn(() => 1);
    const balances = { principalUsd: 10_000, collateralUsd: 2_000 };
    const result = await manager.executeYieldDisplay({
      payload: curvePayload,
      operationIdentity: identity,
      currentState: balances,
      validate: () => "Allocation weights must sum to 100%.",
      execute,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("YIELD_DISPLAY_VALIDATION_FAILED");
    expect(result.state).toBe(balances);
    expect(execute).not.toHaveBeenCalled();
    expect(manager.getOperation(identity.operationId)?.status).toBe("rejected");
  });

  it("preserves balances on execution failure and allows a safe retry", async () => {
    const manager = new YieldDisplayOperationManager();
    const identity = createYieldDisplayOperationIdentity(curvePayload, {
      operationId: "retry_safe_1234",
    });
    const execute = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("rpc unavailable");
      })
      .mockImplementationOnce(() => 8);
    const balances = { principalUsd: 10_000, collateralUsd: 2_000 };
    const options = {
      payload: curvePayload,
      operationIdentity: identity,
      currentState: balances,
      execute,
      onSuccessStateUpdate: () => ({ principalUsd: 11_000, collateralUsd: 2_000 }),
    };

    const failed = await manager.executeYieldDisplay(options);
    expect(failed.success).toBe(false);
    expect(failed.errorCode).toBe("YIELD_DISPLAY_EXECUTION_FAILED");
    expect(failed.state).toBe(balances);
    expect(failed.isRecoverable).toBe(true);
    expect(manager.getOperation(identity.operationId)?.status).toBe("failed");

    const retried = await manager.executeYieldDisplay(options);
    expect(retried.success).toBe(true);
    expect(retried.state).toEqual({ principalUsd: 11_000, collateralUsd: 2_000 });
    expect(execute).toHaveBeenCalledTimes(2);

    const duplicate = await manager.executeYieldDisplay(options);
    expect(duplicate.replayed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("guards synchronous display commits used by the client", () => {
    const manager = new YieldDisplayOperationManager();
    const identity = createYieldDisplayOperationIdentity(curvePayload, {
      operationId: "sync_op_1234",
    });
    const execute = vi.fn(() => ({ netApy: 8 }));
    const options = {
      payload: curvePayload,
      operationIdentity: identity,
      currentState: { netApy: 0 },
      execute,
      onSuccessStateUpdate: (_state, _effect, result) => ({
        netApy: (result as { netApy: number }).netApy,
      }),
    };

    expect(manager.executeYieldDisplaySync(options).state.netApy).toBe(8);
    const replay = manager.executeYieldDisplaySync(options);
    expect(replay.replayed).toBe(true);
    expect(replay.state.netApy).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
