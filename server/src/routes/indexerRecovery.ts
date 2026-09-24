import { Router, Request, Response } from "express";
import {
    loadPrismaClient,
    listUnresolvedDeadLetters,
    getUnresolvedDeadLetterCount,
    getOldestUnresolvedDeadLetter,
    replayDeadLetters,
    replayDeadLetterById,
    replayDeadLettersByLedgerRange,
} from "../indexer/indexer";

const router = Router();

/**
 * GET /api/indexer/recovery-queue
 *
 * Returns the current recovery queue of failed indexer jobs (dead-letter
 * events) that have not yet been resolved, along with summary stats.
 *
 * Query parameters:
 *   limit — max items to return, 1–200 (default 50)
 */
router.get("/", async (req: Request, res: Response) => {
    const prisma = await loadPrismaClient();
    if (!prisma) {
        res.status(503).json({ error: "Indexer storage is unavailable" });
        return;
    }

    try {
        const limit = req.query.limit
            ? parseInt(String(req.query.limit), 10)
            : 50;
        const [items, count, oldest] = await Promise.all([
            listUnresolvedDeadLetters(prisma, limit),
            getUnresolvedDeadLetterCount(prisma),
            getOldestUnresolvedDeadLetter(prisma),
        ]);

        res.json({
            count,
            oldestUnresolvedAt: oldest ? oldest.toISOString() : null,
            items,
        });
    } catch {
        res.status(500).json({ error: "Failed to load recovery queue" });
    }
});

/**
 * POST /api/indexer/recovery-queue/replay
 *
 * Body (all optional, mutually exclusive):
 *   { "id": string }                                  — replay a single dead letter
 *   { "startLedger": number, "endLedger": number }     — replay a ledger range
 *   {}                                                 — replay everything currently due for retry
 */
router.post("/replay", async (req: Request, res: Response) => {
    const prisma = await loadPrismaClient();
    if (!prisma) {
        res.status(503).json({ error: "Indexer storage is unavailable" });
        return;
    }

    try {
        const { id, startLedger, endLedger } = req.body ?? {};

        if (typeof id === "string" && id.length > 0) {
            const replayed = await replayDeadLetterById(prisma, id);
            res.json({ replayed: replayed ? 1 : 0 });
            return;
        }

        if (
            typeof startLedger === "number" &&
            typeof endLedger === "number"
        ) {
            const replayed = await replayDeadLettersByLedgerRange(
                prisma,
                startLedger,
                endLedger,
            );
            res.json({ replayed });
            return;
        }

        const replayed = await replayDeadLetters(prisma);
        res.json({ replayed });
    } catch {
        res.status(500).json({ error: "Failed to replay recovery queue" });
    }
});

export default router;
