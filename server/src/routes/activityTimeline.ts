import { Router, Request, Response } from "express";
import {
  buildUnifiedAccountTimeline,
  getAccountActivityPaginated,
  type AccountActivityEventType,
  type AccountActivityFilters,
  type TransactionStatus,
} from "../services/accountActivityTimelineService";
import { parsePaginationLimit } from "../types/pagination";

const router = Router();

const VALID_TYPES: AccountActivityEventType[] = [
  "deposit",
  "withdrawal",
  "reward",
  "recommendation",
  "alert",
  "rebalance",
];

const VALID_STATUSES: TransactionStatus[] = [
  "completed",
  "pending",
  "failed",
];

router.get("/:walletAddress", (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  const rawTypes = String(req.query.types ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const invalid = rawTypes.filter(
    (value): value is string => !VALID_TYPES.includes(value as AccountActivityEventType),
  );
  if (invalid.length > 0) {
    res.status(400).json({
      error: `Unknown activity types: ${invalid.join(", ")}`,
    });
    return;
  }

  const filters: AccountActivityFilters = {};

  if (rawTypes.length > 0) {
    filters.types = rawTypes as AccountActivityEventType[];
  }

  if (req.query.protocol) {
    filters.protocol = String(req.query.protocol);
  }

  if (req.query.asset) {
    filters.asset = String(req.query.asset);
  }

  if (req.query.status) {
    const rawStatus = String(req.query.status);
    if (!VALID_STATUSES.includes(rawStatus as TransactionStatus)) {
      res.status(400).json({
        error: `Unknown status: ${rawStatus}. Must be one of: ${VALID_STATUSES.join(", ")}`,
      });
      return;
    }
    filters.status = rawStatus as TransactionStatus;
  }

  const hasFilters =
    filters.types ||
    filters.protocol ||
    filters.asset ||
    filters.status;

  // Cursor pagination (#1305) — shared `PaginatedResponse` contract.
  // `timeline` is kept as the page payload for backward compatibility;
  // `data` + `pagination` expose the canonical contract for new clients.
  const limit = parsePaginationLimit(req.query.limit);
  const cursor =
    typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const page = getAccountActivityPaginated(
    walletAddress,
    hasFilters ? filters : undefined,
    { cursor, limit },
  );

  // Preserve the legacy unpaginated shape when the client did not ask for
  // paging (no cursor/limit params): full timeline + empty pagination.
  const wantsPaging = req.query.cursor !== undefined || req.query.limit !== undefined;
  if (!wantsPaging) {
    const timeline = buildUnifiedAccountTimeline(
      walletAddress,
      hasFilters ? filters : undefined,
    );
    res.json({
      walletAddress,
      timeline,
      data: timeline,
      pagination: { nextCursor: null, hasMore: false, limit: timeline.length },
    });
    return;
  }

  res.json({
    walletAddress,
    timeline: page.data,
    data: page.data,
    pagination: page.pagination,
  });
});

export default router;

