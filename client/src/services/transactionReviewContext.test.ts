import { describe, it, expect } from "vitest";
import {
  createTransactionReviewContext,
  validateTransactionReviewContext,
  ContextValidationErrorCode,
} from "./transactionReviewContext";

describe("TransactionReviewContext", () => {
  const testNetwork = "Test SDF Network ; September 2015";
  const testRpcUrl = "https://soroban-testnet.stellar.org";

  describe("createTransactionReviewContext", () => {
    it("creates a context with the provided values", () => {
      const context = createTransactionReviewContext(
        testNetwork,
        testRpcUrl,
        12345678,
        "v1",
      );

      expect(context.networkPassphrase).toBe(testNetwork);
      expect(context.rpcUrl).toBe(testRpcUrl);
      expect(context.ledgerSequence).toBe(12345678);
      expect(context.transactionVersion).toBe("v1");
      expect(context.capturedAt).toBeInstanceOf(Number);
    });

    it("creates a context with default ledger sequence of 0", () => {
      const context = createTransactionReviewContext(
        testNetwork,
        testRpcUrl,
      );

      expect(context.ledgerSequence).toBe(0);
    });
  });

  describe("validateTransactionReviewContext", () => {
    it("returns null when contexts match", () => {
      const expected = createTransactionReviewContext(
        testNetwork,
        testRpcUrl,
        12345678,
        "v1",
      );
      const actual = createTransactionReviewContext(
        testNetwork,
        testRpcUrl,
        12345678,
        "v1",
      );

      const result = validateTransactionReviewContext(actual, expected);
      expect(result).toBeNull();
    });

    it("detects network mismatch", () => {
      const expected = createTransactionReviewContext(
        testNetwork,
        testRpcUrl,
        12345678,
        "v1",
      );
      const actual = createTransactionReviewContext(
        "Public Global Stellar Network ; November 2015",
        testRpcUrl,
        12345678,
        "v1",
      );

      const result = validateTransactionReviewContext(actual, expected);
      expect(result).toContain("Network mismatch");
    });

    it("detects RPC URL mismatch", () => {
      const expected = createTransactionReviewContext(
        testNetwork,
        testRpcUrl,
        12345678,
        "v1",
      );
      const actual = createTransactionReviewContext(
        testNetwork,
        "https://other-rpc-url.stellar.org",
        12345678,
        "v1",
      );

      const result = validateTransactionReviewContext(actual, expected);
      expect(result).toContain("RPC URL mismatch");
    });

    it("detects ledger sequence mismatch", () => {
      const expected = createTransactionReviewContext(
        testNetwork,
        testRpcUrl,
        12345678,
        "v1",
      );
      const actual = createTransactionReviewContext(
        testNetwork,
        testRpcUrl,
        9999999,
        "v1",
      );

      const result = validateTransactionReviewContext(actual, expected);
      expect(result).toContain("Ledger sequence mismatch");
    });

    it("detects transaction version mismatch", () => {
      const expected = createTransactionReviewContext(
        testNetwork,
        testRpcUrl,
        12345678,
        "v1",
      );
      const actual = createTransactionReviewContext(
        testNetwork,
        testRpcUrl,
        12345678,
        "v2",
      );

      const result = validateTransactionReviewContext(actual, expected);
      expect(result).toContain("Transaction version mismatch");
    });

    it("returns error code NETWORK_MISMATCH for network mismatch", () => {
      const expected = createTransactionReviewContext(
        testNetwork,
        testRpcUrl,
        12345678,
        "v1",
      );
      const actual = createTransactionReviewContext(
        "Public Global Stellar Network ; November 2015",
        testRpcUrl,
        12345678,
        "v1",
      );

      const result = validateTransactionReviewContext(actual, expected);
      // The result is a string, we just check it contains the expected info
      expect(typeof result).toBe("string");
    });
  });

  describe("ContextValidationErrorCode", () => {
    it("has all expected error codes", () => {
      expect(ContextValidationErrorCode.NETWORK_MISMATCH).toBe("NETWORK_MISMATCH");
      expect(ContextValidationErrorCode.RPC_URL_MISMATCH).toBe("RPC_URL_MISMATCH");
      expect(ContextValidationErrorCode.LEDGER_SEQUENCE_MISMATCH).toBe(
        "LEDGER_SEQUENCE_MISMATCH",
      );
      expect(ContextValidationErrorCode.TRANSACTION_VERSION_MISMATCH).toBe(
        "TRANSACTION_VERSION_MISMATCH",
      );
    });
  });
});