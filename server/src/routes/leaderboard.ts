import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { sendError } from "../utils/errorResponse";
import { validatePagination } from "../middleware/validation";

const router = Router();
const prisma = new PrismaClient();

// In-process mock Redis cache
const CACHE_TTL = 300000; // 5 minutes
let leaderboardCache: unknown = null;
let lastCacheUpdate = 0;

function badRequest(res: Response, message: string, details?: unknown): void {
  const requestId = (res.req as unknown as { requestId?: string } | undefined)
    ?.requestId;
  res.status(400).json({ error: message, details, requestId });
}

function parseInteger(
  value: unknown,
  name: string,
  options: { min?: number; max?: number } = {},
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: NaN };
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return { ok: false, error: `${name} must be an integer` };
  if (options.min !== undefined && parsed < options.min)
    return { ok: false, error: `${name} must be >= ${options.min}` };
  if (options.max !== undefined && parsed > options.max)
    return { ok: false, error: `${name} must be <= ${options.max}` };
  return { ok: true, value: parsed };
}

function parseNumber(
  value: unknown,
  name: string,
  options: { min?: number; max?: number } = {},
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: NaN };
  const parsed = Number(String(value));
  if (!Number.isFinite(parsed)) return { ok: false, error: `${name} must be a number` };
  if (options.min !== undefined && parsed < options.min)
    return { ok: false, error: `${name} must be >= ${options.min}` };
  if (options.max !== undefined && parsed > options.max)
    return { ok: false, error: `${name} must be <= ${options.max}` };
  return { ok: true, value: parsed };
}

function timeframeToSince(timeframe: string): Date | null {
  const now = Date.now();
  if (timeframe === "all") return null;
  if (timeframe === "24h") return new Date(now - 24 * 60 * 60 * 1000);
  if (timeframe === "7d") return new Date(now - 7 * 24 * 60 * 60 * 1000);
  if (timeframe === "30d") return new Date(now - 30 * 24 * 60 * 60 * 1000);
  return null;
}

/**
 * @notice Fetch the top 100 depositors by TVL.
 * @dev Results are cached in-memory for 5 minutes to reduce database load.
 * @param limit Max items (default 100, max 100).
 * @param offset Starting offset (default 0).
 * @param timeframe Filter by `updatedAt` window: 24h | 7d | 30d | all.
 * @param segment Optional wallet segment: whale | all.
 * @param minTvl Optional minimum TVL.
 * @param maxTvl Optional maximum TVL.
 */
router.get("/", validatePagination, async (req: Request, res: Response) => {
  try {
    if (req.query.protocol) {
      badRequest(res, "protocol filter is not supported by this dataset");
      return;
    }

    const limitParsed = parseInteger(req.query.limit, "limit", { min: 1, max: 100 });
    if (!limitParsed.ok) return badRequest(res, limitParsed.error);
    const offsetParsed = parseInteger(req.query.offset, "offset", { min: 0 });
    if (!offsetParsed.ok) return badRequest(res, offsetParsed.error);

    const pageParsed = parseInteger(req.query.page, "page", { min: 1 });
    if (!pageParsed.ok) return badRequest(res, pageParsed.error);

    const limit = Number.isNaN(limitParsed.value) ? 100 : limitParsed.value;
    let offset = Number.isNaN(offsetParsed.value) ? 0 : offsetParsed.value;
    if (!Number.isNaN(pageParsed.value)) {
      offset = (pageParsed.value - 1) * limit;
    }

    const minTvlParsed = parseNumber(req.query.minTvl, "minTvl", { min: 0 });
    if (!minTvlParsed.ok) return badRequest(res, minTvlParsed.error);
    const maxTvlParsed = parseNumber(req.query.maxTvl, "maxTvl", { min: 0 });
    if (!maxTvlParsed.ok) return badRequest(res, maxTvlParsed.error);
    if (
      Number.isFinite(minTvlParsed.value) &&
      Number.isFinite(maxTvlParsed.value) &&
      minTvlParsed.value > maxTvlParsed.value
    ) {
      return badRequest(res, "minTvl must be <= maxTvl");
    }

    const timeframe =
      typeof req.query.timeframe === "string" ? req.query.timeframe : "all";
    const since = timeframeToSince(timeframe);
    if (!since && timeframe !== "all") {
      return badRequest(res, "timeframe must be one of: 24h, 7d, 30d, all");
    }

    const segment =
      typeof req.query.segment === "string" ? req.query.segment : "all";
    if (segment !== "all" && segment !== "whale") {
      return badRequest(res, "segment must be one of: whale, all");
    }

    const now = Date.now();
    const cacheable =
      offset === 0 &&
      limit === 100 &&
      timeframe === "all" &&
      segment === "all" &&
      !Number.isFinite(minTvlParsed.value) &&
      !Number.isFinite(maxTvlParsed.value);

    if (leaderboardCache && now - lastCacheUpdate < CACHE_TTL && cacheable) {
      return res.json(leaderboardCache);
    }

    const where: Record<string, unknown> = {};
    if (since) where.updatedAt = { gte: since };
    if (segment === "whale") where.tvl = { gte: 1_000_000 };
    if (Number.isFinite(minTvlParsed.value) || Number.isFinite(maxTvlParsed.value)) {
      where.tvl = {
        ...(typeof where.tvl === "object" ? (where.tvl as object) : {}),
        ...(Number.isFinite(minTvlParsed.value) ? { gte: minTvlParsed.value } : {}),
        ...(Number.isFinite(maxTvlParsed.value) ? { lte: maxTvlParsed.value } : {}),
      };
    }

    const total = await prisma.vaultBalance.count({ where: where as never });
    const leaderboard = await prisma.vaultBalance.findMany({
      where: where as never,
      orderBy: { tvl: "desc" },
      take: limit,
      skip: offset,
    });

    const enrichedLeaderboard = leaderboard.map((user, index) => {
      let badge = "";
      if (index === 0) badge = "🥇 WHALE LORD";
      else if (index < 10) badge = "💎 TOP 10";
      else if (user.tvl > 1000000) badge = "🚀 BULLISH";
      
      return {
        ...user,
        rank: offset + index + 1,
        badge,
      };
    });

    const response = {
      items: enrichedLeaderboard,
      pagination: { limit, offset, total },
      filters: { timeframe, segment },
    };

    if (cacheable) {
      leaderboardCache = response;
      lastCacheUpdate = now;
    }

    res.json(response);
  } catch (error) {
    console.error("Leaderboard query failed", error);
    sendError(res, 500, "LEADERBOARD_FAILED", "Failed to fetch leaderboard.");
    res.status(500).json({
      error: "Failed to fetch leaderboard.",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

export default router;
