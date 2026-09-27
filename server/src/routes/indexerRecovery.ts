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
import {
    runGapRepair,
    listGapRepairRuns,
    GapRepairError,
} from "../indexer/gapRepair";
import { requireAdmin } from "../middleware/authz";
import { successEnvelope, errorEnvelope } from "../types/envelope";

const router = Router();

/** Map a GapRepairError onto an error envelope response. */
function sendGapRepairError(res: Response, error: GapRepairError): void {
    const category =
        error.statusCode >= 500 ? "service_failure" : "validation";
    res.status(error.statusCode).json(
        errorEnvelope(
            error.code,
            error.message,
            "indexer/gap-repair",
            error.details,
            { category, retryable: error.statusCode >= 500 },
        ),
    );
}

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

/**
 * POST /api/indexer/recovery-queue/gap-repair  (admin only)
 *
 * Runs a gap repair over an explicit ledger range and returns the persisted
 * run summary: scanned range plus restored / skipped / still-missing counts.
 *
 * Body: { "startLedger": number, "endLedger": number }
 */
router.post(
    "/gap-repair",
    requireAdmin,
    async (req: Request, res: Response): Promise<void> => {
        try {
            const prisma = await loadPrismaClient();
            const { startLedger, endLedger } = req.body ?? {};
            const run = await runGapRepair(prisma, { startLedger, endLedger });
            res.json(successEnvelope({ run }, "indexer/gap-repair"));
        } catch (error) {
            if (error instanceof GapRepairError) {
                sendGapRepairError(res, error);
                return;
            }
            res.status(500).json(
                errorEnvelope(
                    "GAP_REPAIR_FAILED",
                    "Failed to run gap repair",
                    "indexer/gap-repair",
                ),
            );
        }
    },
);

/**
 * GET /api/indexer/recovery-queue/gap-repair  (admin only)
 *
 * Lists persisted gap repair summaries, newest first.
 *
 * Query parameters:
 *   limit — max runs to return, 1–100 (default 20)
 */
router.get(
    "/gap-repair",
    requireAdmin,
    async (req: Request, res: Response): Promise<void> => {
        try {
            const prisma = await loadPrismaClient();
            const rawLimit = req.query.limit
                ? parseInt(String(req.query.limit), 10)
                : 20;
            const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
            const runs = await listGapRepairRuns(prisma, limit);
            res.json(
                successEnvelope(
                    { runs, count: runs.length },
                    "indexer/gap-repair/list",
                ),
            );
        } catch (error) {
            if (error instanceof GapRepairError) {
                sendGapRepairError(res, error);
                return;
            }
            res.status(500).json(
                errorEnvelope(
                    "GAP_REPAIR_LIST_FAILED",
                    "Failed to list gap repair runs",
                    "indexer/gap-repair/list",
                ),
            );
        }
    },
);

export default router;
