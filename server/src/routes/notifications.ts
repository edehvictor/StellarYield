import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

// FETCH notifications for a user
router.get("/:walletAddress", async (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  try {
    const notifications = await prisma.notification.findMany({
      where: { walletAddress },
      orderBy: { createdAt: "desc" },
    });
    res.json(notifications);
  } catch {
    res.status(500).json({ error: "Failed to fetch notifications." });
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
    res.status(500).json({ error: "Failed to mark as read." });
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
    res.status(500).json({ error: "Failed to clear notifications." });
  }
});

export default router;
