/**
 * donations.ts
 *
 * Backend route for the Yield for Good / Auto-Donate feature.
 *
 * GET  /api/donations/config/:address — fetch user donation config
 * POST /api/donations/set             — update user donation config
 * POST /api/donations/preview         — preview donation amount (rejects zero/dust)
 * GET  /api/donations/total           — protocol-wide total donated
 * GET  /api/donations/summary         — aggregate donation metrics
 * POST /api/donations/preview         — structured contract execution preview
 */
import { Router, Request, Response } from "express";
import { buildDonationPreview } from "../services/donationsService";

const donationsRouter = Router();

// ── In-memory store (replace with DB in production) ──────────────────────

interface UserDonationConfig {
    bps: number;
    charityAddress: string;
    charityId: string | null;
}

const userConfigs = new Map<string, UserDonationConfig>();
let totalDonated = 0;

// ── Donation validation (mirrors contracts/yield_vault/src/donations.rs) ──

/**
 * Minimum economically meaningful donation amount in stroops.
 * Mirrors `MIN_DONATION_AMOUNT` in the yield vault contract.
 */
export const MIN_DONATION_AMOUNT = 1_000_000;

const BPS_DENOMINATOR = 10_000;

/**
 * Validation messages shared with the client layer. Keep the wording in
 * sync with the contract's donation error copy in
 * `client/src/utils/errorDecoder.ts` (error code 2007 → "Donation Below
 * Minimum") so validation is consistent across layers.
 */
export const DONATION_VALIDATION_MESSAGES = {
    yieldAmountInvalid: "yieldAmount must be a positive number.",
    noDonationConfigured:
        "No donation is configured for this wallet. Set a donation split before previewing.",
    zeroValue: "Donation amount must be greater than zero.",
    dustValue: "Donation amount is below the minimum (dust).",
} as const;

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/donations/config/:address
 *
 * Returns the current donation configuration for a wallet address.
 */
donationsRouter.get(
    "/config/:address",
    (req: Request, res: Response): void => {
        const { address } = req.params;
        const config = userConfigs.get(address);
        if (!config) {
            res.json({ bps: 0, charityId: null });
            return;
        }
        res.json({ bps: config.bps, charityId: config.charityId });
    },
);

/**
 * POST /api/donations/set
 *
 * Set or update the donation split for a wallet.
 *
 * Body: { address: string, bps: number, charityAddress: string }
 */
donationsRouter.post("/set", (req: Request, res: Response): void => {
    const { address, bps, charityAddress } = req.body as {
        address?: string;
        bps?: number;
        charityAddress?: string;
    };

    if (!address || typeof address !== "string") {
        res.status(400).json({ error: "address is required" });
        return;
    }
    if (typeof bps !== "number" || bps < 0 || bps > 10_000) {
        res.status(400).json({ error: "bps must be between 0 and 10000" });
        return;
    }
    if (!charityAddress || typeof charityAddress !== "string") {
        res.status(400).json({ error: "charityAddress is required" });
        return;
    }

    userConfigs.set(address, {
        bps,
        charityAddress,
        charityId: null, // resolved client-side
    });

    res.json({ success: true });
});

/**
 * POST /api/donations/preview
 *
 * Preview the donation amount that would be routed for a given yield amount,
 * rejecting zero-value and dust-value inputs before they reach the contract
 * as unusable transactions.
 *
 * Body: { address: string, yieldAmount: number }
 *
 * Responses:
 *   200 — { donationAmount, bps, charityAddress }
 *   400 — validation error with an aligned message (DONATION_VALIDATION_MESSAGES)
 */
donationsRouter.post("/preview", (req: Request, res: Response): void => {
    const { address, yieldAmount } = req.body as {
        address?: string;
        yieldAmount?: number;
    };

    if (!address || typeof address !== "string") {
        res.status(400).json({ error: "address is required" });
        return;
    }
    if (
        typeof yieldAmount !== "number" ||
        !Number.isFinite(yieldAmount) ||
        yieldAmount <= 0
    ) {
        res.status(400).json({
            error: DONATION_VALIDATION_MESSAGES.yieldAmountInvalid,
        });
        return;
    }

    const config = userConfigs.get(address);
    const bps = config?.bps ?? 0;
    if (!config || bps <= 0) {
        res.status(400).json({
            error: DONATION_VALIDATION_MESSAGES.noDonationConfigured,
        });
        return;
    }

    // Floor division mirrors the contract's integer math: (yield * bps) / 10_000.
    const donationAmount = Math.floor((yieldAmount * bps) / BPS_DENOMINATOR);

    if (donationAmount <= 0) {
        res.status(400).json({ error: DONATION_VALIDATION_MESSAGES.zeroValue });
        return;
    }
    if (donationAmount < MIN_DONATION_AMOUNT) {
        res.status(400).json({ error: DONATION_VALIDATION_MESSAGES.dustValue });
        return;
    }

    res.json({
        donationAmount,
        bps,
        charityAddress: config.charityAddress,
    });
});

/**
 * GET /api/donations/total
 *
 * Returns the protocol-wide cumulative donated token amount.
 */
donationsRouter.get("/total", (_req: Request, res: Response): void => {
    res.json({ totalDonated });
});

/**
 * GET /api/donations/summary
 *
 * Returns aggregate donation metrics: total donated, active vaults, and monthly projection.
 */
donationsRouter.get("/summary", (_req: Request, res: Response): void => {
    const participatingVaults = Array.from(userConfigs.values()).filter(
        (c) => c.bps > 0,
    ).length;

    // Mocked projected monthly impact based on active donors
    // In a real app, this would use current TVL and yield data.
    const projectedMonthlyImpact = participatingVaults * 150.5;

    res.json({
        totalDonated,
        participatingVaults,
        projectedMonthlyImpact,
    });
});

/**
 * POST /api/donations/preview
 *
 * Generates a structured donation preview that details the recipient address,
 * fee breakdown (gross amount, donation amount, net amount), and memo that will
 * be submitted to the contract upon signing.  Invalid previews are rejected
 * with HTTP 422 so callers know not to proceed to submission.
 *
 * Body:
 *   senderAddress      string   — donor wallet (Stellar public key)
 *   recipientAddress   string   — charity wallet (Stellar public key)
 *   grossAmountStroops number   — total yield amount in stroops
 *   bps                number   — donation rate in basis points (0–10 000)
 *   memo               string?  — optional transaction memo (≤ 28 bytes)
 */
donationsRouter.post("/preview", (req: Request, res: Response): void => {
    const {
        senderAddress,
        recipientAddress,
        grossAmountStroops,
        bps,
        memo,
    } = req.body as {
        senderAddress?: unknown;
        recipientAddress?: unknown;
        grossAmountStroops?: unknown;
        bps?: unknown;
        memo?: unknown;
    };

    const preview = buildDonationPreview({
        senderAddress: senderAddress as string,
        recipientAddress: recipientAddress as string,
        grossAmountStroops: grossAmountStroops as number,
        bps: bps as number,
        memo: memo as string | undefined,
    });

    if (!preview.isValid) {
        res.status(422).json({
            error: "Invalid donation preview",
            validationErrors: preview.validationErrors,
        });
        return;
    }

    res.json(preview);
});

/** Exposed for testing: reset in-memory state. */
export function _resetDonationsStore() {
    userConfigs.clear();
    totalDonated = 0;
}

export default donationsRouter;
