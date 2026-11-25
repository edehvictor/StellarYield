import { describe, it, expect } from "vitest";
import {
  validateNumber,
  validateStroopAmount,
  validateTransactionBuilder,
  validateSignerSet,
  validateThresholdForExecution,
  I128_MAX,
} from "./validation";
import { computeSignerQuorumProgress } from "./signerQuorum";
import { ADMIN_ACTIONS } from "./governanceActions";

describe("Governance Boundary-Value Calculations — Client", () => {
  const validWallet = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const signerA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const signerB = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
  const signerC = "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U";

  describe("Checked Integer & Number Boundary Validation", () => {
    it("accepts valid boundary numbers within [0, 10000]", () => {
      expect(validateNumber("0", 0, 10000, true)).toBe(true);
      expect(validateNumber("10000", 0, 10000, true)).toBe(true);
      expect(validateNumber("50", 0, 10000, true)).toBe(true);
    });

    it("rejects non-integer values when integerOnly is enabled", () => {
      expect(validateNumber("50.5", 0, 10000, true)).toBe(false);
      expect(validateNumber("0.1", 0, 10000, true)).toBe(false);
      expect(validateNumber("1e3", 0, 10000, true)).toBe(false);
      expect(validateNumber("10000.1", 0, 10000, true)).toBe(false);
    });

    it("rejects out-of-range basis point values", () => {
      expect(validateNumber("-1", 0, 10000, true)).toBe(false);
      expect(validateNumber("10001", 0, 10000, true)).toBe(false);
    });
  });

  describe("Stroop Amount Checked Arithmetic & Boundaries", () => {
    it("accepts minimum valid amount (1 stroop)", () => {
      expect(validateStroopAmount("1")).toBe(true);
    });

    it("accepts standard positive amounts", () => {
      expect(validateStroopAmount("10000000")).toBe(true);
      expect(validateStroopAmount("500000000")).toBe(true);
    });

    it("accepts maximum i128 bound (I128_MAX)", () => {
      expect(validateStroopAmount(I128_MAX.toString())).toBe(true);
    });

    it("rejects zero and negative amounts", () => {
      expect(validateStroopAmount("0")).toBe(false);
      expect(validateStroopAmount("-1")).toBe(false);
      expect(validateStroopAmount("-1000")).toBe(false);
    });

    it("rejects fractional amounts (stroop is atomic indivisible unit)", () => {
      expect(validateStroopAmount("1.5")).toBe(false);
      expect(validateStroopAmount("0.0000001")).toBe(false);
    });

    it("rejects amounts exceeding I128_MAX", () => {
      const overMax = (I128_MAX + 1n).toString();
      expect(validateStroopAmount(overMax)).toBe(false);
    });

    it("rejects malformed string inputs", () => {
      expect(validateStroopAmount("")).toBe(false);
      expect(validateStroopAmount("abc")).toBe(false);
      expect(validateStroopAmount("0x10")).toBe(false);
      expect(validateStroopAmount("1e7")).toBe(false);
    });
  });

  describe("Cross-Field Fee Bounds Validation", () => {
    const setFeeBoundsAction = ADMIN_ACTIONS.find((a) => a.method === "set_fee_bounds")!;

    it("accepts valid boundary bounds (min < max)", () => {
      const result = validateTransactionBuilder(setFeeBoundsAction, validWallet, {
        min_bps: "0",
        max_bps: "10000",
      });
      expect(result?.isValid).toBe(true);
      expect(result?.errors).toHaveLength(0);
    });

    it("rejects when min == max (e.g. 500 == 500 bps)", () => {
      const result = validateTransactionBuilder(setFeeBoundsAction, validWallet, {
        min_bps: "500",
        max_bps: "500",
      });
      expect(result?.isValid).toBe(false);
      expect(result?.errors.some((e) => e.message.includes("greater than min"))).toBe(true);
    });

    it("rejects when min > max (e.g. 1000 > 100 bps)", () => {
      const result = validateTransactionBuilder(setFeeBoundsAction, validWallet, {
        min_bps: "1000",
        max_bps: "100",
      });
      expect(result?.isValid).toBe(false);
      expect(result?.errors.some((e) => e.message.includes("greater than min"))).toBe(true);
    });

    it("rejects fractional fee bounds (e.g. 50.5 bps)", () => {
      const result = validateTransactionBuilder(setFeeBoundsAction, validWallet, {
        min_bps: "50.5",
        max_bps: "500",
      });
      expect(result?.isValid).toBe(false);
      expect(result?.errors.some((e) => e.field === "min_bps")).toBe(true);
    });
  });

  describe("Signer Quorum Progress Boundary Calculations", () => {
    const signers = Array.from({ length: 1000 }, (_, i) => `G${String(i).padStart(55, "A")}`);

    it("never prematurely rounds up to 100% at near-limit progress (999/1000)", () => {
      const progress = computeSignerQuorumProgress(
        {
          signatures: signers.slice(0, 999).map((publicKey) => ({ publicKey, signedAt: Date.now() })),
          threshold: 1000,
        },
        { signers },
      );

      expect(progress.signed).toBe(999);
      expect(progress.remaining).toBe(1);
      expect(progress.met).toBe(false);
      expect(progress.progressPct).toBe(99);
    });

    it("attains exactly 100% when threshold is reached", () => {
      const progress = computeSignerQuorumProgress(
        {
          signatures: signers.slice(0, 1000).map((publicKey) => ({ publicKey, signedAt: Date.now() })),
          threshold: 1000,
        },
        { signers },
      );

      expect(progress.signed).toBe(1000);
      expect(progress.remaining).toBe(0);
      expect(progress.met).toBe(true);
      expect(progress.progressPct).toBe(100);
    });

    it("handles zero threshold safely", () => {
      const progress = computeSignerQuorumProgress(
        {
          signatures: [],
          threshold: 0,
        },
        { signers: [signerA, signerB] },
      );
      expect(progress.required).toBe(1);
      expect(progress.progressPct).toBe(0);
      expect(progress.met).toBe(false);
    });
  });

  describe("Threshold Validation", () => {
    it("rejects non-integer thresholds", () => {
      const res = validateSignerSet([signerA, signerB], 1.5);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("at least 1"))).toBe(true);
    });

    it("rejects non-integer threshold for execution", () => {
      const res = validateThresholdForExecution(
        [{ publicKey: signerA, signedAt: Date.now() }],
        1.5,
        [signerA, signerB],
      );
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes("at least 1"))).toBe(true);
    });
  });

  describe("State Preservation on Validation Failure", () => {
    it("preserves submitted field values without modification on failure", () => {
      const rescueAction = ADMIN_ACTIONS.find((a) => a.method === "rescue_funds")!;
      const fields = {
        target: "GSHORT",
        amount: "0",
      };

      const result = validateTransactionBuilder(rescueAction, validWallet, fields);
      expect(result?.isValid).toBe(false);
      // Original input values are preserved unchanged
      expect(fields.target).toBe("GSHORT");
      expect(fields.amount).toBe("0");
    });
  });
});
