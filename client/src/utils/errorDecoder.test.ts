/**
 * errorDecoder.test.ts
 *
 * Unit tests for the Soroban error decoder utility.
 * Target: ≥ 90 % line / statement / function coverage.
 */
import { describe, it, expect } from "vitest";
import { decodeTransactionError, extractErrorCode } from "./errorDecoder";

// ── extractErrorCode ─────────────────────────────────────────────────────

describe("extractErrorCode", () => {
    it("parses Soroban SDK format: Error(Contract, #4)", () => {
        expect(extractErrorCode("Error(Contract, #4)")).toBe(4);
    });

    it("parses Soroban SDK format without #: Error(Contract, 10)", () => {
        expect(extractErrorCode("Error(Contract, 10)")).toBe(10);
    });

    it("parses simplified format: Error(1001)", () => {
        expect(extractErrorCode("WasmVm error: Error(1001)")).toBe(1001);
    });

    it("parses indexer label format: contract_code:7", () => {
        expect(extractErrorCode("contract_code:7")).toBe(7);
    });

    it("parses indexer label format with spaces: contract_code : 2002", () => {
        expect(extractErrorCode("contract_code : 2002")).toBe(2002);
    });

    it("parses JSON structured payload with code field", () => {
        expect(extractErrorCode(JSON.stringify({ code: 9 }))).toBe(9);
    });

    it("returns undefined for unknown formats", () => {
        expect(extractErrorCode("some random error")).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
        expect(extractErrorCode("")).toBeUndefined();
    });

    it("ignores JSON without numeric code", () => {
        expect(extractErrorCode(JSON.stringify({ code: "foo" }))).toBeUndefined();
    });

    it("ignores malformed JSON gracefully", () => {
        expect(extractErrorCode("{code: broken}")).toBeUndefined();
    });
});

// ── decodeTransactionError ───────────────────────────────────────────────

describe("decodeTransactionError", () => {
    it("decodes known VaultError code 3 → ZeroAmount", () => {
        const result = decodeTransactionError("Error(Contract, #3)");
        expect(result.code).toBe(3);
        expect(result.title).toBe("Zero Amount");
        expect(result.message).toContain("greater than zero");
        expect(result.suggestion).toBeTruthy();
        expect(result.raw).toBe("Error(Contract, #3)");
    });

    it("decodes known VaultError code 7 → Vault Paused", () => {
        const result = decodeTransactionError("Error(Contract, #7)");
        expect(result.code).toBe(7);
        expect(result.title).toBe("Vault Paused");
    });

    it("decodes known VaultError code 10 → Slippage Exceeded", () => {
        const result = decodeTransactionError("Error(Contract, #10)");
        expect(result.code).toBe(10);
        expect(result.title).toBe("Slippage Exceeded");
    });

    it("decodes vesting error 1001 → No Vesting Schedule", () => {
        const result = decodeTransactionError("Error(1001)");
        expect(result.code).toBe(1001);
        expect(result.title).toBe("No Vesting Schedule");
    });

    it("decodes vesting error 1002 → Nothing to Claim", () => {
        const result = decodeTransactionError("contract_code:1002");
        expect(result.code).toBe(1002);
        expect(result.title).toBe("Nothing to Claim");
    });

    it("decodes vesting error 1003 → Already Claimed", () => {
        const result = decodeTransactionError(JSON.stringify({ code: 1003 }));
        expect(result.code).toBe(1003);
        expect(result.title).toBe("Already Claimed");
    });

    it("decodes donation error 2001 → Invalid Donation Percentage", () => {
        const result = decodeTransactionError("Error(Contract, #2001)");
        expect(result.code).toBe(2001);
        expect(result.title).toBe("Invalid Donation Percentage");
    });

    it("decodes donation error 2002 → Charity Not Whitelisted", () => {
        const result = decodeTransactionError("Error(Contract, #2002)");
        expect(result.code).toBe(2002);
        expect(result.title).toBe("Charity Not Whitelisted");
    });

    it("decodes swap error 3001 → Insufficient Balance for Swap", () => {
        const result = decodeTransactionError("Error(Contract, #3001)");
        expect(result.code).toBe(3001);
        expect(result.title).toBe("Insufficient Balance for Swap");
    });

    it("decodes swap error 3002 → Order Expired", () => {
        const result = decodeTransactionError("Error(Contract, #3002)");
        expect(result.code).toBe(3002);
        expect(result.title).toBe("Order Expired");
    });

    it("handles user-rejected transaction", () => {
        const result = decodeTransactionError("User declined signing the transaction");
        expect(result.title).toBe("Transaction Cancelled");
        expect(result.suggestion).toContain("Freighter");
    });

    it("handles user cancelled (alternate wording)", () => {
        const result = decodeTransactionError("Transaction cancelled by user");
        expect(result.title).toBe("Transaction Cancelled");
    });

    it("handles insufficient funds error", () => {
        const result = decodeTransactionError("insufficient funds to pay fee");
        expect(result.title).toBe("Insufficient Funds");
        expect(result.suggestion).toContain("XLM");
    });

    it("handles network / timeout error", () => {
        const result = decodeTransactionError("fetch timeout reached");
        expect(result.title).toBe("Network Error");
    });

    it("returns generic fallback for unrecognised error", () => {
        const result = decodeTransactionError("some completely unknown problem");
        expect(result.title).toBe("Transaction Failed");
        expect(result.raw).toBe("some completely unknown problem");
        expect(result.message).toBeTruthy();
        expect(result.suggestion).toBeTruthy();
    });

    it("handles empty string without throwing", () => {
        const result = decodeTransactionError("");
        expect(result.title).toBeTruthy();
        expect(result.raw).toBe("");
    });

    it("preserves raw string on known error", () => {
        const raw = "Error(Contract, #5)";
        const result = decodeTransactionError(raw);
        expect(result.raw).toBe(raw);
    });

    it("decodes all vault error codes 1–10", () => {
        const knownTitles: Record<number, string> = {
            1: "Contract Not Initialized",
            2: "Already Initialized",
            3: "Zero Amount",
            4: "Insufficient Shares",
            5: "Unauthorised",
            6: "Zero Supply",
            7: "Vault Paused",
            8: "Timelock Active",
            9: "Invalid Oracle Price",
            10: "Slippage Exceeded",
        };
        for (const [code, title] of Object.entries(knownTitles)) {
            const result = decodeTransactionError(`Error(Contract, #${code})`);
            expect(result.title).toBe(title);
            expect(result.code).toBe(Number(code));
        }
    });
});
