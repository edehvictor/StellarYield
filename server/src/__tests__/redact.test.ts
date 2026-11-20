/**
 * redact.test.ts — Issue #1181
 *
 * Tests for privacy-safe error reporting:
 * 1. Wallet addresses are redacted
 * 2. Transaction hashes are redacted
 * 3. Encrypted blobs are redacted
 * 4. Email addresses are redacted
 * 5. Private keys are redacted
 * 6. Safe wallet/contact identifiers work
 * 7. Error redaction preserves category data
 */

import {
  redactSensitiveData,
  redactErrorForLog,
  safeWalletId,
  safeContactId,
  safeLogError,
} from "../utils/redact";

describe("redact.ts (#1181)", () => {
  describe("redactSensitiveData", () => {
    it("redacts Stellar wallet addresses", () => {
      const input = "Failed to process for GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ";
      const result = redactSensitiveData(input);
      expect(result).not.toContain("GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ");
      expect(result).toContain("GALC...CFXYZ");
    });

    it("redacts transaction hashes", () => {
      const input = "Transaction abc123def456789012345678901234567890123456789012345678901234567 failed";
      const result = redactSensitiveData(input);
      expect(result).not.toContain("abc123def456789012345678901234567890123456789012345678901234567");
      expect(result).toContain("abc123...4567");
    });

    it("redacts email addresses", () => {
      const input = "Notification sent to user@example.com";
      const result = redactSensitiveData(input);
      expect(result).not.toContain("user@example.com");
      expect(result).toContain("***@***");
    });

    it("redacts private keys (S-prefixed)", () => {
      const input = "Key SABCDEFGHIJKLMNOPQRSTUVWXYZ23456789012345678901234567890AB";
      const result = redactSensitiveData(input);
      expect(result).toContain("S****");
    });

    it("redacts API keys (sk- prefixed)", () => {
      const input = "Using sk-proj-abcdefghijklmnopqrstuvwxyz123456";
      const result = redactSensitiveData(input);
      expect(result).toContain("sk-****");
    });

    it("preserves non-sensitive text", () => {
      const input = "Transaction failed due to timeout";
      const result = redactSensitiveData(input);
      expect(result).toBe(input);
    });

    it("handles empty input", () => {
      expect(redactSensitiveData("")).toBe("");
    });

    it("handles null/undefined input", () => {
      expect(redactSensitiveData(null as any)).toBe(null);
      expect(redactSensitiveData(undefined as any)).toBe(undefined);
    });

    it("redacts multiple sensitive items in one string", () => {
      const input = "User GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ sent tx abc123def456789012345678901234567890123456789012345678901234567";
      const result = redactSensitiveData(input);
      expect(result).not.toContain("GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ");
      expect(result).not.toContain("abc123def456789012345678901234567890123456789012345678901234567");
    });
  });

  describe("redactErrorForLog", () => {
    it("redacts error message from Error objects", () => {
      const error = new Error("Failed for GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ");
      const result = redactErrorForLog(error);
      expect(result.name).toBe("Error");
      expect(result.message).not.toContain("GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ");
      expect(result.message).toContain("GALC...CFXYZ");
      expect(result.timestamp).toBeDefined();
    });

    it("preserves error category fields", () => {
      const error = { name: "ContractError", message: "Error code 5", code: 5, phase: "submit" };
      const result = redactErrorForLog(error);
      expect(result.name).toBe("ContractError");
      expect(result.code).toBe(5);
      expect(result.phase).toBe("submit");
    });

    it("handles non-Error objects", () => {
      const result = redactErrorForLog("some error string");
      expect(result.name).toBe("UnknownError");
      expect(result.message).toBe("some error string");
    });

    it("redacts stack traces", () => {
      const error = new Error("test");
      error.stack = "Error: test\n    at Object.<anonymous> (GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ)";
      const result = redactErrorForLog(error);
      expect(result.stack).not.toContain("GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ");
    });
  });

  describe("safeWalletId", () => {
    it("returns masked wallet identifier", () => {
      const result = safeWalletId("GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ");
      expect(result).toBe("wallet:GALC...CFXYZ");
    });

    it("returns fallback for short addresses", () => {
      expect(safeWalletId("GABC")).toBe("wallet:unknown");
    });

    it("returns fallback for empty address", () => {
      expect(safeWalletId("")).toBe("wallet:unknown");
    });
  });

  describe("safeContactId", () => {
    it("returns masked contact identifier", () => {
      const result = safeContactId("contact-uuid-12345");
      expect(result).toBe("contact:contact-u");
    });

    it("returns fallback for empty id", () => {
      expect(safeContactId("")).toBe("contact:unknown");
    });
  });

  describe("safeLogError", () => {
    it("logs redacted error to console.error", () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const error = new Error("Failed for GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ");

      safeLogError("contacts", error, { walletId: "GALC" });

      expect(consoleSpy).toHaveBeenCalledWith(
        "[contacts]",
        expect.objectContaining({
          name: "Error",
          message: expect.not.stringContaining("GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ"),
        }),
      );

      consoleSpy.mockRestore();
    });
  });
});
