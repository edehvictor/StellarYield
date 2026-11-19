/**
 * donationsService.ts
 *
 * Business logic for donation contract previews.
 * Generates structured previews that show the recipient, fee, and memo
 * breakdown before a user submits a donation transaction for signing.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum basis points allowed (100% = 10 000 bps). */
export const MAX_BPS = 10_000;

/** Minimum Stellar address length (encoded public key). */
const STELLAR_ADDRESS_MIN_LEN = 10;

/** Maximum memo byte length enforced by the Stellar protocol. */
export const STELLAR_MEMO_MAX_BYTES = 28;

/**
 * Control characters rejected from memo text (#1106).
 *
 * Stellar's `MEMO_TEXT` type stores up to 28 raw bytes and does not itself
 * restrict which bytes those are — the protocol only enforces the length
 * limit (verified against this codebase's other memo byte-length check
 * above, and against `client/src/features/offramp/offRampService.ts`'s
 * self-generated, ASCII-only memos, neither of which do charset
 * filtering). Submitting C0 control characters (0x00–0x1F) or DEL (0x7F)
 * in a memo is still rejected here as "malformed": a null byte, newline,
 * or other control character in a memo does not fail on-chain but breaks
 * rendering in UIs/explorers/logs and has no legitimate use in a
 * human-readable donation note, so it's treated as an unsupported memo
 * format rather than a valid-but-unusual one.
 */
// eslint-disable-next-line no-control-regex
const MEMO_CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;

// ── Types ────────────────────────────────────────────────────────────────────

export interface DonationPreviewInput {
    /** Donor wallet address (Stellar public key). */
    senderAddress: string;
    /** Charity / recipient wallet address (Stellar public key). */
    recipientAddress: string;
    /** Gross yield amount in the asset's smallest representable unit (e.g. stroops). */
    grossAmountStroops: number;
    /** Donation percentage expressed in basis points (0–10 000). */
    bps: number;
    /** Optional memo text to attach to the contract transaction. */
    memo?: string;
}

export interface DonationFeeBreakdown {
    /** Gross yield amount before the donation cut. */
    grossAmountStroops: number;
    /** Amount allocated to the charity in stroops. */
    donationAmountStroops: number;
    /** Amount retained by the donor (gross minus donation). */
    netAmountStroops: number;
    /** Effective donation rate expressed as a decimal (bps / 10 000). */
    effectiveRate: number;
}

export interface DonationPreview {
    /** Address of the sender who configured the donation. */
    senderAddress: string;
    /** Address that will receive the donated funds. */
    recipientAddress: string;
    /** Donation split in basis points (0–10 000). */
    bps: number;
    /** Memo that will be attached to the contract transaction (empty string if none). */
    memo: string;
    /** Detailed fee and amount breakdown. */
    breakdown: DonationFeeBreakdown;
    /** Whether this preview passes all contract-level validation rules. */
    isValid: boolean;
    /** List of validation error messages; empty array when isValid is true. */
    validationErrors: string[];
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validates a donation preview input against contract-level rules.
 *
 * Rules enforced:
 *  1. `senderAddress` must be a non-empty string of sufficient length.
 *  2. `recipientAddress` must be a non-empty string of sufficient length.
 *  3. `bps` must be an integer in [0, MAX_BPS].
 *  4. `grossAmountStroops` must be a positive integer.
 *  5. `memo` (if provided) must not exceed STELLAR_MEMO_MAX_BYTES bytes.
 *  6. `memo` (if provided) must not contain control characters (see
 *     {@link MEMO_CONTROL_CHAR_PATTERN}) — an empty string or an omitted/
 *     null memo is valid (treated as "no memo"), only actual control-byte
 *     content is rejected as malformed.
 *
 * @returns Array of human-readable error messages. Empty if all rules pass.
 */
export function validateDonationPreviewInput(
    input: DonationPreviewInput,
): string[] {
    const errors: string[] = [];

    // Sender address
    if (
        !input.senderAddress ||
        typeof input.senderAddress !== "string" ||
        input.senderAddress.trim().length < STELLAR_ADDRESS_MIN_LEN
    ) {
        errors.push(
            `senderAddress must be a valid Stellar address (min ${STELLAR_ADDRESS_MIN_LEN} chars)`,
        );
    }

    // Recipient address
    if (
        !input.recipientAddress ||
        typeof input.recipientAddress !== "string" ||
        input.recipientAddress.trim().length < STELLAR_ADDRESS_MIN_LEN
    ) {
        errors.push(
            `recipientAddress must be a valid Stellar address (min ${STELLAR_ADDRESS_MIN_LEN} chars)`,
        );
    }

    // BPS range
    if (
        typeof input.bps !== "number" ||
        !Number.isInteger(input.bps) ||
        input.bps < 0 ||
        input.bps > MAX_BPS
    ) {
        errors.push(`bps must be an integer between 0 and ${MAX_BPS}`);
    }

    // Gross amount
    if (
        typeof input.grossAmountStroops !== "number" ||
        !Number.isInteger(input.grossAmountStroops) ||
        input.grossAmountStroops <= 0
    ) {
        errors.push("grossAmountStroops must be a positive integer");
    }

    // Memo byte length (Stellar protocol limit) and charset (#1106)
    if (input.memo !== undefined && input.memo !== null) {
        const memoBytes = Buffer.byteLength(input.memo, "utf8");
        if (memoBytes > STELLAR_MEMO_MAX_BYTES) {
            errors.push(
                `memo exceeds maximum allowed byte length of ${STELLAR_MEMO_MAX_BYTES} bytes (got ${memoBytes})`,
            );
        }
        if (MEMO_CONTROL_CHAR_PATTERN.test(input.memo)) {
            errors.push(
                "memo contains unsupported control characters; memo must be human-readable text",
            );
        }
    }

    return errors;
}

// ── Preview Generation ───────────────────────────────────────────────────────

/**
 * Computes the fee/amount breakdown for a donation.
 */
function computeBreakdown(
    grossAmountStroops: number,
    bps: number,
): DonationFeeBreakdown {
    const donationAmountStroops = Math.floor(
        (grossAmountStroops * bps) / MAX_BPS,
    );
    const netAmountStroops = grossAmountStroops - donationAmountStroops;
    const effectiveRate = bps / MAX_BPS;

    return {
        grossAmountStroops,
        donationAmountStroops,
        netAmountStroops,
        effectiveRate,
    };
}

/**
 * Builds a structured donation preview containing the recipient, fee breakdown,
 * and memo that will be submitted to the contract upon signing.
 *
 * Validation is always run; the `isValid` flag and `validationErrors` array
 * on the returned preview tell the caller whether submission should proceed.
 *
 * @param input - Donation preview parameters.
 * @returns A fully populated `DonationPreview` object.
 */
export function buildDonationPreview(
    input: DonationPreviewInput,
): DonationPreview {
    const validationErrors = validateDonationPreviewInput(input);
    const isValid = validationErrors.length === 0;

    // Compute breakdown with safe defaults so the shape is always populated
    const safeGross =
        isValid && Number.isInteger(input.grossAmountStroops)
            ? input.grossAmountStroops
            : 0;
    const safeBps =
        isValid && Number.isInteger(input.bps) ? input.bps : 0;
    const breakdown = computeBreakdown(safeGross, safeBps);

    const memo =
        input.memo !== undefined && input.memo !== null ? input.memo : "";

    return {
        senderAddress: input.senderAddress ?? "",
        recipientAddress: input.recipientAddress ?? "",
        bps: input.bps ?? 0,
        memo,
        breakdown,
        isValid,
        validationErrors,
    };
}
