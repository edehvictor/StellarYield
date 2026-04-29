/**
 * transparency.ts
 *
 * Backend route for protocol revenue & token burn aggregation.
 *
 * GET /api/transparency/summary
 *   Returns cumulative protocol fees, total burned tokens,
 *   deflationary ratio, and 30-day historical series.
 *
 * Data is cached for 60 seconds to avoid expensive on-chain queries
 * on every page load.
 */
import { Router, Request, Response } from "express";

const transparencyRouter = Router();

// ── In-memory cache ───────────────────────────────────────────────────────

interface TransparencyData {
    totalRevenueLumens: number;
    totalBurnedTokens: number;
    deflationaryRatio: number;
    history: Array<{ date: string; revenue: number; burned: number }>;
    cachedAt: number;
}

let cache: TransparencyData | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

// ── Data aggregation ─────────────────────────────────────────────────────

/**
 * Aggregates protocol revenue and burn metrics.
 *
 * In production this would query PostgreSQL and the Stellar Horizon API.
 * We return seeded deterministic data derived from the current date so
 * tests and the dashboard always have realistic numbers.
 *
 * @returns Aggregated transparency metrics.
 */
async function aggregateTransparencyData(): Promise<TransparencyData> {
    if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
        return cache;
    }

    // ── Build 30-day history ──────────────────────────────────────────────
    const history: Array<{ date: string; revenue: number; burned: number }> = [];
    const baseRevenue = 12_400; // USDC equivalent
    const baseBurned = 3_200;   // YIELD tokens

    for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split("T")[0];
        // Deterministic noise seeded by day index
        const noise = (((i * 17 + 7) % 13) - 6) / 100;
        history.push({
            date: dateStr,
            revenue: Math.round(baseRevenue * (1 + noise) * 100) / 100,
            burned: Math.round(baseBurned * (1 + noise / 2) * 100) / 100,
        });
    }

    const totalRevenueLumens = history.reduce((s, h) => s + h.revenue, 0);
    const totalBurnedTokens = history.reduce((s, h) => s + h.burned, 0);

    // Emission rate mock: 10_000 YIELD/day × 30 days
    const totalEmissions = 10_000 * 30;
    const deflationaryRatio =
        totalEmissions > 0
            ? Math.round((totalBurnedTokens / totalEmissions) * 10_000) / 100
            : 0;

    cache = {
        totalRevenueLumens,
        totalBurnedTokens,
        deflationaryRatio,
        history,
        cachedAt: Date.now(),
    };

    return cache;
}

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/transparency/summary
 *
 * Returns protocol revenue and token burn metrics.
 * Cached for 60 seconds.
 */
transparencyRouter.get(
    "/summary",
    async (_req: Request, res: Response): Promise<void> => {
        try {
            const data = await aggregateTransparencyData();
            const { cachedAt: _omit, ...payload } = data;
            res.json(payload);
        } catch (err) {
            console.error("Failed to aggregate transparency data", err);
            res.status(500).json({ error: "Unable to fetch transparency data." });
        }
    },
);

export { aggregateTransparencyData };
export default transparencyRouter;
