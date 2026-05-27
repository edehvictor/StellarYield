import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { sendError } from "../utils/errorResponse";
import { validateWalletAddress } from "../middleware/validation";
import {
  getWatchlistDigestPreference,
  saveWatchlistDigestPreference,
  type WatchlistDigestPreference,
} from "../services/digest";

const router = Router();
const prisma = new PrismaClient();

router.get("/digest/preferences/:walletAddress", validateWalletAddress, (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  res.json(getWatchlistDigestPreference(walletAddress));
});

router.put("/digest/preferences/:walletAddress", validateWalletAddress, (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  const body = req.body as Partial<WatchlistDigestPreference>;
  const scheduleMode = body.scheduleMode as WatchlistDigestPreference["scheduleMode"];

  if (typeof body.enabled !== "boolean") {
    sendError(res, 400, "INVALID_DIGEST_PREFERENCES", "enabled must be a boolean.");
    return;
  }

  if (!["daily", "weekly", "event_threshold"].includes(String(body.scheduleMode))) {
    sendError(
      res,
      400,
      "INVALID_DIGEST_PREFERENCES",
      "scheduleMode must be daily, weekly, or event_threshold.",
    );
    return;
  }

  const watchedVaultIds = Array.isArray(body.watchedVaultIds)
    ? body.watchedVaultIds.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
    : [];

  res.json(
    saveWatchlistDigestPreference(walletAddress, {
      enabled: body.enabled,
      scheduleMode,
      eventThreshold: Number(body.eventThreshold ?? 2),
      watchedVaultIds,
      minApyDeltaPct: Number(body.minApyDeltaPct ?? 0.5),
      minRiskDelta: Number(body.minRiskDelta ?? 5),
      maxFreshnessHours: Number(body.maxFreshnessHours ?? 12),
    }),
  );
});

// FETCH notifications for a user
router.get("/:walletAddress", validateWalletAddress, async (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  try {
    const notifications = await prisma.notification.findMany({
      where: { walletAddress },
      orderBy: { createdAt: "desc" },
    });
    res.json(notifications);
  } catch {
    sendError(res, 500, "FETCH_NOTIFICATIONS_FAILED", "Failed to fetch notifications.");
  }
});

// MARK as read
router.patch("/:id/read", async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });
    res.sendStatus(204);
  } catch {
    sendError(res, 500, "MARK_READ_FAILED", "Failed to mark as read.");
  }
});

// CLEAR all notifications
router.delete("/:walletAddress", async (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  try {
    await prisma.notification.deleteMany({
      where: { walletAddress },
    });
    res.sendStatus(204);
  } catch {
    sendError(res, 500, "CLEAR_NOTIFICATIONS_FAILED", "Failed to clear notifications.");
  }
});

export default router;
