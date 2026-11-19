/**
 * transparency.ts
 *
 * Backend route for protocol revenue & token burn aggregation.
 *
 * GET /api/transparency/summary
 *   Returns cumulative protocol fees, total burned tokens,
 *   deflationary ratio, and 30-day historical series.
 *
 * Boundary-value handling (#1914): all derived values use checked,
 * finite arithmetic with documented rounding. Totals are summed with
 * overflow guards, deflationary ratio floors to two decimal places and
 * saturates at 100%, and non-finite or negative history values are
 * rejected before they can poison the cache. A failed aggregation never
 * overwrites a previously cached snapshot.
 *
 * Data is cached for 60 seconds to avoid expensive on-chain queries
 * on every page load.
 */
import { Router, Request, Response } from "express";
import {
  failoverIncidentHistoryService,
  FailoverIncidentValidationError,
} from "../services/failoverIncidentHistoryService";

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

// ── Checked arithmetic helpers ────────────────────────────────────────────

export const MAX_TRANSPARENCY_VALUE = Number.MAX_SAFE_INTEGER - 1;

export class TransparencyCalculationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TransparencyCalculationError";
    }
}

/** Round to two decimal places (half-up), rejecting non-finite input. */
export function roundToTwoDecimals(value: number): number {
    if (!Number.isFinite(value)) {
        throw new TransparencyCalculationError("value must be finite");
    }
    return Math.round(value * 100) / 100;
}

/** Checked addition for non-negative finite values. */
export function checkedAdd(a: number, b: number): number {
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new TransparencyCalculationError("addends must be finite");
    }
    if (a < 0 || b < 0) {
        throw new TransparencyCalculationError("addends must be non-negative");
    }
    const result = a + b;
    if (!Number.isFinite(result) || result > MAX_TRANSPARENCY_VALUE) {
        throw new TransparencyCalculationError("addition would overflow safe integer range");
    }
    return result;
}

/**
 * Checked sum of an array of non-negative finite values. Throws instead of
 * returning NaN/Infinity so a corrupt entry can never poison totals.
 */
export function checkedSum(values: number[]): number {
    let total = 0;
    for (const v of values) {
        total = checkedAdd(total, v);
    }
    return total;
}

/**
 * Deflationary ratio = burned / emissions * 100, rounded half-up to 2dp.
 * Zero emissions returns 0; burned > emissions saturates at 100%.
 * Any non-finite or negative input throws.
 */
export function computeDeflationaryRatio(totalBurnedTokens: number, totalEmissions: number): number {
    if (!Number.isFinite(totalBurnedTokens) || !Number.isFinite(totalEmissions)) {
        throw new TransparencyCalculationError("burned and emissions must be finite");
    }
    if (totalBurnedTokens < 0 || totalEmissions < 0) {
        throw new TransparencyCalculationError("burned and emissions must be non-negative");
    }
    if (totalEmissions === 0) return 0;
    const raw = (totalBurnedTokens / totalEmissions) * 100;
    if (!Number.isFinite(raw)) {
        throw new TransparencyCalculationError("ratio calculation overflowed");
    }
    return Math.min(100, roundToTwoDecimals(raw));
}

/**
 * Validate a single history entry: finite non-negative amounts.
 * Returns a sanitized copy or throws TransparencyCalculationError.
 */
export function assertValidHistoryPoint(point: { date: string; revenue: number; burned: number }): void {
    if (typeof point.date !== "string" || point.date.length === 0) {
        throw new TransparencyCalculationError("history date must be a non-empty string");
    }
    for (const key of ["revenue", "burned"] as const) {
        const v = point[key];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
            throw new TransparencyCalculationError(`history ${key} must be finite and non-negative`);
        }
        if (v > MAX_TRANSPARENCY_VALUE) {
            throw new TransparencyCalculationError(`history ${key} exceeds safe maximum`);
        }
    }
}

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
        const point = {
            date: dateStr,
            revenue: roundToTwoDecimals(baseRevenue * (1 + noise)),
            burned: roundToTwoDecimals(baseBurned * (1 + noise / 2)),
        };
        assertValidHistoryPoint(point);
        history.push(point);
    }

    const totalRevenueLumens = checkedSum(history.map((h) => h.revenue));
    const totalBurnedTokens = checkedSum(history.map((h) => h.burned));

    // Emission rate mock: 10_000 YIELD/day × 30 days
    const totalEmissions = 10_000 * 30;
    const deflationaryRatio = computeDeflationaryRatio(totalBurnedTokens, totalEmissions);

    // Only replace the cache after every checked computation has succeeded;
    // a failure leaves the previous snapshot intact for safe retry.
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
const handleSummary = async (_req: Request, res: Response): Promise<void> => {
    try {
        const data = await aggregateTransparencyData();
        const { cachedAt: _omit, ...payload } = data;
        res.json(payload);
    } catch (err) {
        console.error("Failed to aggregate transparency data", err);
        // Fall back to the last good snapshot if one exists; do not expose
        // a poisoned partial result. Callers can safely retry.
        if (cache) {
            const { cachedAt: _omit, ...payload } = cache;
            res.json(payload);
            return;
        }
        res.status(500).json({ error: "Unable to fetch transparency data." });
    }
};

transparencyRouter.get("/", handleSummary);
transparencyRouter.get("/summary", handleSummary);

/**
 * GET /api/transparency/failover-history
 *
 * Returns the in-memory failover incident history, newest first.
 * Optional query param: ?protocolId=<id>
 */
transparencyRouter.get(
  "/failover-history",
  (req: Request, res: Response): void => {
    const protocolId = req.query.protocolId as string | undefined;
    res.json({ incidents: failoverIncidentHistoryService.getHistory(protocolId) });
  },
);

/**
 * POST /api/transparency/failover-history
 *
 * Record a new failover incident.
 * Body: { protocolId, protocolName, reasons, startedAt? }
 */
transparencyRouter.post(
  "/failover-history",
  (req: Request, res: Response): void => {
    const { protocolId, protocolName, reasons, startedAt } = req.body as {
      protocolId?: string;
      protocolName?: string;
      reasons?: string[];
      startedAt?: string;
    };
    if (!protocolId || !protocolName || !Array.isArray(reasons)) {
      res.status(400).json({ error: "protocolId, protocolName, and reasons are required." });
      return;
    }
    try {
      const incident = failoverIncidentHistoryService.recordIncident({
        protocolId,
        protocolName,
        reasons,
        startedAt,
      });
      res.status(201).json(incident);
    } catch (error) {
      if (error instanceof FailoverIncidentValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

/**
 * POST /api/transparency/failover-history/:protocolId/resolve
 *
 * Mark the most recent open incident for a protocol as resolved.
 */
transparencyRouter.post(
  "/failover-history/:protocolId/resolve",
  (req: Request, res: Response): void => {
    const { recoveredAt } = req.body as { recoveredAt?: string };
    let incident: ReturnType<typeof failoverIncidentHistoryService.resolveIncident>;
    try {
      incident = failoverIncidentHistoryService.resolveIncident(
        req.params.protocolId,
        recoveredAt,
      );
    } catch (error) {
      if (error instanceof FailoverIncidentValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
    if (!incident) {
      res.status(404).json({ error: "No open incident found for this protocol." });
      return;
    }
    res.json(incident);
  },
);

export { aggregateTransparencyData };
export default transparencyRouter;
