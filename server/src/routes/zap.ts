import { Router, Request, Response } from "express";
import { getZapSupportedAssetsPayload } from "../config/zapAssetsConfig";
import { getZapQuote, type ZapQuoteBody } from "../services/zapQuote";
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
    const b = req.body as ZapQuoteBody;

    const body: ZapQuoteBody = {
      inputTokenContract: String(b.inputTokenContract),
      vaultTokenContract: String(b.vaultTokenContract),
      amountInStroops: String(b.amountInStroops),
      inputDecimals: Number(b.inputDecimals ?? 7),
      vaultDecimals: Number(b.vaultDecimals ?? 7),
    };

    const quote = await getZapQuote(body);
    res.json({
      path: quote.path,
      expectedAmountOutStroops: quote.expectedAmountOutStroops,
      source: quote.source,
    });
  } catch (e) {
    sendError(
      res,
      500,
      "QUOTE_FAILED",
      "Quote failed",
      e instanceof Error ? e.message : undefined
    );
  }
});

export default router;
