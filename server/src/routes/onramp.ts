import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

// Webhook listener for Stripe/MoonPay
router.post("/webhook", async (req: Request, res: Response) => {
  const { provider, txId, status, walletAddress, amountFiat, currency, amountUsdc } = req.body;

  // Security: In a real app, verify signature here.
  
  try {
    const tx = await prisma.onRampTransaction.upsert({
      where: { providerTxId: txId },
      update: { status, amountUsdc },
      create: {
        providerTxId: txId,
        provider,
        status,
        walletAddress,
        amountFiat,
        currency,
        amountUsdc,
      },
    });

    if (status === "COMPLETED") {
      // Trigger a notification
      await prisma.notification.create({
        data: {
          walletAddress,
          type: "DEPOSIT",
          title: "Fiat Purchase Successful!",
          message: `Your purchase of ${amountUsdc} USDC was successful. Deposit it into the vault to start earning!`,
        },
      });
    }

    res.json({ success: true, transaction: tx });
  } catch (error) {
    console.error("Onramp webhook failed", error);
    res.status(500).json({ error: "Failed to process webhook." });
  }
});

export default router;
