import { describe, expect, it, vi } from "vitest";
import {
  captureSimulationConfig,
  computeSimulationConfigFingerprint,
  isSimulationConfigFingerprint,
  simulationConfigMatches,
  assertSimulationConfigCurrent,
  runWithSimulationConfig,
  StatePreservationGuard,
  SIMULATION_CONFIG_FINGERPRINT_PREFIX,
  type SimulationConfig,
  type SimulationConfigSnapshot,
} from "../src/simulationConfig";
import { StaleSimulationConfigError, isStaleSimulationConfigError } from "../src/errors";
import { ApiClient } from "../src/api/ApiClient";
import { VaultClient } from "../src/vault/VaultClient";

describe("SDK Simulation API Configuration Hardening (#1851)", () => {
  const baseConfig: SimulationConfig = {
    strategyId: "blend-usdc-v1",
    networkPassphrase: "Test SDF Network ; September 2015",
    token: "USDC",
    protocolFeeBps: 15,
    slippageToleranceBps: 100,
    minResourceFee: 1200n,
    maxDeposit: 1_000_000,
  };

  describe("Normal operation & immutable fingerprinting", () => {
    it("computes a deterministic fingerprint with versioned prefix", () => {
      const fp = computeSimulationConfigFingerprint(baseConfig);
      expect(isSimulationConfigFingerprint(fp)).toBe(true);
      expect(fp.startsWith(SIMULATION_CONFIG_FINGERPRINT_PREFIX)).toBe(true);
      // 8 chars prefix + 16 hex chars = 24 chars
      expect(fp).toMatch(/^simcfg1:[0-9a-f]{16}$/);
    });

    it("generates identical fingerprints regardless of key ordering", () => {
      const reorderedConfig: SimulationConfig = {
        maxDeposit: 1_000_000,
        token: "USDC",
        protocolFeeBps: 15,
        networkPassphrase: "Test SDF Network ; September 2015",
        minResourceFee: 1200n,
        slippageToleranceBps: 100,
        strategyId: "blend-usdc-v1",
      };
      const fp1 = computeSimulationConfigFingerprint(baseConfig);
      const fp2 = computeSimulationConfigFingerprint(reorderedConfig);
      expect(fp1).toBe(fp2);
    });

    it("generates distinct fingerprints when configuration values change", () => {
      const fp1 = computeSimulationConfigFingerprint(baseConfig);
      const modifiedConfig: SimulationConfig = {
        ...baseConfig,
        protocolFeeBps: 20,
      };
      const fp2 = computeSimulationConfigFingerprint(modifiedConfig);
      expect(fp1).not.toBe(fp2);
    });

    it("captures an immutable deep-frozen snapshot", () => {
      const snapshot = captureSimulationConfig(baseConfig);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.config)).toBe(true);
      expect(snapshot.fingerprint).toBe(computeSimulationConfigFingerprint(baseConfig));
      expect(typeof snapshot.capturedAt).toBe("number");

      // Mutation attempts should fail in strict mode
      expect(() => {
        (snapshot.config as any).strategyId = "tampered";
      }).toThrow();
    });

    it("correctly matches equivalent configuration sources", () => {
      const snapshot = captureSimulationConfig(baseConfig);
      const fp = snapshot.fingerprint;

      expect(simulationConfigMatches(baseConfig, snapshot)).toBe(true);
      expect(simulationConfigMatches(fp, snapshot)).toBe(true);
      expect(simulationConfigMatches(fp, baseConfig)).toBe(true);
      expect(simulationConfigMatches(snapshot, fp)).toBe(true);

      const differentConfig: SimulationConfig = { ...baseConfig, maxDeposit: 500 };
      expect(simulationConfigMatches(snapshot, differentConfig)).toBe(false);
    });

    it("assertSimulationConfigCurrent succeeds when configurations match", () => {
      const snapshot = captureSimulationConfig(baseConfig);
      expect(() => {
        assertSimulationConfigCurrent(snapshot, baseConfig);
      }).not.toThrow();
    });

    it("executes work cleanly under a stable configuration snapshot", async () => {
      let liveConfig = { ...baseConfig };
      const balances = { userUsdc: 10_000n, vaultShares: 0n };

      const runResult = await runWithSimulationConfig({
        readConfig: () => liveConfig,
        stateSnapshot: balances,
        run: async (snapshot) => {
          expect(snapshot.config.strategyId).toBe("blend-usdc-v1");
          return {
            expectedShares: 9_985n,
            estimatedFee: 15n,
          };
        },
      });

      expect(runResult.result.expectedShares).toBe(9_985n);
      expect(runResult.attempts).toBe(1);
      expect(runResult.preservedState).toEqual(balances);
    });
  });

  describe("Failure, rejection & state preservation", () => {
    it("assertSimulationConfigCurrent throws StaleSimulationConfigError on mismatch", () => {
      const snapshot = captureSimulationConfig(baseConfig);
      const changedConfig: SimulationConfig = { ...baseConfig, protocolFeeBps: 50 };
      const balances = { userUsdc: 50_000n };

      try {
        assertSimulationConfigCurrent(snapshot, changedConfig, {
          stateSnapshot: balances,
        });
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(isStaleSimulationConfigError(err)).toBe(true);
        const staleErr = err as StaleSimulationConfigError;
        expect(staleErr.code).toBe("SIMULATION_CONFIG_STALE");
        expect(staleErr.retryable).toBe(true);
        expect(staleErr.statePreserved).toBe(true);
        expect(staleErr.preservedState).toEqual(balances);
        expect(staleErr.expectedFingerprint).toBe(snapshot.fingerprint);
        expect(staleErr.actualFingerprint).toBe(
          computeSimulationConfigFingerprint(changedConfig)
        );
      }
    });

    it("rejects work when configuration drifts during execution and preserves state", async () => {
      let liveConfig = { ...baseConfig };
      const balances = { userUsdc: 25_000n, vaultShares: 5_000n };
      const stateBackup = { ...balances };

      await expect(
        runWithSimulationConfig({
          readConfig: () => liveConfig,
          stateSnapshot: balances,
          run: async () => {
            // Live configuration drifts during the asynchronous simulation
            liveConfig = { ...liveConfig, protocolFeeBps: 99 };
            return { expectedShares: 100n };
          },
          onStale: "reject",
        })
      ).rejects.toThrow(StaleSimulationConfigError);

      // Verify balances were completely preserved and not modified
      expect(balances).toEqual(stateBackup);
    });

    it("rejects malformed fingerprints safely", () => {
      expect(() => {
        assertSimulationConfigCurrent("invalid:fingerprint" as any, baseConfig);
      }).toThrow(/malformed/);
    });

    it("rejects non-finite numbers in simulation config", () => {
      expect(() => {
        computeSimulationConfigFingerprint({ badValue: Infinity });
      }).toThrow(/non-finite/);
    });

    it("StatePreservationGuard guarantees immutability of caller state upon failure", async () => {
      const initialBalances = { userBalance: 500n, lockedBalance: 100n };
      const guard = new StatePreservationGuard(initialBalances);

      await expect(
        guard.executeSafely(async () => {
          throw new StaleSimulationConfigError("Stale snapshot", {
            statePreserved: true,
          });
        })
      ).rejects.toThrow(StaleSimulationConfigError);

      expect(guard.getSnapshot()).toEqual(initialBalances);
      expect(Object.isFrozen(guard.getSnapshot())).toBe(true);
    });
  });

  describe("Safe retry & transparent refresh behavior", () => {
    it("transparently refreshes when configuration drifts and onStale is 'refresh'", async () => {
      let liveConfig = { ...baseConfig };
      const balances = { userUsdc: 100_000n };
      let executionCount = 0;
      const refreshEvents: any[] = [];

      const runResult = await runWithSimulationConfig({
        readConfig: () => liveConfig,
        stateSnapshot: balances,
        onStale: "refresh",
        maxAttempts: 3,
        onRefresh: (event) => refreshEvents.push(event),
        run: async (snapshot) => {
          executionCount++;
          if (executionCount === 1) {
            // Admin updates protocol fee on first attempt
            liveConfig = { ...liveConfig, protocolFeeBps: 25 };
          }
          return {
            appliedFeeBps: snapshot.config.protocolFeeBps,
            sharesOut: 10_000n - BigInt(Number(snapshot.config.protocolFeeBps || 0)),
          };
        },
      });

      expect(executionCount).toBe(2);
      expect(runResult.attempts).toBe(2);
      expect(runResult.result.appliedFeeBps).toBe(25);
      expect(runResult.result.sharesOut).toBe(9_975n);
      expect(refreshEvents).toHaveLength(1);
      expect(refreshEvents[0].attempt).toBe(1);
      expect(refreshEvents[0].previousFingerprint).toBe(
        computeSimulationConfigFingerprint(baseConfig)
      );
      expect(refreshEvents[0].nextFingerprint).toBe(
        computeSimulationConfigFingerprint(liveConfig)
      );
    });

    it("fails with StaleSimulationConfigError if configuration keeps drifting past maxAttempts", async () => {
      let liveConfig = { ...baseConfig };
      let executionCount = 0;

      await expect(
        runWithSimulationConfig({
          readConfig: () => liveConfig,
          onStale: "refresh",
          maxAttempts: 2,
          run: async () => {
            executionCount++;
            // Continuously drift configuration on each attempt
            liveConfig = { ...liveConfig, protocolFeeBps: 100 + executionCount };
            return { ok: true };
          },
        })
      ).rejects.toThrow(StaleSimulationConfigError);

      expect(executionCount).toBe(2);
    });
  });

  describe("ApiClient integration", () => {
    it("attaches configuration fingerprint to deposit simulation", async () => {
      const client = new ApiClient({ baseUrl: "https://api.stellaryield.io" });
      client.setSimulationConfig(baseConfig);
      const snapshot = client.getSimulationConfig()!;
      expect(snapshot).not.toBeNull();
      expect(client.getSimulationConfigFingerprint()).toBe(snapshot.fingerprint);

      const mockResponse = {
        isSimulationOnly: true,
        expectedShares: 990,
        fees: [{ type: "Entry Fee", amount: 1 }],
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.simulateDeposit({
        strategyId: "blend-usdc-v1",
        amount: 1000,
        token: "USDC",
        expectedConfigFingerprint: snapshot.fingerprint,
      });

      expect(result.expectedShares).toBe(990);
      expect(result.configFingerprint).toBe(snapshot.fingerprint);
    });

    it("rejects simulateDeposit with StaleSimulationConfigError when expected fingerprint does not match", async () => {
      const client = new ApiClient({ baseUrl: "https://api.stellaryield.io" });
      client.setSimulationConfig(baseConfig);

      const callerBalances = { usdc: 50_000n };
      const staleFingerprint = "simcfg1:0000000000000000";

      const fetchSpy = vi.spyOn(global, "fetch");

      await expect(
        client.simulateDeposit({
          strategyId: "blend-usdc-v1",
          amount: 1000,
          token: "USDC",
          expectedConfigFingerprint: staleFingerprint,
          stateSnapshot: callerBalances,
        })
      ).rejects.toThrow(StaleSimulationConfigError);

      // Network request must NOT be dispatched on stale validation failure
      expect(fetchSpy).not.toHaveBeenCalled();
      // Caller balances remain untouched
      expect(callerBalances.usdc).toBe(50_000n);
    });

    it("refreshes simulateDeposit automatically when onStale is 'refresh'", async () => {
      let currentConfig = { ...baseConfig };
      const client = new ApiClient({ baseUrl: "https://api.stellaryield.io" });
      client.setSimulationConfigReader(() => currentConfig);

      const staleSnapshot = captureSimulationConfig(currentConfig);
      // Admin modifies fee in live environment
      currentConfig = { ...currentConfig, protocolFeeBps: 50 };

      const mockResponse = {
        isSimulationOnly: true,
        expectedShares: 950,
      };

      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.simulateDeposit({
        strategyId: "blend-usdc-v1",
        amount: 1000,
        token: "USDC",
        expectedConfigFingerprint: staleSnapshot.fingerprint,
        onStale: "refresh",
      });

      expect(result.expectedShares).toBe(950);
      expect(result.simulationAttempts).toBe(1);
      expect(result.configFingerprint).toBe(
        computeSimulationConfigFingerprint(currentConfig)
      );
    });

    it("retries a partially completed simulation under the refreshed config", async () => {
      let currentConfig: SimulationConfig = { ...baseConfig };
      const client = new ApiClient({ baseUrl: "https://api.stellaryield.io" });
      client.setSimulationConfigReader(() => currentConfig);
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
        currentConfig = {
          ...currentConfig,
          protocolFeeBps: Number(currentConfig.protocolFeeBps) + 1,
        };
        return new Response(JSON.stringify({ expectedShares: 900 }), { status: 200 });
      });

      const balances = { usdc: 10_000n };
      const error = await client
        .simulateDeposit(
          {
            strategyId: "blend-usdc-v1",
            amount: 1000,
            token: "USDC",
            onStale: "refresh",
            maxAttempts: 2,
            stateSnapshot: balances,
          }
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StaleSimulationConfigError);
      expect((error as StaleSimulationConfigError).attempts).toBe(2);
      expect((error as StaleSimulationConfigError).statePreserved).toBe(true);
      expect((error as StaleSimulationConfigError).preservedState).toEqual(balances);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(balances).toEqual({ usdc: 10_000n });

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ expectedShares: 875 }), { status: 200 })
      );
      const retry = await client.simulateDeposit(
        {
          strategyId: "blend-usdc-v1",
          amount: 1000,
          token: "USDC",
          onStale: "refresh",
          stateSnapshot: balances,
        }
      );

      expect(retry.expectedShares).toBe(875);
      expect(retry.simulationAttempts).toBe(1);
      expect(retry.configFingerprint).toBe(computeSimulationConfigFingerprint(currentConfig));
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(balances).toEqual({ usdc: 10_000n });
    });

    it("does not issue unbounded refresh requests when configuration keeps changing", async () => {
      let currentConfig: SimulationConfig = { ...baseConfig };
      const client = new ApiClient({ baseUrl: "https://api.stellaryield.io" });
      client.setSimulationConfigReader(() => currentConfig);
      const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => {
        currentConfig = {
          ...currentConfig,
          protocolFeeBps: Number(currentConfig.protocolFeeBps) + 1,
        };
        return new Response(JSON.stringify({ expectedShares: 900 }), { status: 200 });
      });

      await expect(
        client.simulateDeposit({
          strategyId: "blend-usdc-v1",
          amount: 1000,
          token: "USDC",
          onStale: "refresh",
          maxAttempts: 2,
        })
      ).rejects.toMatchObject({ attempts: 2 });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("VaultClient contract simulation context", () => {
    it("stores and surfaces immutable configuration fingerprint in VaultClient", () => {
      const clientConfigFingerprint = computeSimulationConfigFingerprint(baseConfig);
      const vault = new VaultClient({
        contractId: "CACTUSVAULTCONTRACTIDFORTESTING1234567890",
        networkPassphrase: "Test SDF Network ; September 2015",
        rpcUrl: "https://soroban-testnet.stellar.org",
        configFingerprint: clientConfigFingerprint,
      });

      expect(vault.getConfigFingerprint()).toBe(clientConfigFingerprint);
    });
  });
});
