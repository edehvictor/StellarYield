import { Router, Request, Response } from "express";
import {
  buildUnifiedAccountTimeline,
  type AccountActivityEventType,
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

  const timeline = buildUnifiedAccountTimeline(
    walletAddress,
    rawTypes as AccountActivityEventType[],
  );

  res.json({
    walletAddress,
    timeline,
  });
});

export default router;

