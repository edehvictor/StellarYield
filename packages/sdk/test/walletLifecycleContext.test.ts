import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  CustomSigner,
  LifecycleContextMismatchError,
  PreparedTransaction,
  ServerKeypairSigner,
  YIELD_VAULT_SPEC_HASH,
  lookupSubmittedOperation,
  resetSubmittedOperations,
  type PreparedTransactionMeta,
} from "../src";
import {
  createFakeRpcServer,
  fakeGetNotFound,
  fakeGetSuccess,
  fakeSendPending,
} from "./fixtures/fakeRpc";

describe("Wallet lifecycle network, ledger, and version context (#1884)", () => {
  const contractId = "CCW67TSB3SSSBDGRGBXMORAX6P4CBGQLGLKXMFFBVD7OH5VO5BTV6U2M";
  const networkPassphrase = Networks.TESTNET;
  const rpcUrl = "https://soroban-testnet.stellar.org";
  const sourceKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
  const sourceAccount = new Account(sourceKeypair.publicKey(), "100");

  function createUnsignedXdr(): string {
    return new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(30)
      .build()
      .toXDR();
  }

  function meta(
    overrides: Partial<PreparedTransactionMeta<bigint>> = {}
  ): PreparedTransactionMeta<bigint> {
    return {
      simulationResult: 25n,
      footprint: "footprint",
      authEntries: [],
      minResourceFee: "1000",
      transactionData: "data",
      latestLedger: 1000,
      validUntilLedger: 1100,
      contractId,
      networkPassphrase,
      method: "deposit",
      argsHash: "{}",
      specHash: YIELD_VAULT_SPEC_HASH,
      configFingerprint: "simcfg1:0123456789abcdef",
      ...overrides,
    };
  }

  function prepare(overrides: Partial<PreparedTransactionMeta<bigint>> = {}) {
    return PreparedTransaction.fromXDR<bigint>(createUnsignedXdr(), meta(overrides));
  }

  beforeEach(() => {
    resetSubmittedOperations();
  });

  describe("normal operation", () => {
    it("binds the prepared, signed, and submitted lifecycle to one context", async () => {
      const prepared = prepare({ operationId: "normal-operation" });
      expect(prepared.context).toEqual({
        networkPassphrase,
        latestLedger: 1000,
        validUntilLedger: 1100,
        specHash: YIELD_VAULT_SPEC_HASH,
        configFingerprint: "simcfg1:0123456789abcdef",
      });

      const signed = await prepared.sign(new ServerKeypairSigner(sourceKeypair), {
        networkPassphrase,
        currentLedger: 1050,
        specHash: YIELD_VAULT_SPEC_HASH,
      });

      const fakeServer = createFakeRpcServer({
        send: fakeSendPending("normalhash"),
        pollSequence: [fakeGetSuccess(1052)],
      });

      const submitted = await signed.submit(fakeServer as any, {
        networkPassphrase,
        currentLedger: 1050,
      });
      expect(submitted.hash).toBe("normalhash");
      expect(submitted.context.networkPassphrase).toBe(networkPassphrase);
      expect(submitted.context.validUntilLedger).toBe(1100);

      const confirmed = await submitted.wait({ pollIntervalMs: 1 });
      expect(confirmed.ledger).toBe(1052);
    });
  });

  describe("failure preserves state and rejects mismatches before side effects", () => {
    it("rejects a signer on the wrong network before asking it to sign, then retries safely", async () => {
      const prepared = prepare({ operationId: "sign-network-mismatch" });
      const signSpy = vi.fn(async (xdr: string, passphrase: string) => {
        const tx = TransactionBuilder.fromXDR(xdr, passphrase);
        tx.sign(sourceKeypair);
        return tx.toXDR();
      });
      const signer = new CustomSigner(sourceKeypair.publicKey(), signSpy);

      await expect(
        prepared.sign(signer, { networkPassphrase: Networks.PUBLIC })
      ).rejects.toMatchObject({
        name: "LifecycleContextMismatchError",
        field: "network",
        phase: "sign",
        retryable: true,
        statePreserved: true,
      });
      expect(signSpy).not.toHaveBeenCalled();
      expect(prepared.operationId).toBe("sign-network-mismatch");
      expect(prepared.context.networkPassphrase).toBe(networkPassphrase);

      // Safe retry once the correct network is used.
      const signed = await prepared.sign(signer, { networkPassphrase });
      expect(signed.signedXdr).not.toBe(prepared.xdr);
      expect(signSpy).toHaveBeenCalledTimes(1);
    });

    it("rejects a submit whose RPC network does not match the prepared network", async () => {
      const prepared = prepare({ operationId: "submit-network-mismatch" });
      const signed = await prepared.sign(new ServerKeypairSigner(sourceKeypair));
      const sendSpy = vi.fn(async () => fakeSendPending("wrong-network"));
      const fakeServer = { sendTransaction: sendSpy, getTransaction: vi.fn() };

      await expect(
        signed.submit(fakeServer as any, { networkPassphrase: Networks.PUBLIC })
      ).rejects.toBeInstanceOf(LifecycleContextMismatchError);
      expect(sendSpy).not.toHaveBeenCalled();
      expect(lookupSubmittedOperation("submit-network-mismatch")).toBeUndefined();

      const retrySend = vi.fn(async () => fakeSendPending("right-network"));
      const retryServer = { sendTransaction: retrySend, getTransaction: vi.fn() };
      const submitted = await signed.submit(retryServer as any, { networkPassphrase });
      expect(submitted.hash).toBe("right-network");
      expect(retrySend).toHaveBeenCalledTimes(1);
    });

    it("rejects a contract version mismatch (spec hash or config fingerprint) before sending", async () => {
      const prepared = prepare({ operationId: "submit-version-mismatch" });
      const signed = await prepared.sign(new ServerKeypairSigner(sourceKeypair));
      const fakeServer = createFakeRpcServer({ send: fakeSendPending("should-not-send") });

      await expect(
        signed.submit(fakeServer as any, { specHash: "f".repeat(64) })
      ).rejects.toMatchObject({
        name: "LifecycleContextMismatchError",
        field: "version",
        phase: "submit",
      });

      await expect(
        signed.submit(fakeServer as any, { configFingerprint: "simcfg1:ffffffffffffffff" })
      ).rejects.toMatchObject({ field: "version" });
    });

    it("rejects a submit on a ledger outside the prepared window", async () => {
      const signed = await prepare({ operationId: "submit-ledger-window" }).sign(
        new ServerKeypairSigner(sourceKeypair)
      );
      const fakeServer = createFakeRpcServer({ send: fakeSendPending("too-late") });

      await expect(
        signed.submit(fakeServer as any, { currentLedger: 999 })
      ).rejects.toMatchObject({ field: "ledger" });

      await expect(
        signed.submit(fakeServer as any, { currentLedger: 1101 })
      ).rejects.toMatchObject({ field: "ledger" });

      // In-window submit still works.
      const submitted = await signed.submit(fakeServer as any, { currentLedger: 1100 });
      expect(submitted.hash).toBe("too-late");
    });

    it("rejects polling under a mismatched context without issuing a read", async () => {
      const signed = await prepare({ operationId: "wait-context-mismatch" }).sign(
        new ServerKeypairSigner(sourceKeypair)
      );
      const getTransaction = vi.fn();
      const submitted = await signed.submit({
        sendTransaction: async () => fakeSendPending("poll-hash"),
        getTransaction,
      } as any);

      await expect(
        submitted.wait({
          context: { networkPassphrase: Networks.PUBLIC },
          pollIntervalMs: 1,
        })
      ).rejects.toMatchObject({ field: "network", phase: "poll" });
      expect(getTransaction).not.toHaveBeenCalled();
    });
  });

  describe("safe retry after a ledger transition", () => {
    it("releases the operation identity when the ledger passes the prepared window", async () => {
      const prepared = prepare({ operationId: "ledger-transition" });
      const signed = await prepared.sign(new ServerKeypairSigner(sourceKeypair));
      const sendSpy = vi.fn(async () => fakeSendPending("late-hash"));
      const fakeServer = createFakeRpcServer({
        send: sendSpy,
        pollSequence: [{ ...fakeGetNotFound(), latestLedger: 1200 }],
      });

      const submitted = await signed.submit(fakeServer as any);
      expect(lookupSubmittedOperation("ledger-transition")).toBe("late-hash");

      await expect(submitted.wait({ pollIntervalMs: 1 })).rejects.toMatchObject({
        name: "LifecycleContextMismatchError",
        field: "ledger",
        phase: "poll",
        retryable: true,
        statePreserved: true,
      });

      // The in-flight effect never landed, so the identity is released and a
      // retry is not treated as a duplicate of an applied operation.
      expect(lookupSubmittedOperation("ledger-transition")).toBeUndefined();
      const retried = await signed.submit(fakeServer as any);
      expect(retried.hash).toBe("late-hash");
      expect(sendSpy).toHaveBeenCalledTimes(2);
    });
  });
});
