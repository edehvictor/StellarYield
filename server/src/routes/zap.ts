import { Router, Request, Response } from "express";
import { getZapSupportedAssetsPayload } from "../config/zapAssetsConfig";
import { getZapQuote, verifyQuoteForExecution, verifyZapQuote, isQuoteExpired, type ZapQuoteBody } from "../services/zapQuote";
import { freezeService } from "../services/freezeService";
import { sendError } from "../utils/errorResponse";
import { validateZapQuote } from "../middleware/validation";

const router = Router();

router.get("/supported-assets", (_req: Request, res: Response) => {
  try {
    res.json(getZapSupportedAssetsPayload());
  } catch (error) {
    sendError(
      res,
      503,
      "CONFIG_UNAVAILABLE",
      "Supported assets configuration is unavailable.",
      error instanceof Error ? error.message : undefined
    );
  }
});

router.post("/quote", validateZapQuote, async (req: Request, res: Response) => {
  try {
    const b = req.body as ZapQuoteBody & { protocol?: string };

    const body: ZapQuoteBody = {
      inputTokenContract: String(b.inputTokenContract),
      vaultTokenContract: String(b.vaultTokenContract),
      amountInStroops: String(b.amountInStroops),
      inputDecimals: Number(b.inputDecimals ?? 7),
      vaultDecimals: Number(b.vaultDecimals ?? 7),
      slippageTolerance: b.slippageTolerance !== undefined ? Number(b.slippageTolerance) : undefined,
      protocol: b.protocol !== undefined ? String(b.protocol) : undefined,
    };

    const quote = await getZapQuote(body);
    res.json({
      path: quote.path,
      expectedAmountOutStroops: quote.expectedAmountOutStroops,
      source: quote.source,
      slippageApplied: quote.slippageApplied,
      amountOutAfterSlippage: quote.amountOutAfterSlippage,
      quotedAt: quote.quotedAt,
      minAmountOutStroops: quote.minAmountOutStroops,
      quoteAgeMs: quote.quoteAgeMs,
      isFallback: quote.isFallback,
      // Upstream fields
      issuedAt: quote.issuedAt,
      expiresAt: quote.expiresAt,
      routeHash: quote.routeHash,
      assetConfigVersion: quote.assetConfigVersion,
      // Safety envelope — extended (backward compatible: old clients ignore)
      quoteId: quote.quoteId,
      ttlMs: quote.ttlMs,
      inputTokenContract: quote.inputTokenContract,
      vaultTokenContract: quote.vaultTokenContract,
      amountInStroops: quote.amountInStroops,
      protocol: quote.protocol,
      freezeCheckedAt: quote.freezeCheckedAt,
      quoteSource: quote.quoteSource,
      quoteSignature: quote.quoteSignature,
      // Convenience: expose expiry check for clients that don't compute locally
      isExpired: isQuoteExpired(quote),
      isFrozen: freezeService.isFrozen(quote.protocol),
    });
  } catch (e) {
    // Quote generation blocked by freeze should surface as 423, not generic 500
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("freeze")) {
      sendError(res, 423, "FROZEN", msg, msg);
      return;
    }
    sendError(
      res,
      500,
      "QUOTE_FAILED",
      "Quote failed",
      msg
    );
  }
});

router.post("/verify", async (req: Request, res: Response) => {
  try {
    // Branch 1: our quoteId-based verification (fine-grained, with freeze/route binding)
    const {
      quoteId,
      inputTokenContract,
      vaultTokenContract,
      amountInStroops,
      protocol,
      path,
    } = req.body as {
      quoteId?: string;
      inputTokenContract?: string;
      vaultTokenContract?: string;
      amountInStroops?: string;
      protocol?: string;
      path?: { contractId: string }[];
    };

    if (quoteId && typeof quoteId === "string") {
      const result = verifyQuoteForExecution({
        quoteId,
        inputTokenContract: inputTokenContract ? String(inputTokenContract) : undefined,
        vaultTokenContract: vaultTokenContract ? String(vaultTokenContract) : undefined,
        amountInStroops: amountInStroops ? String(amountInStroops) : undefined,
        protocol: protocol ? String(protocol) : undefined,
        path,
      });

      if (!result.valid) {
        const statusMap: Record<string, number> = {
          QUOTE_NOT_FOUND: 404,
          QUOTE_EXPIRED: 410,
          FROZEN: 423,
          ASSET_MISMATCH: 409,
          ROUTE_MISMATCH: 409,
          AMOUNT_MISMATCH: 409,
        };
        const status = statusMap[result.code ?? ""] ?? 400;
        sendError(res, status, result.code ?? "QUOTE_INVALID", result.reason ?? "Quote verification failed.", result.reason);
        return;
      }

      res.json({
        valid: true,
        success: true,
        quote: result.storedQuote,
        isFallback: result.isFallback,
        isExpired: result.storedQuote ? isQuoteExpired(result.storedQuote) : false,
      });
      return;
    }

    // Branch 2: upstream full-quote verification (routeHash, assetConfigVersion, slippage)
    const result = verifyZapQuote(req.body);
    if (!result.valid) {
      return sendError(
        res,
        400,
        result.errorCode || "INVALID_QUOTE",
        result.reason || "Invalid quote",
      );
    }
    res.json({ success: true, valid: true });
  } catch (e) {
    sendError(
      res,
      500,
      "VERIFY_FAILED",
      "Failed to verify quote",
      e instanceof Error ? e.message : undefined
    );
  }
});

export default router;
