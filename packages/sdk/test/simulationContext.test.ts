/**
 * Regression tests for network / ledger / version binding of the SDK
 * simulation API (#1857).
 *
 * Covers:
 * - normal operation: binding, comparison, and context-bound runs succeed;
 * - failure: network, passphrase, contract, version, and ledger transitions
 *   are rejected with a typed SimulationContextMismatchError, before any
 *   signer / RPC call, and without mutating caller state;
 * - safe retry: retryable ledger transitions re-run under `refresh` within a
 *   bounded attempt budget, identity transitions never retry, and a rejected
 *   sign/submit can be retried once the caller's context is corrected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  NETWORK_PASSPHRASES,
  PreparedTransaction,
  ServerKeypairSigner,
  SimulationContextMismatchError,
  UnsupportedNetworkError,
  VaultClient,
  YIELD_VAULT_SPEC_HASH,
  assertPreparedTransactionContext,
  assertSimulationContext,
  bindSimulationContext,
  compareSimulationContext,
  isSimulationContextMismatchError,
  lookupSubmittedOperation,
  resetSubmittedOperations,
  runWithSimulationContext,
  simulationContextMatches,
  toSimulationError,
  type PreparedTransactionMeta,
  type SimulationContextInput,
} from "../src";
import { createFakeRpcServer, fakeGetSuccess, fakeSendPending } from "./fixtures/fakeRpc";
import { createDepositSimulation } from "./fixtures/depositSimulation";

const CONTRACT_ID = "CCW67TSB3SSSBDGRGBXMORAX6P4CBGQLGLKXMFFBVD7OH5VO5BTV6U2M";
const OTHER_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const RPC_URL = "https://soroban-testnet.stellar.org";
const CALLER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const sourceKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const signer = new ServerKeypairSigner(sourceKeypair);

const TESTNET_CONTEXT: SimulationContextInput = {
  network: "testnet",
  networkPassphrase: Networks.TESTNET,
  contractId: CONTRACT_ID,
  contractVersion: YIELD_VAULT_SPEC_HASH,
  ledger: 1000,
};

function unsignedXdr(sequence = "100"): string {
  const account = new Account(sourceKeypair.publicKey(), sequence);
  return new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.payment({ destination: CALLER, asset: Asset.native(), amount: "1" })
    )
    .setTimeout(30)
    .build()
    .toXDR();
}

function preparedMeta(
  overrides: Partial<PreparedTransactionMeta<bigint>> = {}
): PreparedTransactionMeta<bigint> {
  return {
    simulationResult: 5_000_000n,
    footprint: "",
    authEntries: [],
    minResourceFee: "1200",
    transactionData: "",
    latestLedger: 1000,
    validUntilLedger: 1100,
    contractId: CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    method: "deposit",
    argsHash: "{}",
    specHash: YIELD_VAULT_SPEC_HASH,
    network: "testnet",
    ...overrides,
  };
}

beforeEach(() => {
  resetSubmittedOperations();
});

describe("SDK simulation context binding (#1857)", () => {
  describe("bindSimulationContext", () => {
    it("normalizes and deep-freezes a valid context", () => {
      const input = { ...TESTNET_CONTEXT };
      const bound = bindSimulationContext(input);

      expect(bound).toEqual(TESTNET_CONTEXT);
      expect(Object.isFrozen(bound)).toBe(true);
      // The caller's object is copied, not frozen in place.
      expect(Object.isFrozen(input)).toBe(false);
      input.ledger = 5;
      expect(bound.ledger).toBe(1000);
    });

    it("accepts any passphrase for the local network", () => {
      expect(() =>
        bindSimulationContext({ network: "local", networkPassphrase: "Standalone Network ; February 2017" })
      ).not.toThrow();
    });

    it("rejects an unsupported network id", () => {
      expect(() => bindSimulationContext({ network: "futurenet" })).toThrow(UnsupportedNetworkError);
    });

    it("rejects a passphrase that belongs to a different network", () => {
      const error = captureError(() =>
        bindSimulationContext({ network: "mainnet", networkPassphrase: Networks.TESTNET })
      );
      expect(error).toBeInstanceOf(SimulationContextMismatchError);
      expect(error).toMatchObject({
        field: "networkPassphrase",
        reason: "invalid",
        expected: NETWORK_PASSPHRASES.mainnet,
        actual: Networks.TESTNET,
        retryable: false,
        statePreserved: true,
      });
    });

    it.each([
      ["negative ledger", { ledger: -1 }],
      ["fractional ledger", { ledger: 1.5 }],
      ["NaN ledger", { ledger: Number.NaN }],
      ["empty contract id", { contractId: "  " }],
      ["empty version", { contractVersion: "" }],
    ])("rejects a %s as invalid and non-retryable", (_label, input) => {
      const error = captureError(() => bindSimulationContext(input as SimulationContextInput));
      expect(isSimulationContextMismatchError(error)).toBe(true);
      expect(error).toMatchObject({ reason: "invalid", retryable: false });
    });

    it("rejects a non-object context", () => {
      expect(() => bindSimulationContext(null as never)).toThrow(SimulationContextMismatchError);
    });
  });

  describe("compareSimulationContext", () => {
    const bound = bindSimulationContext(TESTNET_CONTEXT);

    it("matches the same context and an advancing ledger", () => {
      expect(compareSimulationContext(bound, bound)).toBeNull();
      expect(
        compareSimulationContext(bound, bindSimulationContext({ ...TESTNET_CONTEXT, ledger: 1050 }))
      ).toBeNull();
      expect(simulationContextMatches(TESTNET_CONTEXT, { ...TESTNET_CONTEXT, ledger: 1001 })).toBe(true);
    });

    it("only binds fields present on the expected context", () => {
      expect(
        compareSimulationContext(bindSimulationContext({ contractId: CONTRACT_ID }), bound)
      ).toBeNull();
    });

    it.each([
      ["network", { network: "mainnet", networkPassphrase: Networks.PUBLIC }],
      ["networkPassphrase", { network: undefined, networkPassphrase: Networks.PUBLIC }],
      ["contractId", { contractId: OTHER_CONTRACT_ID }],
      ["contractVersion", { contractVersion: "deadbeef" }],
    ])("reports a non-retryable %s mismatch", (field, patch) => {
      const expected =
        field === "networkPassphrase" ? bindSimulationContext({ ...TESTNET_CONTEXT, network: undefined }) : bound;
      const mismatch = compareSimulationContext(
        expected,
        bindSimulationContext({ ...TESTNET_CONTEXT, ...patch } as SimulationContextInput)
      );
      expect(mismatch).toMatchObject({ field, reason: "mismatch", retryable: false });
    });

    it("reports a bound field the live context cannot confirm as missing", () => {
      const mismatch = compareSimulationContext(
        bound,
        bindSimulationContext({ ...TESTNET_CONTEXT, contractVersion: undefined })
      );
      expect(mismatch).toMatchObject({ field: "contractVersion", reason: "missing", retryable: false });
    });

    it("reports a ledger regression as retryable", () => {
      const mismatch = compareSimulationContext(
        bound,
        bindSimulationContext({ ...TESTNET_CONTEXT, ledger: 999 })
      );
      expect(mismatch).toMatchObject({
        field: "ledger",
        reason: "ledger-regressed",
        expected: 1000,
        actual: 999,
        retryable: true,
      });
    });

    it("reports expiry past validUntilLedger and excessive drift", () => {
      const later = bindSimulationContext({ ...TESTNET_CONTEXT, ledger: 1101 });
      expect(compareSimulationContext(bound, later, { validUntilLedger: 1100 })).toMatchObject({
        reason: "ledger-expired",
        expected: 1100,
        actual: 1101,
      });
      expect(compareSimulationContext(bound, later, { maxLedgerDrift: 100 })).toMatchObject({
        reason: "ledger-expired",
        retryable: true,
      });
      expect(compareSimulationContext(bound, later, { maxLedgerDrift: 101 })).toBeNull();
    });
  });

  describe("assertSimulationContext", () => {
    it("passes for a matching context", () => {
      expect(() => assertSimulationContext(TESTNET_CONTEXT, { ...TESTNET_CONTEXT, ledger: 1001 })).not.toThrow();
    });

    it("throws with the caller's state snapshot echoed back unchanged", () => {
      const balances = { USDC: 1_000n, shares: 42n };
      const error = captureError(() =>
        assertSimulationContext(
          TESTNET_CONTEXT,
          { ...TESTNET_CONTEXT, contractId: OTHER_CONTRACT_ID },
          { stateSnapshot: balances, phase: "submit" }
        )
      );
      expect(error).toBeInstanceOf(SimulationContextMismatchError);
      expect(error).toMatchObject({
        field: "contractId",
        phase: "submit",
        statePreserved: true,
        preservedState: balances,
      });
      expect(balances).toEqual({ USDC: 1_000n, shares: 42n });
    });

    it("rejects malformed drift options", () => {
      expect(() =>
        assertSimulationContext(TESTNET_CONTEXT, TESTNET_CONTEXT, { maxLedgerDrift: -5 })
      ).toThrow(SimulationContextMismatchError);
    });

    it("keeps its class through toSimulationError", () => {
      const error = captureError(() =>
        assertSimulationContext(TESTNET_CONTEXT, { ...TESTNET_CONTEXT, network: "local" })
      );
      expect(toSimulationError(error)).toBe(error);
    });
  });

  describe("runWithSimulationContext", () => {
    it("runs under the captured context and returns it with the result", async () => {
      const run = vi.fn(async (ctx) => `quote@${ctx.ledger}`);
      const outcome = await runWithSimulationContext({
        readContext: () => TESTNET_CONTEXT,
        expected: { network: "testnet", contractId: CONTRACT_ID },
        run,
      });

      expect(outcome.result).toBe("quote@1000");
      expect(outcome.attempts).toBe(1);
      expect(outcome.context).toEqual(TESTNET_CONTEXT);
      expect(Object.isFrozen(outcome.context)).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("rejects an identity mismatch before running any work", async () => {
      const run = vi.fn();
      const state = { balance: 100n };
      const error = await captureAsyncError(() =>
        runWithSimulationContext({
          readContext: () => ({ ...TESTNET_CONTEXT, network: "mainnet", networkPassphrase: Networks.PUBLIC }),
          expected: { network: "testnet" },
          stateSnapshot: state,
          onTransition: "refresh",
          run,
        })
      );

      expect(error).toMatchObject({ field: "network", reason: "mismatch", retryable: false, attempts: 1 });
      expect((error as SimulationContextMismatchError).preservedState).toEqual(state);
      expect(run).not.toHaveBeenCalled();
      expect(state).toEqual({ balance: 100n });
    });

    it("rejects a network switch while the simulation is in flight", async () => {
      const contexts = [
        TESTNET_CONTEXT,
        { ...TESTNET_CONTEXT, network: "local", networkPassphrase: "Standalone Network ; February 2017" },
      ];
      let reads = 0;
      const error = await captureAsyncError(() =>
        runWithSimulationContext({
          readContext: () => contexts[Math.min(reads++, contexts.length - 1)],
          onTransition: "refresh",
          run: async () => "stale quote",
        })
      );

      expect(error).toMatchObject({ field: "network", reason: "mismatch", retryable: false });
      // Identity transitions are never retried, even under `refresh`.
      expect(reads).toBe(2);
    });

    it("rejects a ledger regression under the default reject policy", async () => {
      const ledgers = [1000, 990];
      let reads = 0;
      const run = vi.fn(async () => "quote");
      const error = await captureAsyncError(() =>
        runWithSimulationContext({
          readContext: () => ({ ...TESTNET_CONTEXT, ledger: ledgers[reads++] }),
          run,
        })
      );

      expect(error).toMatchObject({ reason: "ledger-regressed", retryable: true, attempts: 1 });
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("re-runs a retryable ledger transition under refresh and reports the refresh", async () => {
      // attempt 1: 1000 -> 990 (regressed), attempt 2: 1001 -> 1002 (ok)
      const ledgers = [1000, 990, 1001, 1002];
      let reads = 0;
      const onRefresh = vi.fn();
      const outcome = await runWithSimulationContext({
        readContext: () => ({ ...TESTNET_CONTEXT, ledger: ledgers[reads++] }),
        run: async (ctx) => ctx.ledger,
        onTransition: "refresh",
        onRefresh,
      });

      expect(outcome).toMatchObject({ result: 1001, attempts: 2 });
      expect(outcome.observedContext.ledger).toBe(1002);
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(onRefresh.mock.calls[0][0]).toMatchObject({ field: "ledger", attempt: 1 });
    });

    it("bounds refresh retries and exposes the attempt count on exhaustion", async () => {
      let ledger = 2000;
      const run = vi.fn(async () => "quote");
      const error = await captureAsyncError(() =>
        runWithSimulationContext({
          // Each read advances the ledger by 25, exceeding maxLedgerDrift per run.
          readContext: () => ({ ...TESTNET_CONTEXT, ledger: (ledger += 25) }),
          maxLedgerDrift: 10,
          onTransition: "refresh",
          maxAttempts: 3,
          run,
        })
      );

      expect(error).toMatchObject({ reason: "ledger-expired", attempts: 3 });
      expect(run).toHaveBeenCalledTimes(3);
    });

    it("clamps an unreasonable maxAttempts", async () => {
      let ledger = 0;
      const run = vi.fn(async () => "quote");
      await captureAsyncError(() =>
        runWithSimulationContext({
          readContext: () => ({ ledger: (ledger += 100) }),
          maxLedgerDrift: 1,
          onTransition: "refresh",
          maxAttempts: 1_000,
          run,
        })
      );
      expect(run).toHaveBeenCalledTimes(10);
    });

    it("propagates errors from the simulation without retrying and leaves state intact", async () => {
      const state = { balance: 5n };
      const failure = new Error("rpc down");
      const run = vi.fn(async () => {
        throw failure;
      });
      await expect(
        runWithSimulationContext({
          readContext: () => TESTNET_CONTEXT,
          stateSnapshot: state,
          onTransition: "refresh",
          run,
        })
      ).rejects.toBe(failure);
      expect(run).toHaveBeenCalledTimes(1);
      expect(state).toEqual({ balance: 5n });
    });
  });

  describe("prepared transaction binding", () => {
    it("records the network on prepared transactions from a network-aware VaultClient", async () => {
      const client = new VaultClient({
        contractId: CONTRACT_ID,
        networkPassphrase: Networks.TESTNET,
        rpcUrl: RPC_URL,
        network: "testnet",
      });
      (client as any).generatedClient.deposit = async () => ({
        simulation: createDepositSimulation(),
        result: { unwrap: () => 5_000_000n },
        built: undefined,
      });

      const prepared = await client.deposit({ from: CALLER, amount: 10_000_000n });
      expect(prepared.meta.network).toBe("testnet");
      expect(client.getSimulationContext()).toEqual({
        network: "testnet",
        networkPassphrase: Networks.TESTNET,
        contractId: CONTRACT_ID,
        contractVersion: YIELD_VAULT_SPEC_HASH,
      });
      expect(() => prepared.assertContext(client.getSimulationContext())).not.toThrow();
      expect(() =>
        prepared.assertContext({ ...client.getSimulationContext(), contractId: OTHER_CONTRACT_ID })
      ).toThrow(SimulationContextMismatchError);
    });

    it("omits network for VaultClients configured without one (backwards compatible)", async () => {
      const client = new VaultClient({ contractId: CONTRACT_ID, networkPassphrase: Networks.TESTNET, rpcUrl: RPC_URL });
      expect(client.network).toBeUndefined();
      expect(client.getSimulationContext().network).toBeUndefined();
    });

    it("refuses to construct a VaultClient whose network and passphrase disagree", () => {
      expect(
        () =>
          new VaultClient({
            contractId: CONTRACT_ID,
            networkPassphrase: Networks.TESTNET,
            rpcUrl: RPC_URL,
            network: "mainnet",
          })
      ).toThrow(SimulationContextMismatchError);
    });

    it("rejects a current ledger outside the validity window", () => {
      const meta = preparedMeta();
      expect(() => assertPreparedTransactionContext(meta, { ledger: 1050 })).not.toThrow();
      expect(captureError(() => assertPreparedTransactionContext(meta, { ledger: 999 }))).toMatchObject({
        reason: "ledger-regressed",
        phase: "sign",
      });
      expect(captureError(() => assertPreparedTransactionContext(meta, { ledger: 1101 }))).toMatchObject({
        reason: "ledger-expired",
        retryable: true,
      });
    });

    it("reports a pinned network missing from legacy metadata", () => {
      const error = captureError(() =>
        assertPreparedTransactionContext(preparedMeta({ network: undefined }), { network: "testnet" })
      );
      expect(error).toMatchObject({ field: "network", reason: "missing", retryable: false });
    });

    it("rejects signing for another network without invoking the signer", async () => {
      const prepared = PreparedTransaction.fromXDR<bigint>(unsignedXdr(), preparedMeta());
      const spy = vi.spyOn(signer, "signTransaction");

      const error = await captureAsyncError(() =>
        prepared.sign(signer, {
          expectedContext: { network: "mainnet", networkPassphrase: Networks.PUBLIC },
        })
      );

      expect(error).toMatchObject({ field: "network", reason: "mismatch", phase: "sign" });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("rejects an expired submit without touching the RPC or duplicate registry, then retries safely", async () => {
      const prepared = PreparedTransaction.fromXDR<bigint>(
        unsignedXdr(),
        preparedMeta({ operationId: "op-1857" })
      );
      const signed = await prepared.sign(signer, {
        expectedContext: { ...TESTNET_CONTEXT, ledger: 1010 },
      });

      const send = vi.fn(() => fakeSendPending("hash-1857"));
      const server = createFakeRpcServer({ send, pollSequence: [fakeGetSuccess(1020)] });

      const error = await captureAsyncError(() =>
        signed.submit(server as any, { expectedContext: { ...TESTNET_CONTEXT, ledger: 1200 } })
      );
      expect(error).toMatchObject({ reason: "ledger-expired", phase: "submit", retryable: true });
      expect(send).not.toHaveBeenCalled();
      expect(lookupSubmittedOperation("op-1857")).toBeUndefined();

      // Corrected context (e.g. after re-reading a healthy RPC node) is accepted.
      const submitted = await signed.submit(server as any, {
        expectedContext: { ...TESTNET_CONTEXT, ledger: 1020 },
      });
      expect(submitted.hash).toBe("hash-1857");
      expect(send).toHaveBeenCalledTimes(1);
      expect(lookupSubmittedOperation("op-1857")).toBe("hash-1857");
    });

    it("keeps sign/submit unchanged when no expected context is supplied", async () => {
      const prepared = PreparedTransaction.fromXDR<bigint>(unsignedXdr(), preparedMeta({ network: undefined }));
      const signed = await prepared.sign(signer);
      const submitted = await signed.submit(
        createFakeRpcServer({ send: fakeSendPending("hash-legacy") }) as any
      );
      expect(submitted.hash).toBe("hash-legacy");
    });
  });
});

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

async function captureAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}
