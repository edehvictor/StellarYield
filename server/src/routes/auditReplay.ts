import { Request, Response, Router } from "express";
import { createAuditReplayService } from "../services/auditReplayService";
import { parsePaginationLimit } from "../types/pagination";

const router = Router();
const auditReplayService = createAuditReplayService();

router.post("/record", (req: Request, res: Response) => {
  const {
    strategyId,
    inputs,
    outputs,
    intermediateScores,
    executionTime,
    status,
    error,
  } = req.body ?? {};

  if (!strategyId || !inputs || !outputs || !intermediateScores) {
    res.status(400).json({
      error:
        "Expected strategyId, inputs, outputs, and intermediateScores in request body.",
    });
    return;
  }

  const record = auditReplayService.recordStrategyExecution(
    String(strategyId),
    inputs,
    outputs,
    intermediateScores,
    Number(executionTime ?? 0),
    status === "failed" || status === "partial" ? status : "success",
    error ? String(error) : undefined,
  );

  res.status(201).json(record);
});

router.get("/summary", async (req: Request, res: Response) => {
  const strategyId = String(req.query.strategyId || "default-strategy");
  const limit = parsePaginationLimit(req.query.limit);
  const cursor = req.query.cursor as string | undefined;

  try {
    const report = await auditReplayService.replaySummary(strategyId, limit + 1);

    let items = report.items;
    if (cursor) {
      const idx = items.findIndex((item: Record<string, unknown>) => (item as any).id === cursor || (item as any).executionId === cursor);
      items = idx >= 0 ? items.slice(idx + 1) : items;
    }

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore && page.length > 0
      ? ((page[page.length - 1] as any).id || (page[page.length - 1] as any).executionId || null)
      : null;

    res.json({
      success: true,
      data: {
        summary: {
          total: report.total,
          deterministicCount: report.deterministicCount,
          discrepancyCount: report.discrepancyCount,
          mismatchRate:
            report.total === 0
              ? 0
              : Number((report.discrepancyCount / report.total).toFixed(4)),
        },
        items: page,
      },
      pagination: { nextCursor, hasMore, limit },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Replay summary failed",
    });
  }
});

export default router;
