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
import { Router, type Request, type Response } from "express";
import {
  failoverIncidentHistoryService,
  FailoverIncidentValidationError,
} from "../services/failoverIncidentHistoryService";

const transparencyRouter = Router();

// ── In-memory cache ───────────────────────────────────────────────────────

export interface TransparencyHistoryPoint {
    date: string;
    revenue: number;
    burned: number;
}

export interface TransparencySummary {
    totalRevenueLumens: number;
    totalBurnedTokens: number;
    deflationaryRatio: number;
    history: TransparencyHistoryPoint[];
}

interface TransparencyData extends TransparencySummary {
    cachedAt: number;
}

export type ExternalTransparencySource = () => Promise<unknown> | unknown;

let cache: TransparencyData | null = null;
let externalDataSource: ExternalTransparencySource | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

// ── Checked arithmetic & boundary validation helpers ──────────────────────

export const MAX_TRANSPARENCY_VALUE = Number.MAX_SAFE_INTEGER - 1;

export type TransparencyErrorCode =
    | "MALFORMED_EXTERNAL_DATA"
    | "MALFORMED_HISTORY_POINT"
    | "INVALID_CALCULATION"
    | "INVALID_QUERY_PARAMETER"
    | "MALFORMED_INCIDENT_PAYLOAD";

export class TransparencyCalculationError extends Error {
    readonly code: TransparencyErrorCode;

    constructor(message: string, code: TransparencyErrorCode = "INVALID_CALCULATION") {
        super(message);
        this.name = "TransparencyCalculationError";
        this.code = code;
    }
}

export class TransparencyValidationError extends TransparencyCalculationError {
    constructor(message: string, code: TransparencyErrorCode = "MALFORMED_EXTERNAL_DATA") {
        super(message, code);
        this.name = "TransparencyValidationError";
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIsoCalendarDate(dateStr: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return false;
    }
    const parsed = new Date(`${dateStr}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateStr;
}

function cloneSummaryData(data: TransparencyData): TransparencyData {
    return {
        totalRevenueLumens: data.totalRevenueLumens,
        totalBurnedTokens: data.totalBurnedTokens,
        deflationaryRatio: data.deflationaryRatio,
        history: data.history.map((point) => ({ ...point })),
        cachedAt: data.cachedAt,
    };
}

/** Round to two decimal places (half-up), rejecting non-finite input. */
export function roundToTwoDecimals(value: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TransparencyCalculationError("value must be finite");
    }
    return Math.round(value * 100) / 100;
}

/** Checked addition for non-negative finite values. */
export function checkedAdd(a: number, b: number): number {
    if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) {
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
    if (!Array.isArray(values)) {
        throw new TransparencyValidationError("values must be an array", "MALFORMED_EXTERNAL_DATA");
    }
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
    if (
        typeof totalBurnedTokens !== "number" ||
        typeof totalEmissions !== "number" ||
        !Number.isFinite(totalBurnedTokens) ||
        !Number.isFinite(totalEmissions)
    ) {
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
 * Validate a single history entry: ISO calendar date and finite non-negative amounts.
 * Throws TransparencyValidationError / TransparencyCalculationError on invalid input.
 */
export function assertValidHistoryPoint(point: { date: string; revenue: number; burned: number }): void {
    if (!isPlainObject(point)) {
        throw new TransparencyValidationError("history point must be an object", "MALFORMED_HISTORY_POINT");
    }
    if (typeof point.date !== "string" || !isValidIsoCalendarDate(point.date)) {
        throw new TransparencyValidationError(
            "history date must be a valid YYYY-MM-DD date string",
            "MALFORMED_HISTORY_POINT",
        );
    }
    for (const key of ["revenue", "burned"] as const) {
        const v = point[key];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
            throw new TransparencyValidationError(
                `history ${key} must be finite and non-negative`,
                "MALFORMED_HISTORY_POINT",
            );
        }
        if (v > MAX_TRANSPARENCY_VALUE) {
            throw new TransparencyValidationError(
                `history ${key} exceeds safe maximum`,
                "MALFORMED_HISTORY_POINT",
            );
        }
    }
}

/**
 * Validate an untrusted history series at the boundary and return a clean,
 * rounded copy without mutating the caller's array or objects.
 */
export function validateExternalHistory(rawHistory: unknown): TransparencyHistoryPoint[] {
    if (!Array.isArray(rawHistory) || rawHistory.length === 0) {
        throw new TransparencyValidationError("history must be a non-empty array", "MALFORMED_EXTERNAL_DATA");
    }
    return rawHistory.map((item) => {
        if (!isPlainObject(item)) {
            throw new TransparencyValidationError("history point must be an object", "MALFORMED_HISTORY_POINT");
        }
        const rawDate = typeof item.date === "string" ? item.date.trim() : "";
        const rawRevenue = item.revenue;
        const rawBurned = item.burned;
        if (typeof rawRevenue !== "number" || typeof rawBurned !== "number") {
            throw new TransparencyValidationError(
                "history revenue and burned must be finite numbers",
                "MALFORMED_HISTORY_POINT",
            );
        }
        const candidate: TransparencyHistoryPoint = {
            date: rawDate,
            revenue: roundToTwoDecimals(rawRevenue),
            burned: roundToTwoDecimals(rawBurned),
        };
        assertValidHistoryPoint(candidate);
        return candidate;
    });
}

/**
 * Validate an untrusted external transparency payload at the boundary and
 * compute derived totals and deflationary ratio without mutating input or state.
 */
export function buildTransparencySummary(rawInput: unknown): TransparencySummary {
    if (!isPlainObject(rawInput)) {
        throw new TransparencyValidationError(
            "transparency data must be an object",
            "MALFORMED_EXTERNAL_DATA",
        );
    }
    const history = validateExternalHistory(rawInput.history);
    const rawEmissions = rawInput.totalEmissions === undefined ? 10_000 * 30 : rawInput.totalEmissions;
    if (
        typeof rawEmissions !== "number" ||
        !Number.isFinite(rawEmissions) ||
        rawEmissions < 0 ||
        rawEmissions > MAX_TRANSPARENCY_VALUE
    ) {
        throw new TransparencyValidationError(
            "totalEmissions must be a finite non-negative number",
            "MALFORMED_EXTERNAL_DATA",
        );
    }

    const totalRevenueLumens = roundToTwoDecimals(checkedSum(history.map((h) => h.revenue)));
    const totalBurnedTokens = roundToTwoDecimals(checkedSum(history.map((h) => h.burned)));
    const deflationaryRatio = computeDeflationaryRatio(totalBurnedTokens, rawEmissions);

    return {
        totalRevenueLumens,
        totalBurnedTokens,
        deflationaryRatio,
        history,
    };
}

/**
 * Configure an external transparency data source (or null to restore seeded default).
 */
export function setTransparencyDataSource(source: ExternalTransparencySource | null): void {
    externalDataSource = source;
}

/**
 * Reset the in-memory transparency cache and custom data source (test hook).
 */
export function resetTransparencyCache(): void {
    cache = null;
    externalDataSource = null;
}

// ── Data aggregation ─────────────────────────────────────────────────────

function buildDefaultSeededInput(): { history: TransparencyHistoryPoint[]; totalEmissions: number } {
    const history: TransparencyHistoryPoint[] = [];
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

    return {
        history,
        totalEmissions: 10_000 * 30,
    };
}

/**
 * Aggregates protocol revenue and burn metrics.
 *
 * In production this would query PostgreSQL and the Stellar Horizon API.
 * We return seeded deterministic data derived from the current date so
 * tests and the dashboard always have realistic numbers.
 *
 * @returns Aggregated transparency metrics.
 */
async function aggregateTransparencyData(options?: { forceRefresh?: boolean }): Promise<TransparencyData> {
    if (!options?.forceRefresh && cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
        return cache;
    }

    const rawSourceData = externalDataSource
        ? await externalDataSource()
        : buildDefaultSeededInput();

    const summary = buildTransparencySummary(rawSourceData);

    // Only replace the cache after every boundary validation and checked
    // computation has succeeded; a failure leaves the previous snapshot
    // intact for safe retry.
    cache = {
        ...summary,
        history: summary.history.map((point) => ({ ...point })),
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
        const { cachedAt: _omit, ...payload } = cloneSummaryData(data);
        res.json(payload);
    } catch (err) {
        console.error("Failed to aggregate transparency data", err);
        // Fall back to the last good snapshot if one exists; do not expose
        // a poisoned partial result. Callers can safely retry.
        if (cache) {
            const { cachedAt: _omit, ...payload } = cloneSummaryData(cache);
            res.json(payload);
            return;
        }
        const code = err instanceof TransparencyCalculationError ? err.code : "MALFORMED_EXTERNAL_DATA";
        res.status(500).json({ error: "Unable to fetch transparency data.", code });
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
    const rawProtocolId = req.query.protocolId;
    if (
      rawProtocolId !== undefined &&
      (typeof rawProtocolId !== "string" || !rawProtocolId.trim())
    ) {
      res.status(400).json({
        error: "protocolId query parameter must be a non-empty string.",
        code: "INVALID_QUERY_PARAMETER",
      });
      return;
    }
    const protocolId = typeof rawProtocolId === "string" ? rawProtocolId.trim() : undefined;
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
    if (!isPlainObject(req.body)) {
      res.status(400).json({
        error: "protocolId, protocolName, and reasons are required.",
        code: "MALFORMED_INCIDENT_PAYLOAD",
      });
      return;
    }
    const { protocolId, protocolName, reasons, startedAt } = req.body as {
      protocolId?: unknown;
      protocolName?: unknown;
      reasons?: unknown;
      startedAt?: unknown;
    };
    if (
      typeof protocolId !== "string" ||
      typeof protocolName !== "string" ||
      !protocolId.trim() ||
      !protocolName.trim() ||
      !Array.isArray(reasons)
    ) {
      res.status(400).json({
        error: "protocolId, protocolName, and reasons are required.",
        code: "MALFORMED_INCIDENT_PAYLOAD",
      });
      return;
    }
    try {
      const incident = failoverIncidentHistoryService.recordIncident({
        protocolId,
        protocolName,
        reasons: reasons as string[],
        startedAt: startedAt as string | undefined,
      });
      res.status(201).json(incident);
    } catch (error) {
      if (error instanceof FailoverIncidentValidationError) {
        res.status(400).json({ error: error.message, code: error.code });
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
    if (req.body !== undefined && req.body !== null && !isPlainObject(req.body)) {
      res.status(400).json({
        error: "Request body must be a JSON object.",
        code: "MALFORMED_INCIDENT_PAYLOAD",
      });
      return;
    }
    const { recoveredAt } = (req.body ?? {}) as { recoveredAt?: unknown };
    let incident: ReturnType<typeof failoverIncidentHistoryService.resolveIncident>;
    try {
      incident = failoverIncidentHistoryService.resolveIncident(
        req.params.protocolId,
        recoveredAt as string | undefined,
      );
    } catch (error) {
      if (error instanceof FailoverIncidentValidationError) {
        res.status(400).json({ error: error.message, code: error.code });
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
