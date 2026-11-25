import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_STRATEGY_COMPARISON_CONFIG,
  StrategyComparisonConfig,
  canonicalizeStrategyComparisonConfig,
  computeStrategyComparisonConfigFingerprint,
  verifyStrategyComparisonConfigFingerprint,
  executeStrategySafely,
  StrategyExecutionState,
  formatShortFingerprint,
} from "./strategyComparisonConfigFingerprint";

describe("StrategyComparisonConfigFingerprint", () => {
  it("produces deterministic SHA-256 fingerprint for identical configurations", () => {
    const config1: StrategyComparisonConfig = {
      supportedProtocols: ["Blend", "Soroswap", "DeFindex"],
      validationRules: {
        requiredFields: ["protocolName", "apy", "tvl"],
        allowedRebalancingBehaviors: ["Static", "Dynamic"],
        minLiquidityUsd: 1000,
      },
      schemaVersion: "1.0.0",
      riskConstraints: { maxRiskScore: 90, maxVolatilityPct: 50 },
    };

    // Reordered fields and arrays
    const config2: StrategyComparisonConfig = {
      riskConstraints: { maxVolatilityPct: 50, maxRiskScore: 90 },
      schemaVersion: "1.0.0",
      validationRules: {
        minLiquidityUsd: 1000,
        allowedRebalancingBehaviors: ["Dynamic", "Static"],
        requiredFields: ["tvl", "protocolName", "apy"],
      },
      supportedProtocols: ["DeFindex", "Blend", "Soroswap"],
    };

    const res1 = computeStrategyComparisonConfigFingerprint(config1);
    const res2 = computeStrategyComparisonConfigFingerprint(config2);

    expect(res1.fingerprint).toHaveLength(64);
    expect(res1.fingerprint).toBe(res2.fingerprint);
    expect(res1.shortFingerprint).toMatch(/^scf-[0-9a-f]{6}…[0-9a-f]{4}$/);
  });

  it("changes fingerprint when configuration parameters change", () => {
    const base = DEFAULT_STRATEGY_COMPARISON_CONFIG;
    const baseFp = computeStrategyComparisonConfigFingerprint(base).fingerprint;

    // 1. Protocol addition
    const modifiedProtocols: StrategyComparisonConfig = {
      ...base,
      supportedProtocols: [...base.supportedProtocols, "Aquarius"],
    };
    expect(computeStrategyComparisonConfigFingerprint(modifiedProtocols).fingerprint).not.toBe(baseFp);

    // 2. Validation rules changed
    const modifiedValidation: StrategyComparisonConfig = {
      ...base,
      validationRules: {
        ...base.validationRules,
        minLiquidityUsd: 50000,
      },
    };
    expect(computeStrategyComparisonConfigFingerprint(modifiedValidation).fingerprint).not.toBe(baseFp);

    // 3. Schema version bump
    const modifiedSchema: StrategyComparisonConfig = {
      ...base,
      schemaVersion: "2.0.0",
    };
    expect(computeStrategyComparisonConfigFingerprint(modifiedSchema).fingerprint).not.toBe(baseFp);
  });

  it("verifies matching fingerprint correctly", () => {
    const config = DEFAULT_STRATEGY_COMPARISON_CONFIG;
    const { fingerprint } = computeStrategyComparisonConfigFingerprint(config);

    const verification = verifyStrategyComparisonConfigFingerprint(config, fingerprint);
    expect(verification.valid).toBe(true);
    expect(verification.status).toBe("verified");
    expect(verification.code).toBe("FINGERPRINT_VERIFIED");
  });

  it("detects stale configuration snapshot when fingerprint mismatches", () => {
    const currentConfig = DEFAULT_STRATEGY_COMPARISON_CONFIG;
    const staleFingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const verification = verifyStrategyComparisonConfigFingerprint(currentConfig, staleFingerprint);
    expect(verification.valid).toBe(false);
    expect(verification.status).toBe("stale");
    expect(verification.code).toBe("STALE_STRATEGY_CONFIG");
    expect(verification.message).toContain("stale");
  });

  it("handles malformed or empty claimed fingerprint", () => {
    const currentConfig = DEFAULT_STRATEGY_COMPARISON_CONFIG;
    const verification = verifyStrategyComparisonConfigFingerprint(currentConfig, "");
    expect(verification.valid).toBe(false);
    expect(verification.status).toBe("invalid");
    expect(verification.code).toBe("INVALID_FINGERPRINT");
  });

  describe("executeStrategySafely - Acceptance Criteria Tests", () => {
    const initialBalances = { XLM: 5000, USDC: 1000 };
    const initialState: StrategyExecutionState<typeof initialBalances> = {
      selectedStrategyId: null,
      balances: initialBalances,
      lastConfirmedFingerprint: null,
      executionStatus: "idle",
      errorMessage: null,
    };

    // 1. Normal strategy comparison and successful execution
    it("1. Normal strategy comparison and successful execution commits state and updates balances", async () => {
      const activeConfig = DEFAULT_STRATEGY_COMPARISON_CONFIG;
      const { fingerprint } = computeStrategyComparisonConfigFingerprint(activeConfig);

      const executeFn = vi.fn().mockResolvedValue({ txHash: "0x123abc", committed: true });

      const result = await executeStrategySafely({
        activeConfig,
        snapshotFingerprint: fingerprint,
        currentState: initialState,
        targetStrategyId: "blend-yield",
        validate: () => true,
        execute: executeFn,
        onSuccessBalanceUpdate: (balances) => ({
          ...balances,
          USDC: balances.USDC - 200,
        }),
      });

      expect(result.success).toBe(true);
      expect(result.state.executionStatus).toBe("executed");
      expect(result.state.selectedStrategyId).toBe("blend-yield");
      expect(result.state.balances.USDC).toBe(800);
      expect(result.state.balances.XLM).toBe(5000);
      expect(result.state.lastConfirmedFingerprint).toBe(fingerprint);
      expect(executeFn).toHaveBeenCalledTimes(1);
    });

    // 2. Configuration changes that invalidate an existing snapshot
    it("2. Configuration changes that invalidate an existing snapshot reject execution and preserve state", async () => {
      const oldConfig = DEFAULT_STRATEGY_COMPARISON_CONFIG;
      const staleSnapshotFp = computeStrategyComparisonConfigFingerprint(oldConfig).fingerprint;

      // Active config was changed (e.g. protocol updated or removed)
      const updatedActiveConfig: StrategyComparisonConfig = {
        ...oldConfig,
        supportedProtocols: ["Blend", "Soroswap"], // DeFindex removed
      };

      const executeFn = vi.fn();

      const result = await executeStrategySafely({
        activeConfig: updatedActiveConfig,
        snapshotFingerprint: staleSnapshotFp,
        currentState: initialState,
        targetStrategyId: "defindex-vault",
        execute: executeFn,
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("STALE_STRATEGY_CONFIG");
      expect(result.isRecoverable).toBe(true);
      expect(executeFn).not.toHaveBeenCalled();

      // State and balances are preserved exactly
      expect(result.state.balances).toEqual(initialBalances);
      expect(result.state.selectedStrategyId).toBeNull();
      expect(result.state.executionStatus).toBe("stale_rejected");
    });

    // 3. Validation failures
    it("3. Validation failures stop execution and preserve existing state and balances", async () => {
      const activeConfig = DEFAULT_STRATEGY_COMPARISON_CONFIG;
      const { fingerprint } = computeStrategyComparisonConfigFingerprint(activeConfig);

      const executeFn = vi.fn();

      const result = await executeStrategySafely({
        activeConfig,
        snapshotFingerprint: fingerprint,
        currentState: initialState,
        targetStrategyId: "blend-yield",
        validate: () => "Minimum liquidity requirement not met",
        execute: executeFn,
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("VALIDATION_FAILED");
      expect(result.error).toBe("Minimum liquidity requirement not met");
      expect(executeFn).not.toHaveBeenCalled();

      // Existing state and balances remain intact
      expect(result.state.balances).toEqual(initialBalances);
      expect(result.state.selectedStrategyId).toBeNull();
      expect(result.state.executionStatus).toBe("failed");
    });

    // 4. Strategy execution failures
    it("4. Strategy execution failures preserve state and balances without partial mutation", async () => {
      const activeConfig = DEFAULT_STRATEGY_COMPARISON_CONFIG;
      const { fingerprint } = computeStrategyComparisonConfigFingerprint(activeConfig);

      const executeFn = vi.fn().mockRejectedValue(new Error("RPC submission timeout"));

      const result = await executeStrategySafely({
        activeConfig,
        snapshotFingerprint: fingerprint,
        currentState: initialState,
        targetStrategyId: "blend-yield",
        validate: () => true,
        execute: executeFn,
        onSuccessBalanceUpdate: () => ({ XLM: 0, USDC: 0 }), // Should NOT be called
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("EXECUTION_FAILED");
      expect(result.error).toBe("RPC submission timeout");

      // Crucial: Balances remain exactly unchanged
      expect(result.state.balances).toEqual(initialBalances);
      expect(result.state.selectedStrategyId).toBeNull();
      expect(result.state.executionStatus).toBe("failed");
    });

    // 5. Safe retry behavior after stale configuration is detected
    it("5. Safe retry behavior: refreshing with fresh configuration fingerprint succeeds", async () => {
      const oldConfig = DEFAULT_STRATEGY_COMPARISON_CONFIG;
      const staleSnapshotFp = computeStrategyComparisonConfigFingerprint(oldConfig).fingerprint;

      const newConfig: StrategyComparisonConfig = {
        ...oldConfig,
        supportedProtocols: ["Blend", "Soroswap", "DeFindex", "StellarX"],
      };
      const freshFingerprint = computeStrategyComparisonConfigFingerprint(newConfig).fingerprint;

      const executeFn = vi.fn().mockResolvedValue({ status: "success" });

      // Step 1: Attempt with stale snapshot fails safely
      const staleAttempt = await executeStrategySafely({
        activeConfig: newConfig,
        snapshotFingerprint: staleSnapshotFp,
        currentState: initialState,
        targetStrategyId: "blend-yield",
        execute: executeFn,
      });
      expect(staleAttempt.success).toBe(false);
      expect(staleAttempt.errorCode).toBe("STALE_STRATEGY_CONFIG");
      expect(staleAttempt.isRecoverable).toBe(true);

      // Step 2: Retry with fresh fingerprint succeeds
      const retryAttempt = await executeStrategySafely({
        activeConfig: newConfig,
        snapshotFingerprint: freshFingerprint,
        currentState: staleAttempt.state, // Pass through state
        targetStrategyId: "blend-yield",
        execute: executeFn,
        onSuccessBalanceUpdate: (b) => ({ ...b, USDC: b.USDC - 50 }),
      });

      expect(retryAttempt.success).toBe(true);
      expect(retryAttempt.state.executionStatus).toBe("executed");
      expect(retryAttempt.state.balances.USDC).toBe(950);
      expect(retryAttempt.state.lastConfirmedFingerprint).toBe(freshFingerprint);
    });

    // 6. Preservation of existing state and balances after failures
    it("6. Multi-step failure sequences preserve existing balances and state across all attempts", async () => {
      const activeConfig = DEFAULT_STRATEGY_COMPARISON_CONFIG;
      const { fingerprint } = computeStrategyComparisonConfigFingerprint(activeConfig);

      let currentState = { ...initialState };

      // Attempt 1: Validation fails
      const res1 = await executeStrategySafely({
        activeConfig,
        snapshotFingerprint: fingerprint,
        currentState,
        validate: () => "Invalid asset balance",
        execute: vi.fn(),
      });
      currentState = res1.state;
      expect(currentState.balances).toEqual(initialBalances);

      // Attempt 2: Execution throws
      const res2 = await executeStrategySafely({
        activeConfig,
        snapshotFingerprint: fingerprint,
        currentState,
        execute: async () => {
          throw new Error("Relayer rejected fee-bump");
        },
      });
      currentState = res2.state;
      expect(currentState.balances).toEqual(initialBalances);

      // Attempt 3: Stale fingerprint
      const res3 = await executeStrategySafely({
        activeConfig,
        snapshotFingerprint: "stale-fake-fp",
        currentState,
        execute: vi.fn(),
      });
      currentState = res3.state;
      expect(currentState.balances).toEqual(initialBalances);
      expect(currentState.selectedStrategyId).toBeNull();
    });
  });
});
