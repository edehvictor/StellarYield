import { Request, Response, Router } from "express";
import { eventArchiveService } from "../services/eventArchiveService";

const router = Router();

/**
 * GET /api/audit-archive/events
 *
 * Normalized event archive lookup (#1078), powering audit replay and
 * incident review workflows. Accepts any combination of `source`,
 * `eventType`, `timeBucket`, and `id` as query params — every filter is
 * optional, and omitting a dimension searches across all values for it
 * (e.g. omitting `source` returns matches across every source).
 *
 * A filter combination that matches nothing (an unknown source, a time
 * bucket with no archived events, etc.) returns a 200 with an empty
 * `records` array rather than a 404 — an empty archive lookup is a valid,
 * expected outcome for a replay tool, not an error.
 */
router.get("/events", async (req: Request, res: Response) => {
  const { source, eventType, timeBucket, id } = req.query;

  try {
    const result = await eventArchiveService.lookupEvents({
      source: typeof source === "string" ? source : undefined,
      eventType: typeof eventType === "string" ? eventType : undefined,
      timeBucket: typeof timeBucket === "string" ? timeBucket : undefined,
      id: typeof id === "string" ? id : undefined,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Event archive lookup failed",
    });
  }
});

export default router;