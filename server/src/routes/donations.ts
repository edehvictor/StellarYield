/**
 * donations.ts
 *
 * Backend route for the Yield for Good / Auto-Donate feature.
 *
 * GET  /api/donations/config/:address — fetch user donation config
 * POST /api/donations/set             — update user donation config
 * GET  /api/donations/total           — protocol-wide total donated
 */
import { Router, Request, Response } from "express";

const donationsRouter = Router();

// ── In-memory store (replace with DB in production) ──────────────────────

interface UserDonationConfig {
    bps: number;
    charityAddress: string;
    charityId: string | null;
}

const userConfigs = new Map<string, UserDonationConfig>();
let totalDonated = 0;

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
 * GET /api/donations/total
 *
 * Returns the protocol-wide cumulative donated token amount.
 */
donationsRouter.get("/total", (_req: Request, res: Response): void => {
    res.json({ totalDonated });
});

/** Exposed for testing: reset in-memory state. */
export function _resetDonationsStore() {
    userConfigs.clear();
    totalDonated = 0;
}

export default donationsRouter;
