import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, TransactionBuilder, Account, Operation, Networks, Asset } from "@stellar/stellar-sdk";
import {
  ServerKeypairSigner,
  CustomSigner,
  FreighterSigner,
  IdempotentSignerAdapter,
  SignerOperationManager,
  computeSignerPayloadFingerprint,
  createSignerOperationIdentity,
  executeSafeSignerSubmission,
  DuplicateSubmissionError,
  SignerOperationConflictError,
  SignerValidationError,
  WalletRejectedError,
  InvalidXdrError,
  PreparedTransaction,
  YIELD_VAULT_SPEC_HASH,
} from "../src";

interface MockAccountState {
  balance: bigint;
  allowance: bigint;
  nonce: number;
  lastSignedTx?: string;
}

describe("SDK Signer Adapter Idempotency & Duplicate Protection (#1861)", () => {
  const dummyPassphrase = Networks.TESTNET;
  const dummyContractId = "CCW67TSB3SSSBDGRGBXMORAX6P4CBGQLGLKXMFFBVD7OH5VO5BTV6U2M";

  const sourceKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
  const sourceAccount = new Account(sourceKeypair.publicKey(), "100");

  function createTestUnsignedXdr(): string {
    const dest = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: dummyPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: dest,
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(30)
      .build();
    return tx.toXDR();
  }

  function createAlteredUnsignedXdr(): string {
    const dest = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
    const tx = new TransactionBuilder(sourceAccount, {
      fee: "200",
      networkPassphrase: dummyPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: dest,
          asset: Asset.native(),
          amount: "50",
        })
      )
      .setTimeout(60)
      .build();
    return tx.toXDR();
  }

  let manager: SignerOperationManager;
  let signer: ServerKeypairSigner;
  let initialState: MockAccountState;

  beforeEach(() => {
    manager = new SignerOperationManager();
    signer = new ServerKeypairSigner(sourceKeypair, manager);
    initialState = {
      balance: 10_000n,
      allowance: 500n,
      nonce: 1,
    };
  });

  // ── 1. Normal Signer Operation ─────────────────────────────────────────────

  describe("1. Normal Signer Operation", () => {
    it("ServerKeypairSigner signs unsigned XDR without operationId (backward compatibility)", async () => {
      const unsignedXdr = createTestUnsignedXdr();
      const signedXdr = await signer.signTransaction(unsignedXdr, {
        networkPassphrase: dummyPassphrase,
      });

      expect(signedXdr).toBeDefined();
      expect(typeof signedXdr).toBe("string");
      expect(signedXdr.length).toBeGreaterThan(0);

      // Verify signed XDR parses and has signature
      const parsed = TransactionBuilder.fromXDR(signedXdr, dummyPassphrase);
      expect(parsed.signatures.length).toBe(1);
    });

    it("CustomSigner signs transaction normally", async () => {
      let callCount = 0;
      const custom = new CustomSigner(
        sourceKeypair.publicKey(),
        async (xdr, passphrase) => {
          callCount++;
          const tx = TransactionBuilder.fromXDR(xdr, passphrase);
          tx.sign(sourceKeypair);
          return tx.toXDR();
        },
        manager
      );

      const unsignedXdr = createTestUnsignedXdr();
      const signedXdr = await custom.signTransaction(unsignedXdr, {
        networkPassphrase: dummyPassphrase,
      });

      expect(callCount).toBe(1);
      expect(signedXdr).toBeDefined();
    });

    it("IdempotentSignerAdapter transparently delegates to wrapped signer on normal call", async () => {
      const wrapped = IdempotentSignerAdapter.wrap(signer, manager);
      expect(await wrapped.getPublicKey()).toBe(sourceKeypair.publicKey());

      const unsignedXdr = createTestUnsignedXdr();
      const signedXdr = await wrapped.signTransaction(unsignedXdr, {
        networkPassphrase: dummyPassphrase,
      });

      expect(signedXdr).toBeDefined();
    });
  });

  // ── 2. Successful Operation Submission ─────────────────────────────────────

  describe("2. Successful Operation Submission", () => {
    it("executes safe submission, records identity and committed effect, updates state", async () => {
      const unsignedXdr = createTestUnsignedXdr();
      const opId = "op-success-001";

      const result = await executeSafeSignerSubmission(
        {
          signer,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          contractId: dummyContractId,
          operationId: opId,
          currentState: initialState,
          onSuccessStateUpdate: (state, signedXdr) => ({
            ...state,
            balance: state.balance - 100n,
            nonce: state.nonce + 1,
            lastSignedTx: signedXdr,
          }),
        },
        manager
      );

      expect(result.success).toBe(true);
      expect(result.duplicate).toBe(false);
      expect(result.replayed).toBe(false);
      expect(result.signedXdr).toBeDefined();

      // State is updated
      expect(result.state.balance).toBe(9_900n);
      expect(result.state.nonce).toBe(2);
      expect(result.state.lastSignedTx).toBe(result.signedXdr);

      // Identity is immutable and accurate
      expect(result.identity.operationId).toBe(opId);
      expect(result.identity.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(result.identity.shortId).toMatch(/^sop-[0-9a-f]{6}…[0-9a-f]{4}$/);
      expect(result.identity.txHash).toBeDefined();
      expect(result.identity.publicKey).toBe(sourceKeypair.publicKey());

      // Effects are recorded
      expect(result.effects).toHaveLength(1);
      expect(result.effects![0].type).toBe("TRANSACTION_SIGNED");
      expect(result.effects![0].operationId).toBe(opId);

      // Registry contains committed record
      const record = manager.getOperation(opId);
      expect(record).toBeDefined();
      expect(record?.status).toBe("committed");
      expect(record?.signedXdr).toBe(result.signedXdr);
    });
  });

  // ── 3. Duplicate Submission Detection ──────────────────────────────────────

  describe("3. Duplicate Submission Detection", () => {
    it("detects duplicate submission with same operationId and payload", async () => {
      const unsignedXdr = createTestUnsignedXdr();
      const opId = "op-dup-001";

      // First submission
      const first = await executeSafeSignerSubmission(
        {
          signer,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: opId,
          currentState: initialState,
          onSuccessStateUpdate: (s) => ({ ...s, balance: s.balance - 100n }),
        },
        manager
      );
      expect(first.success).toBe(true);
      expect(first.duplicate).toBe(false);

      // Duplicate submission
      const second = await executeSafeSignerSubmission(
        {
          signer,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: opId,
          currentState: first.state,
          onSuccessStateUpdate: (s) => ({ ...s, balance: s.balance - 100n }),
        },
        manager
      );

      expect(second.success).toBe(true);
      expect(second.duplicate).toBe(true);
      expect(second.replayed).toBe(true);
      expect(second.signedXdr).toBe(first.signedXdr);
      // State is NOT mutated again!
      expect(second.state.balance).toBe(first.state.balance);
    });

    it("direct signer.signTransaction returns committed signed XDR on duplicate call", async () => {
      const unsignedXdr = createTestUnsignedXdr();
      const opId = "op-direct-dup-001";

      const firstSigned = await signer.signTransaction(unsignedXdr, {
        networkPassphrase: dummyPassphrase,
        operationId: opId,
      });

      const secondSigned = await signer.signTransaction(unsignedXdr, {
        networkPassphrase: dummyPassphrase,
        operationId: opId,
      });

      expect(secondSigned).toBe(firstSigned);
      const record = manager.getOperation(opId);
      expect(record?.replayedCount).toBe(1);
    });
  });

  // ── 4. Repeated Submission Handling ────────────────────────────────────────

  describe("4. Repeated Submission Handling", () => {
    it("repeated submissions do not apply effects multiple times", async () => {
      let signCallCount = 0;
      const custom = new CustomSigner(
        sourceKeypair.publicKey(),
        async (xdr, passphrase) => {
          signCallCount++;
          const tx = TransactionBuilder.fromXDR(xdr, passphrase);
          tx.sign(sourceKeypair);
          return tx.toXDR();
        },
        manager
      );

      const unsignedXdr = createTestUnsignedXdr();
      const opId = "op-repeat-001";

      let state = { ...initialState };

      // Submit 4 times
      for (let i = 0; i < 4; i++) {
        const res = await executeSafeSignerSubmission(
          {
            signer: custom,
            unsignedXdr,
            networkPassphrase: dummyPassphrase,
            operationId: opId,
            currentState: state,
            onSuccessStateUpdate: (s) => ({ ...s, balance: s.balance - 250n }),
          },
          manager
        );
        state = res.state;
      }

      // Underlying sign was only executed once
      expect(signCallCount).toBe(1);
      // Balance was only deducted ONCE (10000 - 250 = 9750), not 4 times
      expect(state.balance).toBe(9_750n);

      const record = manager.getOperation(opId);
      expect(record?.replayedCount).toBe(3);
    });
  });

  // ── 5. Concurrent Duplicate Submissions ────────────────────────────────────

  describe("5. Concurrent Duplicate Submissions", () => {
    it("rejects concurrent submission while in-flight with DUPLICATE_SUBMISSION_IN_PROGRESS", async () => {
      const unsignedXdr = createTestUnsignedXdr();
      const opId = "op-concurrent-001";

      const identity = createSignerOperationIdentity(unsignedXdr, {
        networkPassphrase: dummyPassphrase,
        operationId: opId,
      });

      // Manually set status to in_flight to simulate active concurrent operation
      manager.recordInFlight(identity);

      const result = await executeSafeSignerSubmission(
        {
          signer,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: opId,
          currentState: initialState,
        },
        manager
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("DUPLICATE_SUBMISSION_IN_PROGRESS");
      expect(result.isRecoverable).toBe(true);
      // State preserved
      expect(result.state).toEqual(initialState);
      expect(result.state.balance).toBe(10_000n);
    });

    it("direct signTransaction throws DuplicateSubmissionError when in-flight", async () => {
      const unsignedXdr = createTestUnsignedXdr();
      const opId = "op-concurrent-direct-001";

      const identity = createSignerOperationIdentity(unsignedXdr, {
        networkPassphrase: dummyPassphrase,
        operationId: opId,
      });
      manager.recordInFlight(identity);

      await expect(
        signer.signTransaction(unsignedXdr, {
          networkPassphrase: dummyPassphrase,
          operationId: opId,
        })
      ).rejects.toThrow(DuplicateSubmissionError);
    });
  });

  // ── 6. Validation Failures ─────────────────────────────────────────────────

  describe("6. Validation Failures", () => {
    it("preserves state and balances when validate returns an error string", async () => {
      const unsignedXdr = createTestUnsignedXdr();
      const opId = "op-val-fail-001";

      const result = await executeSafeSignerSubmission(
        {
          signer,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: opId,
          currentState: initialState,
          validate: (state) => {
            if (state.balance < 50_000n) {
              return "Insufficient balance for transaction fee reservation";
            }
            return true;
          },
          onSuccessStateUpdate: (s) => ({ ...s, balance: 0n }),
        },
        manager
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("VALIDATION_FAILED");
      expect(result.error).toContain("Insufficient balance");
      expect(result.isRecoverable).toBe(true);

      // CRITICAL: State and balance are preserved untouched
      expect(result.state).toEqual(initialState);
      expect(result.state.balance).toBe(10_000n);

      // Operation record is marked rejected, no effects committed
      const record = manager.getOperation(opId);
      expect(record?.status).toBe("rejected");
      expect(record?.effects).toHaveLength(0);
    });

    it("direct signTransaction throws SignerValidationError when pre-sign validation fails", async () => {
      const unsignedXdr = createTestUnsignedXdr();
      const opId = "op-val-direct-001";

      await expect(
        signer.signTransaction(unsignedXdr, {
          networkPassphrase: dummyPassphrase,
          operationId: opId,
          validate: () => "Allowance threshold exceeded",
        })
      ).rejects.toThrow(SignerValidationError);

      const record = manager.getOperation(opId);
      expect(record?.status).toBe("rejected");
    });
  });

  // ── 7. Execution Failures ──────────────────────────────────────────────────

  describe("7. Execution Failures", () => {
    it("preserves state and balances when signer throws WalletRejectedError", async () => {
      const rejectingSigner = new CustomSigner(
        sourceKeypair.publicKey(),
        async () => {
          throw new WalletRejectedError("User closed the wallet prompt");
        },
        manager
      );

      const unsignedXdr = createTestUnsignedXdr();
      const opId = "op-exec-fail-001";

      const result = await executeSafeSignerSubmission(
        {
          signer: rejectingSigner,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: opId,
          currentState: initialState,
          onSuccessStateUpdate: (s) => ({ ...s, balance: 0n }),
        },
        manager
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("EXECUTION_FAILED");
      expect(result.isRecoverable).toBe(true);
      expect(result.error).toContain("User closed the wallet prompt");

      // CRITICAL: State and balance preserved untouched
      expect(result.state).toEqual(initialState);
      expect(result.state.balance).toBe(10_000n);

      // Operation is marked failed (ready for safe retry)
      const record = manager.getOperation(opId);
      expect(record?.status).toBe("failed");
    });

    it("preserves state and balances when secondary execute hook fails", async () => {
      const unsignedXdr = createTestUnsignedXdr();
      const opId = "op-exec-hook-fail-001";

      const result = await executeSafeSignerSubmission(
        {
          signer,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: opId,
          currentState: initialState,
          execute: async () => {
            throw new Error("RPC network connection timeout");
          },
          onSuccessStateUpdate: (s) => ({ ...s, balance: 0n }),
        },
        manager
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("EXECUTION_FAILED");
      expect(result.error).toContain("RPC network connection timeout");

      // State and balance strictly preserved
      expect(result.state).toEqual(initialState);
      expect(result.state.balance).toBe(10_000n);
      expect(manager.getOperation(opId)?.status).toBe("failed");
    });
  });

  // ── 8. Safe Retry Behavior ─────────────────────────────────────────────────

  describe("8. Safe Retry Behavior", () => {
    it("safe retry with same operationId succeeds after transient failure", async () => {
      let attempts = 0;
      const transientSigner = new CustomSigner(
        sourceKeypair.publicKey(),
        async (xdr, passphrase) => {
          attempts++;
          if (attempts === 1) {
            throw new WalletRejectedError("Transient communication error");
          }
          const tx = TransactionBuilder.fromXDR(xdr, passphrase);
          tx.sign(sourceKeypair);
          return tx.toXDR();
        },
        manager
      );

      const unsignedXdr = createTestUnsignedXdr();
      const opId = "op-retry-001";

      // Attempt 1: Fails
      const res1 = await executeSafeSignerSubmission(
        {
          signer: transientSigner,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: opId,
          currentState: initialState,
          onSuccessStateUpdate: (s) => ({ ...s, balance: s.balance - 500n }),
        },
        manager
      );
      expect(res1.success).toBe(false);
      expect(res1.state.balance).toBe(10_000n); // Untouched
      expect(manager.getOperation(opId)?.status).toBe("failed");

      // Attempt 2: Safe retry with same opId succeeds
      const res2 = await executeSafeSignerSubmission(
        {
          signer: transientSigner,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: opId,
          currentState: initialState,
          onSuccessStateUpdate: (s) => ({ ...s, balance: s.balance - 500n }),
        },
        manager
      );

      expect(res2.success).toBe(true);
      expect(res2.state.balance).toBe(9_500n); // Now updated
      expect(attempts).toBe(2);
      expect(manager.getOperation(opId)?.status).toBe("committed");
    });

    it("retry with fresh operationId after failure succeeds cleanly", async () => {
      let attempts = 0;
      const transientSigner = new CustomSigner(
        sourceKeypair.publicKey(),
        async (xdr, passphrase) => {
          attempts++;
          if (attempts === 1) {
            throw new Error("Temporary provider offline");
          }
          const tx = TransactionBuilder.fromXDR(xdr, passphrase);
          tx.sign(sourceKeypair);
          return tx.toXDR();
        },
        manager
      );

      const unsignedXdr = createTestUnsignedXdr();

      // First attempt with op-fail
      const failRes = await executeSafeSignerSubmission(
        {
          signer: transientSigner,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: "op-fail-attempt",
          currentState: initialState,
          onSuccessStateUpdate: (s) => ({ ...s, balance: s.balance - 100n }),
        },
        manager
      );
      expect(failRes.success).toBe(false);
      expect(failRes.state.balance).toBe(10_000n);

      // Fresh retry with op-success
      const successRes = await executeSafeSignerSubmission(
        {
          signer: transientSigner,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: "op-success-retry",
          currentState: initialState,
          onSuccessStateUpdate: (s) => ({ ...s, balance: s.balance - 100n }),
        },
        manager
      );
      expect(successRes.success).toBe(true);
      expect(successRes.state.balance).toBe(9_900n);
      expect(manager.getOperation("op-success-retry")?.status).toBe("committed");
    });
  });

  // ── 9. Preservation of Existing State and Balances After Failures ──────────

  describe("9. Preservation of Existing State and Balances After Failures", () => {
    it("guarantees balance is never partially updated or mutated across any failure mode", async () => {
      const unsignedXdr = createTestUnsignedXdr();

      // Scenario A: Validation rejection preserves exact balance
      const valResult = await executeSafeSignerSubmission(
        {
          signer,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: "op-preserve-val",
          currentState: initialState,
          validate: () => "Explicit validation error",
          onSuccessStateUpdate: (s) => ({ ...s, balance: s.balance - 1000n }),
        },
        manager
      );
      expect(valResult.state.balance).toBe(initialState.balance);
      expect(valResult.state.allowance).toBe(initialState.allowance);
      expect(valResult.state.nonce).toBe(initialState.nonce);

      // Scenario B: Execution error preserves exact balance
      const failingSigner = new CustomSigner(
        sourceKeypair.publicKey(),
        async () => {
          throw new InvalidXdrError("corrupt_xdr", "Cannot parse");
        },
        manager
      );

      const execResult = await executeSafeSignerSubmission(
        {
          signer: failingSigner,
          unsignedXdr,
          networkPassphrase: dummyPassphrase,
          operationId: "op-preserve-exec",
          currentState: initialState,
          onSuccessStateUpdate: (s) => ({ ...s, balance: s.balance - 1000n }),
        },
        manager
      );
      expect(execResult.state.balance).toBe(initialState.balance);

      // Scenario C: Identity conflict preserves exact balance
      const conflictResult = await executeSafeSignerSubmission(
        {
          signer,
          unsignedXdr: createAlteredUnsignedXdr(),
          networkPassphrase: dummyPassphrase,
          operationId: "op-preserve-val", // Reusing ID with different XDR
          currentState: initialState,
          onSuccessStateUpdate: (s) => ({ ...s, balance: s.balance - 1000n }),
        },
        manager
      );
      expect(conflictResult.state.balance).toBe(initialState.balance);
    });
  });

  // ── 10. Operation Identity Conflict Detection ──────────────────────────────

  describe("10. Operation Identity Conflict Detection", () => {
    it("rejects when same operationId is reused with different transaction parameters", async () => {
      const xdrA = createTestUnsignedXdr();
      const xdrB = createAlteredUnsignedXdr();
      const opId = "op-conflict-001";

      // Commit first operation with xdrA
      const first = await executeSafeSignerSubmission(
        {
          signer,
          unsignedXdr: xdrA,
          networkPassphrase: dummyPassphrase,
          operationId: opId,
          currentState: initialState,
        },
        manager
      );
      expect(first.success).toBe(true);

      // Reuse same opId with altered xdrB
      const second = await executeSafeSignerSubmission(
        {
          signer,
          unsignedXdr: xdrB,
          networkPassphrase: dummyPassphrase,
          operationId: opId,
          currentState: initialState,
        },
        manager
      );

      expect(second.success).toBe(false);
      expect(second.errorCode).toBe("OPERATION_IDENTITY_CONFLICT");
      expect(second.isRecoverable).toBe(false);
      expect(second.state).toEqual(initialState);
    });

    it("direct signTransaction throws SignerOperationConflictError on parameter mismatch", async () => {
      const xdrA = createTestUnsignedXdr();
      const xdrB = createAlteredUnsignedXdr();
      const opId = "op-conflict-direct-001";

      await signer.signTransaction(xdrA, {
        networkPassphrase: dummyPassphrase,
        operationId: opId,
      });

      await expect(
        signer.signTransaction(xdrB, {
          networkPassphrase: dummyPassphrase,
          operationId: opId,
        })
      ).rejects.toThrow(SignerOperationConflictError);
    });
  });

  // ── 11. PreparedTransaction Lifecycle Integration ──────────────────────────

  describe("11. PreparedTransaction Lifecycle Integration", () => {
    it("PreparedTransaction.sign forwards operationId and benefits from duplicate protection", async () => {
      const unsignedXdr = createTestUnsignedXdr();
      const prepared = new PreparedTransaction(unsignedXdr, {
        simulationResult: 42,
        footprint: "",
        authEntries: [],
        minResourceFee: "100",
        transactionData: "",
        latestLedger: 100,
        validUntilLedger: 200,
        contractId: dummyContractId,
        networkPassphrase: dummyPassphrase,
        method: "deposit",
        argsHash: "hash123",
      });

      const opId = "op-lifecycle-001";

      // First sign call
      const signed1 = await prepared.sign(signer, { operationId: opId });
      expect(signed1.state).toBe("SIGNED");

      // Second sign call with same operationId returns cached signed transaction
      const signed2 = await prepared.sign(signer, { operationId: opId });
      expect(signed2.toXDR()).toBe(signed1.toXDR());

      const record = manager.getOperation(opId);
      expect(record?.replayedCount).toBe(1);
    });
  });
});
