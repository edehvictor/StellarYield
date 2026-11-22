/**
 * Regression tests for hardening the SDK simulation API against insufficient
 * diagnostic context (#1858).
 *
 * Covers normal operation, validation failure before any RPC call, a simulation
 * failure with no decodable contract code or diagnostic events, a decodable
 * contract rejection, privacy of the returned diagnostics, and safe retry:
 * a failed prepare must not return a partial transaction or change any state,
 * and the same call must succeed once the simulation recovers.
 */
import { describe, expect, it, vi } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import {
  ContractExecutionError,
  InvalidAmountError,
  SimulationDiagnosticsError,
  VaultClient,
} from "../src";
import {
  areSimulationDiagnosticsPrivacySafe,
  buildSimulationFailureDiagnostics,
  hasSufficientDiagnosticContext,
  redactSimulationDiagnosticText,
} from "../src/simulationDiagnostics";
import { createDepositSimulation } from "./fixtures/depositSimulation";

const CONTRACT_ID = "CCW67TSB3SSSBDGRGBXMORAX6P4CBGQLGLKXMFFBVD7OH5VO5BTV6U2M";
const PASSPHRASE = Networks.TESTNET;
const RPC_URL = "https://soroban-testnet.stellar.org";
const CALLER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const RAW_XDR = "deadbeefcafebabe00112233445566778899aabbccddeeff0011223344556677";

function createClient(): VaultClient {
  return new VaultClient({
    contractId: CONTRACT_ID,
    networkPassphrase: PASSPHRASE,
    rpcUrl: RPC_URL,
  });
}

/** A successful generated-client response for `deposit`, with fresh XDR data. */
function successfulDeposit(shares = 10_000_000n) {
  return {
    simulation: createDepositSimulation(),
    result: { unwrap: () => shares },
    built: undefined,
  };
}

describe("SDK simulation diagnostics (#1858)", () => {
  describe("normal operation", () => {
    it("prepares a deposit without warning diagnostics", async () => {
      const client = createClient();
      const deposit = vi.fn(async () => successfulDeposit(5_000_000n));
      (client as any).generatedClient.deposit = deposit;

      const prepared = await client.deposit({
        from: CALLER,
        amount: 10_000_000n,
        min_shares_out: 4_950_000n,
      });

      expect(deposit).toHaveBeenCalledTimes(1);
      expect(prepared.state).toBe("SIMULATED");
      expect(prepared.meta.simulationResult).toBe(5_000_000n);
      expect(prepared.meta.method).toBe("deposit");
      expect(prepared.meta.latestLedger).toBe(1000);
    });
  });

  describe("validation failure", () => {
    it("rejects an imprecise amount before building any transaction", async () => {
      const client = createClient();
      const deposit = vi.fn(async () => successfulDeposit());
      (client as any).generatedClient.deposit = deposit;

      let caught: unknown;
      try {
        await client.deposit({ from: CALLER, amount: 1.5 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidAmountError);
      expect(deposit).not.toHaveBeenCalled();

      const invalidAmount = caught as InvalidAmountError;
      expect(invalidAmount.phase).toBe("simulate");
      expect(invalidAmount.diagnostics?.map((d) => d.code)).toEqual([
        "VALIDATION_FAILED",
        "STATE_PRESERVED",
      ]);
      expect(invalidAmount.diagnostics?.[0].stage).toBe("input-validation");
      expect(invalidAmount.diagnostics?.[1].affectedStages).toEqual([
        "input-validation",
      ]);
      expect(areSimulationDiagnosticsPrivacySafe(invalidAmount.diagnostics ?? [])).toBe(
        true
      );
    });
  });

  describe("insufficient diagnostic context", () => {
    it("names the simulation stage without echoing raw error text", async () => {
      const client = createClient();
      const leakyError = new Error(
        `upstream RPC ${RPC_URL} failed for ${CALLER} xdr ${RAW_XDR}\n    at Object.<anonymous> (/srv/app/src/rpc.ts:42:7)`
      );
      (client as any).generatedClient.deposit = async () => {
        throw leakyError;
      };

      let caught: unknown;
      try {
        await client.deposit({ from: CALLER, amount: 10_000_000n });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SimulationDiagnosticsError);
      const failure = caught as SimulationDiagnosticsError;
      expect(failure.name).toBe("SimulationDiagnosticsError");
      expect(failure.phase).toBe("simulate");
      expect(failure.retryable).toBe(true);
      expect(failure.method).toBe("deposit");
      expect(failure.stage).toBe("simulation");
      expect(failure.diagnostics.map((d) => d.code)).toEqual([
        "CONTEXT_INSUFFICIENT",
        "STATE_PRESERVED",
      ]);
      expect(failure.diagnostics[1].stage).toBe("state-persistence");
      expect(failure.diagnostics[1].affectedStages).toEqual(["simulation"]);
      expect(failure.context).toEqual({
        diagnosticEventCount: 0,
        hasErrorMessage: true,
      });
      expect(areSimulationDiagnosticsPrivacySafe(failure.diagnostics)).toBe(true);

      const serialized = JSON.stringify({
        message: failure.message,
        remediation: failure.remediation,
        diagnostics: failure.diagnostics,
        context: failure.context,
      });
      expect(serialized).not.toContain(RPC_URL);
      expect(serialized).not.toContain("rpc.internal");
      expect(serialized).not.toContain(CALLER);
      expect(serialized).not.toContain(RAW_XDR);
      expect(serialized).not.toContain("at Object");
      expect(serialized).not.toContain("/srv/app");
    });

    it("classifies a failed simulation response returned instead of thrown", async () => {
      const client = createClient();
      (client as any).generatedClient.deposit = async () => ({
        simulation: {
          _parsed: true,
          id: "failed-simulation",
          latestLedger: 1000,
          error: "Error(Contract, #7)",
          events: [],
        },
      });

      await expect(
        client.deposit({ from: CALLER, amount: 10_000_000n })
      ).rejects.toMatchObject({
        name: "ContractExecutionError",
        errorCode: 7,
        phase: "simulate",
        diagnostics: [
          { code: "SIMULATION_FAILED", stage: "simulation" },
          { code: "STATE_PRESERVED", stage: "state-persistence" },
        ],
      });
    });

    it("treats diagnostic events as sufficient context even without a contract code", async () => {
      expect(
        hasSufficientDiagnosticContext({
          diagnosticEventCount: 1,
          contractErrorCode: undefined,
        })
      ).toBe(true);
      expect(
        hasSufficientDiagnosticContext({
          diagnosticEventCount: 0,
          contractErrorCode: undefined,
        })
      ).toBe(false);
    });

    it("redacts URLs, addresses, hashes, and stack frames from free-form text", () => {
      const redacted = redactSimulationDiagnosticText(
        `failed ${RPC_URL} for ${CALLER} hash ${RAW_XDR}\n at Object.<anonymous> (/srv/app/x.ts:1:2)`
      );
      expect(redacted).not.toContain(RPC_URL);
      expect(redacted).not.toContain(CALLER);
      expect(redacted).not.toContain(RAW_XDR);
      expect(redacted).not.toContain("at Object");
      expect(redacted).toContain("[redacted-url]");
      expect(redacted).toContain("[redacted-address]");
    });
  });

  describe("decodable contract rejection", () => {
    it("keeps the typed contract error and attaches privacy-safe diagnostics", async () => {
      const client = createClient();
      (client as any).generatedClient.deposit = async () => {
        throw new Error("Error(Contract, #7)");
      };

      let caught: unknown;
      try {
        await client.deposit({ from: CALLER, amount: 10_000_000n });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ContractExecutionError);
      const failure = caught as ContractExecutionError;
      expect(failure.errorCode).toBe(7);
      expect(failure.errorName).toBe("Paused");
      expect(failure.retryable).toBe(false);
      expect(failure.diagnostics?.map((d) => d.code)).toEqual([
        "SIMULATION_FAILED",
        "STATE_PRESERVED",
      ]);
      expect(areSimulationDiagnosticsPrivacySafe(failure.diagnostics ?? [])).toBe(
        true
      );
    });

    it("does not attach diagnostics twice when a normalized failure is rethrown", () => {
      const diagnostics = buildSimulationFailureDiagnostics("CONTEXT_INSUFFICIENT", {
        stage: "simulation",
      });
      const error = new SimulationDiagnosticsError(diagnostics, {
        method: "deposit",
        context: { diagnosticEventCount: 0, hasErrorMessage: true },
      });
      expect(error.diagnostics).toBe(diagnostics);
      expect(error.remediation).toBe(diagnostics[0].remediation);
    });
  });

  describe("safe retry", () => {
    it("leaves balances and state untouched on failure and succeeds on retry", async () => {
      const client = createClient();
      let simulatedReserve = 40_000_000n;
      let call = 0;

      (client as any).generatedClient.deposit = async () => {
        call += 1;
        if (call === 1) {
          // Simulate a transient RPC outage with no diagnostic events.
          throw new Error("fetch failed: connection reset");
        }
        simulatedReserve += 10_000_000n;
        return successfulDeposit(5_000_000n);
      };

      const failed = await client
        .deposit({ from: CALLER, amount: 10_000_000n, min_shares_out: 4_950_000n })
        .then(
          () => null,
          (error) => error
        );

      expect(failed).toBeInstanceOf(SimulationDiagnosticsError);
      expect(failed.retryable).toBe(true);
      // Failure returned no transaction, signed nothing, and changed no balance.
      expect(simulatedReserve).toBe(40_000_000n);

      const retried = await client.deposit({
        from: CALLER,
        amount: 10_000_000n,
        min_shares_out: 4_950_000n,
      });

      expect(call).toBe(2);
      expect(simulatedReserve).toBe(50_000_000n);
      expect(retried.state).toBe("SIMULATED");
      expect(retried.meta.simulationResult).toBe(5_000_000n);
    });

    it("accepts a corrected amount after a validation failure", async () => {
      const client = createClient();
      (client as any).generatedClient.deposit = async () => successfulDeposit(1_000_000n);

      await expect(
        client.deposit({ from: CALLER, amount: Number.MAX_SAFE_INTEGER + 1 })
      ).rejects.toBeInstanceOf(InvalidAmountError);

      const retried = await client.deposit({ from: CALLER, amount: 1_000_000n });
      expect(retried.meta.simulationResult).toBe(1_000_000n);
    });
  });
});
