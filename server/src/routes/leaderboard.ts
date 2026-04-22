import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

// In-process mock Redis cache
const CACHE_TTL = 300000; // 5 minutes
let leaderboardCache: unknown = null;
let lastCacheUpdate = 0;

/**
 * @notice Fetch the top 100 depositors by TVL.
 * @dev Results are cached in-memory for 5 minutes to reduce database load.
 * @param page The page number for pagination.
 * @param limit The number of results per page.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 100;
    const skip = (page - 1) * limit;

    const now = Date.now();
    if (leaderboardCache && now - lastCacheUpdate < CACHE_TTL && page === 1) {
      return res.json(leaderboardCache);
    }

    const leaderboard = await prisma.vaultBalance.findMany({
      orderBy: { tvl: "desc" },
      take: limit,
      skip: skip,
    });

    const enrichedLeaderboard = leaderboard.map((user, index) => {
      let badge = "";
      if (index === 0) badge = "🥇 WHALE LORD";
      else if (index < 10) badge = "💎 TOP 10";
      else if (user.tvl > 1000000) badge = "🚀 BULLISH";
      
      return {
        ...user,
        rank: skip + index + 1,
        badge,
      };
    });

    if (page === 1) {
      leaderboardCache = enrichedLeaderboard;
      lastCacheUpdate = now;
    }

    res.json(enrichedLeaderboard);
  } catch (error) {
    console.error("Leaderboard query failed", error);
    res.status(500).json({ error: "Failed to fetch leaderboard." });
  }
});

export default router;
