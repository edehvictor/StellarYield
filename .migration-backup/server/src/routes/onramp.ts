import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const router = Router();
const prisma = new PrismaClient();

// In-memory cache for quotes (simulate provider behavior)
interface CachedQuote {
  quoteId: string;
  provider: string;
  amountFiat: number;
  currency: string;
  amountUsdc: number;
  expiresAt: number;
}

const quoteCache = new Map<string, CachedQuote>();

// Server-side provider credentials simulation
const getProviderConfig = () => {
  const apiKey = process.env.ONRAMP_PROVIDER_API_KEY || "mock-server-side-api-key";
  if (!apiKey) {
    throw new Error("Missing provider configuration.");
  }
  return { apiKey };
};

// POST /api/onramp/quote - Create a quote
router.post("/quote", (req: Request, res: Response) => {
  try {
    getProviderConfig();
    const { amountFiat, currency, provider = "STRIPE" } = req.body;

    if (!amountFiat || isNaN(Number(amountFiat)) || Number(amountFiat) <= 0) {
      res.status(400).json({ error: "Invalid amountFiat. Must be a positive number." });
      return;
    }

    if (!currency || typeof currency !== "string" || currency.length !== 3) {
      res.status(400).json({ error: "Invalid currency. Must be a 3-letter currency code." });
      return;
    }

    // Mock conversion rate: 1 Fiat = 0.98 USDC
    const usdcRate = 0.98;
    const amountUsdc = Math.round(Number(amountFiat) * usdcRate * 100) / 100;

    const quoteId = `quote_${Math.random().toString(36).substring(2, 11)}`;
    const expiresAt = Date.now() + 30 * 1000; // 30 seconds expiration

    const quote: CachedQuote = {
      quoteId,
      provider,
      amountFiat: Number(amountFiat),
      currency: currency.toUpperCase(),
      amountUsdc,
      expiresAt,
    };

    quoteCache.set(quoteId, quote);

    res.json(quote);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to create quote" });
  }
});

// POST /api/onramp/intent - Confirm intent and create pending transaction
router.post("/intent", async (req: Request, res: Response) => {
  try {
    getProviderConfig();
    const { quoteId, walletAddress } = req.body;

    if (!quoteId) {
      res.status(400).json({ error: "Missing quoteId." });
      return;
    }

    if (!walletAddress) {
      res.status(400).json({ error: "Missing walletAddress." });
      return;
    }

    const cachedQuote = quoteCache.get(quoteId);
    if (!cachedQuote) {
      res.status(404).json({ error: "Quote not found." });
      return;
    }

    if (Date.now() > cachedQuote.expiresAt) {
      res.status(400).json({ error: "Quote has expired." });
      return;
    }

    const txId = `tx_${Math.random().toString(36).substring(2, 11)}`;

    const tx = await prisma.onRampTransaction.create({
      data: {
        providerTxId: txId,
        provider: cachedQuote.provider,
        status: "PENDING",
        walletAddress,
        amountFiat: cachedQuote.amountFiat,
        currency: cachedQuote.currency,
        amountUsdc: cachedQuote.amountUsdc,
      },
    });

    res.json({ success: true, transaction: tx });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to create intent" });
  }
});

// GET /api/onramp/status/:txId - Get transaction status
router.get("/status/:txId", async (req: Request, res: Response) => {
  try {
    const { txId } = req.params;
    const tx = await prisma.onRampTransaction.findUnique({
      where: { providerTxId: txId },
    });

    if (!tx) {
      res.status(404).json({ error: "Transaction not found." });
      return;
    }

    res.json({ status: tx.status, transaction: tx });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to fetch status" });
  }
});

// POST /api/onramp/cancel - Cancel on-ramp transaction
router.post("/cancel", async (req: Request, res: Response) => {
  try {
    getProviderConfig();
    const { txId } = req.body;

    if (!txId) {
      res.status(400).json({ error: "Missing txId." });
      return;
    }

    const tx = await prisma.onRampTransaction.findUnique({
      where: { providerTxId: txId },
    });

    if (!tx) {
      res.status(404).json({ error: "Transaction not found." });
      return;
    }

    if (tx.status !== "PENDING") {
      res.status(400).json({ error: `Cannot cancel transaction in ${tx.status} state.` });
      return;
    }

    const updatedTx = await prisma.onRampTransaction.update({
      where: { providerTxId: txId },
      data: { status: "FAILED" }, // Normalized status failure state
    });

    res.json({ success: true, transaction: updatedTx });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to cancel transaction" });
  }
});

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
