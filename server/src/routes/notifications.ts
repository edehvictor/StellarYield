import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { sendError } from "../utils/errorResponse";
import { validateWalletAddress } from "../middleware/validation";

const router = Router();
const prisma = new PrismaClient();

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
