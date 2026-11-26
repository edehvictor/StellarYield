import { describe, it, expect } from "vitest";
import {
  validateTransactionReview,
  type RawTransactionReviewInput,
} from "./transactionReview";
import { computeQuoteAssumptionFingerprint } from "./quoteAssumptionFingerprint";

describe("validateTransactionReview", () => {
  const validWallet = "GBWM7FAKESTELLARWALLETADDRESS1234567890123456789012345678";
  const validAssumptions = {
    inputTokenContract: "CB64D3G7AW2Z64V6B3H6Y5A5LGBY2QW6K3V6W7G3E2D123456789012",
    vaultTokenContract: "CVLTFAKECONTRACTIDFORLOCALBUILDONLY123456789012345678901",
    amountInStroops: "100000000",
    expectedAmountOutStroops: "99500000",
    minAmountOutStroops: "99000000",
    slippageTolerancePct: 0.5,
    routeHash: "mockroutehash123",
    path: ["CB64D3G7AW2Z64V6B3H6Y5A5LGBY2QW6K3V6W7G3E2D123456789012"],
    source: "router_simulation",
    assetConfigVersion: "v1-config",
    quotedAt: new Date(Date.now() - 5000).toISOString(),
    expiresAt: new Date(Date.now() + 55000).toISOString(),
  };
  const validFingerprint = computeQuoteAssumptionFingerprint(validAssumptions).fingerprint;

  const validReview: RawTransactionReviewInput = {
    walletAddress: validWallet,
    inputToken: { symbol: "USDC", amount: "100" },
    vaultToken: { symbol: "yUSDC", amount: "99.5", minAmount: "99.0" },
    slippageTolerance: 0.5,
    assumptions: validAssumptions,
    fingerprint: validFingerprint,
  };

  it("accepts well-formed transaction review inputs", () => {
    const result = validateTransactionReview(validReview);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.sanitized.walletAddress).toBe(validWallet);
      expect(result.sanitized.inputToken.amount).toBe("100");
      expect(result.sanitized.vaultToken.minAmount).toBe("99.0");
      expect(result.sanitized.slippageTolerance).toBe(0.5);
    }
  });

  it("rejects non-object or missing input", () => {
    const result = validateTransactionReview(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe("MISSING_DATA");
    }
  });

  describe("walletAddress validation", () => {
    it("rejects missing or empty wallet address", () => {
      const result = validateTransactionReview({ ...validReview, walletAddress: "" });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("INVALID_WALLET_ADDRESS");
      }
    });

    it("rejects malformed address format", () => {
      const result = validateTransactionReview({ ...validReview, walletAddress: "invalid-address" });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("INVALID_WALLET_ADDRESS");
      }
    });
  });

  describe("inputToken validation", () => {
    it("rejects non-numeric input amounts", () => {
      const result = validateTransactionReview({
        ...validReview,
        inputToken: { symbol: "USDC", amount: "not-a-number" },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("INVALID_INPUT_AMOUNT");
      }
    });

    it("rejects negative or zero input amounts", () => {
      const negativeResult = validateTransactionReview({
        ...validReview,
        inputToken: { symbol: "USDC", amount: "-50" },
      });
      expect(negativeResult.valid).toBe(false);
      if (!negativeResult.valid) {
        expect(negativeResult.error.code).toBe("INVALID_INPUT_AMOUNT");
      }

      const zeroResult = validateTransactionReview({
        ...validReview,
        inputToken: { symbol: "USDC", amount: "0" },
      });
      expect(zeroResult.valid).toBe(false);
      if (!zeroResult.valid) {
        expect(zeroResult.error.code).toBe("INVALID_INPUT_AMOUNT");
      }
    });

    it("rejects invalid input token symbol", () => {
      const result = validateTransactionReview({
        ...validReview,
        inputToken: { symbol: "<script>", amount: "10" },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("INVALID_INPUT_SYMBOL");
      }
    });
  });

  describe("vaultToken validation", () => {
    it("rejects non-numeric vault amount", () => {
      const result = validateTransactionReview({
        ...validReview,
        vaultToken: { symbol: "yUSDC", amount: "abc" },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("INVALID_OUTPUT_AMOUNT");
      }
    });

    it("rejects minAmount that exceeds output amount", () => {
      const result = validateTransactionReview({
        ...validReview,
        vaultToken: { symbol: "yUSDC", amount: "99.5", minAmount: "105.0" },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("MIN_AMOUNT_EXCEEDS_OUTPUT");
      }
    });

    it("rejects non-numeric minAmount", () => {
      const result = validateTransactionReview({
        ...validReview,
        vaultToken: { symbol: "yUSDC", amount: "99.5", minAmount: "invalid" },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("INVALID_MIN_AMOUNT");
      }
    });
  });

  describe("slippageTolerance validation", () => {
    it("rejects negative slippage", () => {
      const result = validateTransactionReview({
        ...validReview,
        slippageTolerance: -0.5,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("INVALID_SLIPPAGE");
      }
    });

    it("rejects out-of-range slippage (> 50%)", () => {
      const result = validateTransactionReview({
        ...validReview,
        slippageTolerance: 55,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("INVALID_SLIPPAGE");
      }
    });

    it("rejects NaN slippage", () => {
      const result = validateTransactionReview({
        ...validReview,
        slippageTolerance: NaN,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("INVALID_SLIPPAGE");
      }
    });
  });

  describe("fingerprint & assumptions validation", () => {
    it("rejects malformed fingerprint strings", () => {
      const result = validateTransactionReview({
        ...validReview,
        fingerprint: "short-fp",
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("INVALID_FINGERPRINT");
      }
    });

    it("rejects expired quote assumptions", () => {
      const expiredAssumptions = {
        ...validAssumptions,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
      const result = validateTransactionReview({
        ...validReview,
        assumptions: expiredAssumptions,
        fingerprint: computeQuoteAssumptionFingerprint(expiredAssumptions).fingerprint,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("ASSUMPTIONS_EXPIRED");
      }
    });

    it("rejects assumption drift when fingerprint does not match payload", () => {
      const tamperedAssumptions = {
        ...validAssumptions,
        amountInStroops: "999999999", // tampered amount
      };
      const result = validateTransactionReview({
        ...validReview,
        assumptions: tamperedAssumptions,
        fingerprint: validFingerprint, // mismatch!
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("ASSUMPTION_DRIFT");
      }
    });
  });
});
