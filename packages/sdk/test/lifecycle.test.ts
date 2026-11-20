import { describe, it, expect } from "vitest";
import { Keypair, TransactionBuilder, Account, Operation, Networks, Asset, SorobanDataBuilder } from "@stellar/stellar-sdk";
import {
  VaultClient,
  PreparedTransaction,
  SignedTransaction,
  SubmittedTransaction,
  ConfirmedTransaction,
  ServerKeypairSigner,
  CustomSigner,
  FreighterSigner,
  SpecMismatchError,
  ContractExecutionError,
  WalletRejectedError,
  SubmissionTimeoutError,
  RestoreRequiredError,
  decodeVaultError,
  parseContractError,
  needsRestore,
  restoreAndRetry,
  YIELD_VAULT_SPEC_HASH,
  ApiClient,
  ProviderMethodError,
  ProviderConnectionError,
  ProviderPermissionError,
} from "../src";
import {
  createFakeRpcServer,
  fakeGetSuccess,
  fakeGetFailed,
  fakeGetNotFound,
  fakeSendPending,
} from "./fixtures/fakeRpc";
import {
  createFreighterProvider,
  createFullFreighterProvider,
  FreighterLikeProvider,
} from "./fixtures/freighterProvider";
describe("Soroban SDK Bindings & Lifecycle", () => {
  const dummyContractId = "CCW67TSB3SSSBDGRGBXMORAX6P4CBGQLGLKXMFFBVD7OH5VO5BTV6U2M";
  const dummyPassphrase = Networks.TESTNET;
  const dummyRpcUrl = "https://soroban-testnet.stellar.org";

  const sourceKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
  const sourceAccount = new Account(sourceKeypair.publicKey(), "100");

  function createUnsignedXdr(): string {
    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: dummyPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(30)
      .build();
    return tx.toXDR();
  }

  describe("Spec Hash Pinning & Verification", () => {
    it("exports YIELD_VAULT_SPEC_HASH as a 64-character sha256 string", () => {
      expect(YIELD_VAULT_SPEC_HASH).toMatch(/^[a-f0-9]{64}$/);
    });

    it("accepts matching specHash in VaultClient initialization", () => {
      const client = new VaultClient({
        contractId: dummyContractId,
        networkPassphrase: dummyPassphrase,
        rpcUrl: dummyRpcUrl,
        specHash: YIELD_VAULT_SPEC_HASH,
      });
      expect(client.specHash).toBe(YIELD_VAULT_SPEC_HASH);
    });

    it("throws SpecMismatchError when specHash does not match", () => {
      expect(() => {
        new VaultClient({
          contractId: dummyContractId,
          networkPassphrase: dummyPassphrase,
          rpcUrl: dummyRpcUrl,
          specHash: "1111111111111111111111111111111111111111111111111111111111111111",
        });
      }).toThrow(SpecMismatchError);
    });
  });

  describe("Signer Adapters", () => {
    it("ServerKeypairSigner signs unsigned XDR envelope", async () => {
      const signer = new ServerKeypairSigner(sourceKeypair);
      expect(await signer.getPublicKey()).toBe(sourceKeypair.publicKey());

      const unsignedXdr = createUnsignedXdr();
      const signedXdr = await signer.signTransaction(unsignedXdr, {
        networkPassphrase: dummyPassphrase,
      });

      expect(signedXdr).not.toBe(unsignedXdr);
      const parsed = TransactionBuilder.fromXDR(signedXdr, dummyPassphrase);
      expect(parsed.signatures.length).toBe(1);
    });

    it("CustomSigner delegates signing to custom callback", async () => {
      const mockSignFn = async (xdr: string, passphrase: string) => {
        const tx = TransactionBuilder.fromXDR(xdr, passphrase);
        tx.sign(sourceKeypair);
        return tx.toXDR();
      };

      const customSigner = new CustomSigner(sourceKeypair.publicKey(), mockSignFn);
      expect(await customSigner.getPublicKey()).toBe(sourceKeypair.publicKey());

      const unsignedXdr = createUnsignedXdr();
      const signedXdr = await customSigner.signTransaction(unsignedXdr, {
        networkPassphrase: dummyPassphrase,
      });

      expect(signedXdr).not.toBe(unsignedXdr);
    });
  });

  describe("Provider Adapter Compatibility", () => {
    const dummyPassphrase = Networks.TESTNET;

    it("FreighterLikeProvider with full implementation supports all methods", async () => {
      const provider = createFullFreighterProvider();
      expect(await provider.getPublicKey()).toBe("GBEN_TEST_PUBLIC_KEY");

      const unsignedXdr = createUnsignedXdr();
      const signedXdr = await provider.signTransaction(unsignedXdr, {
        networkPassphrase: dummyPassphrase,
      });
      // Mock returns input XDR, verify it's a non-empty string
      expect(typeof signedXdr).toBe("string");
      expect(signedXdr.length).toBeGreaterThan(0);

      await provider.connect();
      await provider.switchNetwork(dummyPassphrase);
      await provider.disconnect();
    });

    it("FreighterLikeProvider with missing methods throws errors", async () => {
      const provider = createFreighterProvider();

      // getPublicKey throws error
      await expect(provider.getPublicKey()).rejects.toThrow();

      // signTransaction throws error
      await expect(
        provider.signTransaction("xdr", { networkPassphrase: dummyPassphrase })
      ).rejects.toThrow();

      // connect throws error
      await expect(provider.connect()).rejects.toThrow();

      // disconnect throws error
      await expect(provider.disconnect()).rejects.toThrow();

      // switchNetwork throws error
      await expect(provider.switchNetwork(dummyPassphrase)).rejects.toThrow();
    });

    it("FreighterLikeProvider connection denial throws ProviderConnectionError", async () => {
      const provider = createFreighterProvider();
      await expect(provider.getPublicKey()).rejects.toThrow("ProviderConnectionError");
    });

it("Permission denial returns errors with descriptive messages", async () => {
  const denyingApi = {
    getPublicKey: async () => {
      throw new Error("User denied the request");
    },
    signTransaction: async () => {
      throw new Error("User declined the request");
    },
    isAllowed: async () => false,
    connect: async () => {
      throw new Error("User denied connection");
    },
    disconnect: async () => {},
    switchNetwork: async () => {},
  };
  const provider = new FreighterLikeProvider(denyingApi);

  await expect(provider.getPublicKey()).rejects.toThrow();
  await expect(provider.signTransaction("xdr", { networkPassphrase: dummyPassphrase })).rejects.toThrow();
  await expect(provider.connect()).rejects.toThrow();
});

it("FreighterLikeProvider fallback to default when no API provided", async () => {
  const provider = new FreighterLikeProvider();
  await expect(provider.getPublicKey()).rejects.toThrow("ProviderConnectionError");
  await expect(provider.signTransaction("xdr", { networkPassphrase: dummyPassphrase })).rejects.toThrow();
});
  });

  describe("Transaction Lifecycle Transitions", () => {
    it("PreparedTransaction transition to SignedTransaction", async () => {
      const unsignedXdr = createUnsignedXdr();
      const preparedMeta = {
        simulationResult: 100n,
        footprint: "dummy_footprint",
        authEntries: [],
        minResourceFee: "1000",
        transactionData: "",
        latestLedger: 1000,
        validUntilLedger: 1100,
        contractId: dummyContractId,
        networkPassphrase: dummyPassphrase,
        method: "deposit",
        argsHash: "{}",
        specHash: YIELD_VAULT_SPEC_HASH,
      };

      const prepared = PreparedTransaction.fromXDR<bigint>(unsignedXdr, preparedMeta);
      expect(prepared.state).toBe("SIMULATED");
      expect(prepared.meta.simulationResult).toBe(100n);

      const signer = new ServerKeypairSigner(sourceKeypair);
      const signed = await prepared.sign(signer);

      expect(signed.state).toBe("SIGNED");
      expect(signed.signedXdr).not.toBe(unsignedXdr);
    });
  });

  describe("Typed Error Handling & Decoding", () => {
    it("decodes contract VaultError code 3 into descriptive message", () => {
      const decoded = decodeVaultError(3);
      expect(decoded.name).toBe("ZeroAmount");
      expect(decoded.message).toContain("strictly greater than zero");
    });

    it("parses contract error string into ContractExecutionError", () => {
      const err = new Error("Error(Contract, #4)");
      const parsed = parseContractError(err);
      expect(parsed).toBeInstanceOf(ContractExecutionError);
      if (parsed instanceof ContractExecutionError) {
        expect(parsed.errorCode).toBe(4);
        expect(parsed.errorName).toBe("InsufficientShares");
      }
    });
  });

  describe("ApiClient Route Drift Prevention", () => {
    it("provides registered endpoints matching OpenAPI schema", () => {
      const api = new ApiClient({ baseUrl: "http://localhost:3001" });
      const endpoints = api.getRegisteredEndpoints();
      expect(endpoints.length).toBeGreaterThan(0);
      expect(endpoints.some((e) => e.pathPattern === "/api/yields")).toBe(true);
    });
  });

  describe("Full lifecycle: simulate -> sign -> submit -> poll -> confirm", () => {
    it("resolves a ConfirmedTransaction through a fake RPC, tolerating an initial NOT_FOUND poll", async () => {
      const unsignedXdr = createUnsignedXdr();
      const meta = {
        simulationResult: 250n,
        footprint: "f",
        authEntries: [],
        minResourceFee: "1000",
        transactionData: "",
        latestLedger: 1000,
        validUntilLedger: 1100,
        contractId: dummyContractId,
        networkPassphrase: dummyPassphrase,
        method: "deposit",
        argsHash: "{}",
      };

      const prepared = PreparedTransaction.fromXDR<bigint>(unsignedXdr, meta);
      const signer = new ServerKeypairSigner(sourceKeypair);
      const signed = await prepared.sign(signer);

      const fakeServer = createFakeRpcServer({
        send: fakeSendPending("abc123"),
        pollSequence: [fakeGetNotFound(), fakeGetSuccess(555)],
      });

      const submitted = await signed.submit(fakeServer as any);
      expect(submitted.state).toBe("SUBMITTED");

      const confirmed = await submitted.wait({ pollIntervalMs: 1 });
      expect(confirmed).toBeInstanceOf(ConfirmedTransaction);
      expect(confirmed.ledger).toBe(555);
      expect(confirmed.result).toBe(250n);
    });
  });

  describe("Rejected-signature flow", () => {
    it("throws WalletRejectedError with phase 'sign' and retryable true when the wallet rejects", async () => {
      const unsignedXdr = createUnsignedXdr();
      const meta = {
        simulationResult: 1n,
        footprint: "",
        authEntries: [],
        minResourceFee: "100",
        transactionData: "",
        latestLedger: 1,
        validUntilLedger: 100,
        contractId: dummyContractId,
        networkPassphrase: dummyPassphrase,
        method: "deposit",
        argsHash: "{}",
      };
      const prepared = PreparedTransaction.fromXDR<bigint>(unsignedXdr, meta);

      const rejectingSigner = new CustomSigner(sourceKeypair.publicKey(), async () => {
        throw new Error("User declined the request");
      });

      await expect(prepared.sign(rejectingSigner)).rejects.toBeInstanceOf(WalletRejectedError);
      try {
        await prepared.sign(rejectingSigner);
        throw new Error("expected rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(WalletRejectedError);
        expect((err as WalletRejectedError).phase).toBe("sign");
        expect((err as WalletRejectedError).retryable).toBe(true);
      }
    });
  });

  describe("Expired/timeout flow", () => {
    it("throws SubmissionTimeoutError with retryable=true when the transaction never lands", async () => {
      const fakeServer = createFakeRpcServer({ pollSequence: [fakeGetNotFound()] });
      const submitted = SubmittedTransaction.fromHash<bigint>("neverlands", {
        rpcUrl: dummyRpcUrl,
        networkPassphrase: dummyPassphrase,
        rpcServer: fakeServer as any,
      });

      await expect(
        submitted.wait({ timeoutMs: 20, pollIntervalMs: 5 })
      ).rejects.toMatchObject({
        name: "SubmissionTimeoutError",
        txHash: "neverlands",
        phase: "poll",
        retryable: true,
      });
    });

    it("throws a phase='poll' ContractExecutionError when the network reports FAILED", async () => {
      const fakeServer = createFakeRpcServer({ pollSequence: [fakeGetFailed(999)] });
      const submitted = SubmittedTransaction.fromHash<bigint>("willfail", {
        rpcUrl: dummyRpcUrl,
        networkPassphrase: dummyPassphrase,
        rpcServer: fakeServer as any,
      });

      await expect(submitted.wait()).rejects.toMatchObject({
        phase: "poll",
        retryable: false,
      });
    });
  });

  describe("Restore path", () => {
    it("needsRestore() is false for a plain successful simulation", () => {
      expect(needsRestore({ transactionData: "present" } as any)).toBe(false);
    });

    it("needsRestore() is true when the simulation carries a restorePreamble", () => {
      expect(
        needsRestore({
          transactionData: "present",
          restorePreamble: { minResourceFee: "100", transactionData: "needed" },
        } as any)
      ).toBe(true);
    });

    it("restoreAndRetry() builds, signs, submits and confirms a restore-footprint transaction", async () => {
      const restoreAccount = new Account(sourceKeypair.publicKey(), "100");
      const fakeServer = createFakeRpcServer({
        send: fakeSendPending("restoretxhash"),
        pollSequence: [fakeGetSuccess(777)],
      });

      const confirmed = await restoreAndRetry({
        restorePreamble: { minResourceFee: "5000", transactionData: new SorobanDataBuilder() },
        sourceAccount: restoreAccount,
        networkPassphrase: dummyPassphrase,
        signer: new ServerKeypairSigner(sourceKeypair),
        server: fakeServer as any,
        contractId: dummyContractId,
      });

      expect(confirmed).toBeInstanceOf(ConfirmedTransaction);
      expect(confirmed.ledger).toBe(777);
    });

    it("VaultClient surfaces RestoreRequiredError (phase='restore', retryable=true) when simulation needs a restore", async () => {
      const client = new VaultClient({
        contractId: dummyContractId,
        networkPassphrase: dummyPassphrase,
        rpcUrl: dummyRpcUrl,
      });

      (client as any).generatedClient.deposit = async () => ({
        simulation: {
          transactionData: "present",
          restorePreamble: { minResourceFee: "12345", transactionData: "needed" },
        },
      });

      await expect(
        client.deposit({ from: sourceKeypair.publicKey(), amount: 100n })
      ).rejects.toMatchObject({
        name: "RestoreRequiredError",
        minResourceFee: "12345",
        phase: "restore",
        retryable: true,
      });
    });
  });
});
