import { Router, Request, Response } from "express";
import {
  buildUnifiedAccountTimeline,
  type AccountActivityEventType,
  type AccountActivityFilters,
  type TransactionStatus,
} from "../services/accountActivityTimelineService";

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

  const timeline = buildUnifiedAccountTimeline(
    walletAddress,
    hasFilters ? filters : undefined,
  );

  res.json({
    walletAddress,
    timeline,
  });
});

export default router;

