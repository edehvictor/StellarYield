/**
 * Tests for donationsService.ts's memo validation (#1106), covering the
 * pure `validateDonationPreviewInput` / `buildDonationPreview` functions
 * directly (route-level coverage lives in donations.test.ts).
 */
import {
    validateDonationPreviewInput,
    buildDonationPreview,
    STELLAR_MEMO_MAX_BYTES,
    type DonationPreviewInput,
} from "../services/donationsService";

const VALID_INPUT: DonationPreviewInput = {
    senderAddress: "GABC1DEF2GHI3JKLMNOPQRSTUVWXYZ",
    recipientAddress: "GBCD2EFG3HIJ4KLMNOPQRSTUVWXYZ12",
    grossAmountStroops: 1_000_000,
    bps: 500,
};

describe("validateDonationPreviewInput — memo validation", () => {
    it("accepts input with no memo", () => {
        const errors = validateDonationPreviewInput(VALID_INPUT);
        expect(errors).toEqual([]);
    });

    it("accepts an empty memo string (treated as no memo)", () => {
        const errors = validateDonationPreviewInput({ ...VALID_INPUT, memo: "" });
        expect(errors).toEqual([]);
    });

    it("accepts a null memo (treated as no memo)", () => {
        const errors = validateDonationPreviewInput({
            ...VALID_INPUT,
            memo: null as unknown as string,
        });
        expect(errors).toEqual([]);
    });

    it("accepts a normal human-readable memo", () => {
        const errors = validateDonationPreviewInput({ ...VALID_INPUT, memo: "Thank you!" });
        expect(errors).toEqual([]);
    });

    it("accepts a memo exactly at the byte limit", () => {
        const memo = "A".repeat(STELLAR_MEMO_MAX_BYTES);
        const errors = validateDonationPreviewInput({ ...VALID_INPUT, memo });
        expect(errors).toEqual([]);
    });

    it("rejects an oversized (29-byte) ASCII memo", () => {
        const memo = "A".repeat(STELLAR_MEMO_MAX_BYTES + 1);
        const errors = validateDonationPreviewInput({ ...VALID_INPUT, memo });
        expect(errors).toEqual(
            expect.arrayContaining([expect.stringContaining("memo exceeds maximum")]),
        );
    });

    it("rejects an oversized multi-byte UTF-8 memo even when character count is under 28", () => {
        // 10 '€' chars = 10 UTF-16 code units but 30 UTF-8 bytes.
        const memo = "€".repeat(10);
        const errors = validateDonationPreviewInput({ ...VALID_INPUT, memo });
        expect(errors).toEqual(
            expect.arrayContaining([expect.stringContaining("memo exceeds maximum")]),
        );
    });

    it("rejects a memo containing a null byte (malformed)", () => {
        const errors = validateDonationPreviewInput({ ...VALID_INPUT, memo: "gift\x00" });
        expect(errors).toEqual(
            expect.arrayContaining([expect.stringContaining("control characters")]),
        );
    });

    it("rejects a memo containing a newline (malformed)", () => {
        const errors = validateDonationPreviewInput({ ...VALID_INPUT, memo: "line1\nline2" });
        expect(errors).toEqual(
            expect.arrayContaining([expect.stringContaining("control characters")]),
        );
    });

    it("rejects a memo containing a tab character (malformed)", () => {
        const errors = validateDonationPreviewInput({ ...VALID_INPUT, memo: "a\tb" });
        expect(errors).toEqual(
            expect.arrayContaining([expect.stringContaining("control characters")]),
        );
    });

    it("rejects a memo containing the DEL control character (malformed)", () => {
        const errors = validateDonationPreviewInput({ ...VALID_INPUT, memo: "gift\x7F" });
        expect(errors).toEqual(
            expect.arrayContaining([expect.stringContaining("control characters")]),
        );
    });

    it("reports both length and charset errors when a memo is both oversized and malformed", () => {
        const memo = "\x00".repeat(STELLAR_MEMO_MAX_BYTES + 1);
        const errors = validateDonationPreviewInput({ ...VALID_INPUT, memo });
        expect(errors).toEqual(
            expect.arrayContaining([
                expect.stringContaining("memo exceeds maximum"),
                expect.stringContaining("control characters"),
            ]),
        );
    });

    it("accepts emoji and other printable multi-byte characters within the byte limit", () => {
        const errors = validateDonationPreviewInput({ ...VALID_INPUT, memo: "Thanks! 🙏" });
        expect(errors).toEqual([]);
    });
});

describe("buildDonationPreview — memo malformed handling", () => {
    it("marks the preview invalid and surfaces the memo error for a control-character memo", () => {
        const preview = buildDonationPreview({ ...VALID_INPUT, memo: "bad\x00memo" });
        expect(preview.isValid).toBe(false);
        expect(preview.validationErrors).toEqual(
            expect.arrayContaining([expect.stringContaining("control characters")]),
        );
    });

    it("still echoes the raw memo text back on the invalid preview for client display", () => {
        const preview = buildDonationPreview({ ...VALID_INPUT, memo: "bad\x00memo" });
        expect(preview.memo).toBe("bad\x00memo");
    });
});
