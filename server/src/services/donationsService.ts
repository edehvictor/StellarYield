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

    // Memo byte length (Stellar protocol limit)
    if (input.memo !== undefined && input.memo !== null) {
        const memoBytes = Buffer.byteLength(input.memo, "utf8");
        if (memoBytes > STELLAR_MEMO_MAX_BYTES) {
            errors.push(
                `memo exceeds maximum allowed byte length of ${STELLAR_MEMO_MAX_BYTES} bytes (got ${memoBytes})`,
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
