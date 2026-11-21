/**
 * Regression tests for duplicate-submission hardening (#1853).
 *
 * Covers normal operation, failure before/at submission, and safe retry:
 * - the same idempotency key and arguments produce one operation identity;
 * - a retried submit reuses the first transaction hash instead of applying the
 *   effect twice;
 * - a submission that never reached the network is not remembered;
 * - a FAILED transaction clears its identity so a corrected retry may submit;
 * - validation failures never build, sign, or submit anything.
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
  PreparedTransaction,
  ServerKeypairSigner,
  SubmissionTimeoutError,
  VaultClient,
  createOperationId,
  lookupSubmittedOperation,
  resetSubmittedOperations,
  type PreparedTransactionMeta,
} from "../src";
import {
  createFakeRpcServer,
  fakeGetFailed,
  fakeGetNotFound,
  fakeGetSuccess,
  fakeSendError,
  fakeSendPending,
} from "./fixtures/fakeRpc";
import { createDepositSimulation } from "./fixtures/depositSimulation";

const CONTRACT_ID = "CCW67TSB3SSSBDGRGBXMORAX6P4CBGQLGLKXMFFBVD7OH5VO5BTV6U2M";
const PASSPHRASE = Networks.TESTNET;
const RPC_URL = "https://soroban-testnet.stellar.org";
const CALLER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const sourceKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4));
const signer = new ServerKeypairSigner(sourceKeypair);

function createClient(): VaultClient {
  return new VaultClient({
    contractId: CONTRACT_ID,
    networkPassphrase: PASSPHRASE,
    rpcUrl: RPC_URL,
  });
}

function successfulDeposit(shares = 5_000_000n) {
  return {
    simulation: createDepositSimulation(),
    result: { unwrap: () => shares },
    built: undefined,
  };
}

function unsignedXdr(sequence: string): string {
  const account = new Account(sourceKeypair.publicKey(), sequence);
  return new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: CALLER,
        asset: Asset.native(),
        amount: "1",
      })
    )
    .setTimeout(30)
    .build()
    .toXDR();
}

function preparedMeta(operationId?: string): PreparedTransactionMeta<bigint> {
  return {
    simulationResult: 5_000_000n,
    footprint: "",
    authEntries: [],
    minResourceFee: "1200",
    transactionData: "",
    latestLedger: 1000,
    validUntilLedger: 1100,
    contractId: CONTRACT_ID,
    networkPassphrase: PASSPHRASE,
    method: "deposit",
    argsHash: "{}",
    ...(operationId ? { operationId } : {}),
  };
}

async function signedDeposit(sequence: string, operationId?: string) {
  const prepared = PreparedTransaction.fromXDR<bigint>(
    unsignedXdr(sequence),
    preparedMeta(operationId)
  );
  return prepared.sign(signer);
}

beforeEach(() => {
  resetSubmittedOperations();
});

describe("SDK duplicate submission guard (#1853)", () => {
  describe("normal operation", () => {
    it("derives one identity for retries with the same key and arguments", async () => {
      const client = createClient();
      (client as any).generatedClient.deposit = async () => successfulDeposit();

      const first = await client.deposit({
        from: CALLER,
        amount: 10_000_000n,
        idempotencyKey: "deposit-retry-1",
      });
      const retry = await client.deposit({
        from: CALLER,
        amount: 10_000_000n,
        idempotencyKey: "deposit-retry-1",
      });
      const differentAmount = await client.deposit({
        from: CALLER,
        amount: 10_000_001n,
        idempotencyKey: "deposit-retry-1",
      });
      const differentKey = await client.deposit({
        from: CALLER,
        amount: 10_000_000n,
        idempotencyKey: "deposit-retry-2",
      });

      expect(first.operationId).toBeTruthy();
      expect(first.operationId).toBe(retry.operationId);
      expect(first.meta.idempotencyKey).toBe("deposit-retry-1");
      expect(differentAmount.operationId).not.toBe(first.operationId);
      expect(differentKey.operationId).not.toBe(first.operationId);
    });

    it("keeps operation identities distinct when no key is supplied", async () => {
      const client = createClient();
      (client as any).generatedClient.deposit = async () => successfulDeposit();

      const first = await client.deposit({ from: CALLER, amount: 10_000_000n });
      const second = await client.deposit({ from: CALLER, amount: 10_000_000n });

      expect(first.operationId).toBeTruthy();
      expect(second.operationId).toBeTruthy();
      expect(first.operationId).not.toBe(second.operationId);
    });

    it("submits once and reuses the hash for repeated submit calls", async () => {
      const server = createFakeRpcServer({
        send: fakeSendPending("hash-once"),
        pollSequence: [fakeGetSuccess(500)],
      });
      const signed = await signedDeposit("100", "op-normal");

      const first = await signed.submit(server as any);
      const second = await signed.submit(server as any);

      expect(first.hash).toBe("hash-once");
      expect(first.deduplicated).toBe(false);
      expect(second.hash).toBe("hash-once");
      expect(second.deduplicated).toBe(true);
      expect(lookupSubmittedOperation("op-normal")).toBe("hash-once");

      const confirmed = await second.wait({ pollIntervalMs: 1 });
      expect(confirmed.ledger).toBe(500);
    });

    it("suppresses a separately rebuilt transaction with the same identity", async () => {
      const first = await signedDeposit("100", "op-shared");
      const retry = await signedDeposit("101", "op-shared");
      expect(first.toXDR()).not.toBe(retry.toXDR());

      const server = createFakeRpcServer({
        send: fakeSendPending("hash-shared"),
        pollSequence: [fakeGetSuccess(700)],
      });

      const submitted = await first.submit(server as any);
      const retried = await retry.submit(server as any);

      expect(submitted.hash).toBe("hash-shared");
      expect(retried.hash).toBe("hash-shared");
      expect(retried.deduplicated).toBe(true);
      expect(server.pollCallCount).toBe(0);
      await expect(retried.wait({ pollIntervalMs: 1 })).resolves.toMatchObject({
        ledger: 700,
      });
    });
  });

  describe("failures", () => {
    it("does not remember an operation when the network request fails", async () => {
      const operationId = "op-transport-failure";
      const signed = await signedDeposit("200", operationId);
      let sendCalls = 0;

      const offlineServer = {
        async sendTransaction() {
          sendCalls += 1;
          throw new Error("offline: connection reset");
        },
        async getTransaction() {
          return fakeGetNotFound();
        },
      };

      await expect(signed.submit(offlineServer as any)).rejects.toThrow("offline");
      expect(sendCalls).toBe(1);
      expect(lookupSubmittedOperation(operationId)).toBeUndefined();

      // Safe retry: the first attempt produced no effect, so it may submit.
      const retryServer = createFakeRpcServer({
        send: fakeSendPending("hash-after-retry"),
        pollSequence: [fakeGetSuccess(800)],
      });
      const retried = await signed.submit(retryServer as any);

      expect(retried.hash).toBe("hash-after-retry");
      expect(retried.deduplicated).toBe(false);
      expect(lookupSubmittedOperation(operationId)).toBe("hash-after-retry");
    });

    it("does not remember a submission rejected with an RPC ERROR", async () => {
      const operationId = "op-rpc-error";
      const signed = await signedDeposit("300", operationId);
      const errorServer = createFakeRpcServer({ send: fakeSendError("rejected") });

      await expect(signed.submit(errorServer as any)).rejects.toThrow();
      expect(lookupSubmittedOperation(operationId)).toBeUndefined();
    });

    it("rejects an invalid amount without building, signing, or submitting", async () => {
      const client = createClient();
      const deposit = vi.fn(async () => successfulDeposit());
      (client as any).generatedClient.deposit = deposit;

      await expect(
        client.deposit({ from: CALLER, amount: 1.5, idempotencyKey: "op-invalid" })
      ).rejects.toThrow();

      expect(deposit).not.toHaveBeenCalled();
    });
  });

  describe("safe retry", () => {
    it("keeps the guard while a submitted transaction may still land", async () => {
      const operationId = "op-timeout";
      const signed = await signedDeposit("400", operationId);
      let sendCalls = 0;
      const server = {
        async sendTransaction() {
          sendCalls += 1;
          return fakeSendPending("hash-pending");
        },
        async getTransaction() {
          return fakeGetNotFound();
        },
      };

      const submitted = await signed.submit(server as any);
      await expect(
        submitted.wait({ timeoutMs: 10, pollIntervalMs: 2 })
      ).rejects.toBeInstanceOf(SubmissionTimeoutError);

      // The transaction may still be included, so a retry must not send again.
      const retried = await signed.submit(server as any);
      expect(sendCalls).toBe(1);
      expect(retried.hash).toBe(submitted.hash);
      expect(retried.deduplicated).toBe(true);
    });

    it("clears the identity after a FAILED ledger transaction", async () => {
      const operationId = "op-failed";
      const signed = await signedDeposit("500", operationId);
      const failedServer = createFakeRpcServer({
        send: fakeSendPending("hash-failed"),
        pollSequence: [fakeGetFailed(900)],
      });

      const submitted = await signed.submit(failedServer as any);
      await expect(submitted.wait({ pollIntervalMs: 1 })).rejects.toMatchObject({
        phase: "poll",
        retryable: false,
      });
      expect(lookupSubmittedOperation(operationId)).toBeUndefined();

      // A corrected retry may submit under the same identity.
      const retryServer = createFakeRpcServer({
        send: fakeSendPending("hash-corrected"),
        pollSequence: [fakeGetSuccess(901)],
      });
      const retried = await signed.submit(retryServer as any);
      expect(retried.hash).toBe("hash-corrected");
      expect(retried.deduplicated).toBe(false);
    });
  });
});

describe("createOperationId", () => {
  const base = {
    contractId: CONTRACT_ID,
    networkPassphrase: PASSPHRASE,
    method: "deposit",
    argsHash: '{"amount":"1"}',
  };

  it("is deterministic with an idempotency key and stable across runs", () => {
    const first = createOperationId({ ...base, idempotencyKey: "key-a" });
    const second = createOperationId({ ...base, idempotencyKey: "key-a" });
    const other = createOperationId({ ...base, idempotencyKey: "key-b" });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it("honours an explicit operation id", () => {
    expect(createOperationId({ ...base, operationId: "explicit-op" })).toBe(
      "explicit-op"
    );
  });
});
