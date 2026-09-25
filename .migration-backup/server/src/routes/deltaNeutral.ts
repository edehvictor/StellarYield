import { Router, Request, Response } from "express";
import { getUnwindQuote } from "../services/deltaNeutralUnwindQuote";
import { getWalletAddressType } from "../utils/stellarAuth";
import { sendError } from "../utils/errorResponse";

const router = Router();

/**
 * GET /api/strategies/delta-neutral/:contractId/unwind-quote
 *
 * Returns a best-effort preview of unwinding a delta-neutral position:
 * expected output and fee per leg, risk notes, and any leg that could not
 * be quoted. Always 200 — an unsafe/incomplete preview is communicated via
 * `canExecute: false` in the body, not an HTTP error status.
 *
 * Query params:
 *   depositor — the position owner's wallet address (G...)
 *   spotToken — the strategy's spot asset contract address (C...)
 *   oracle    — the price oracle contract address (C...)
 */
router.get("/:contractId/unwind-quote", async (req: Request, res: Response) => {
  const { contractId } = req.params;
  const depositor = req.query.depositor as string | undefined;
  const spotToken = req.query.spotToken as string | undefined;
  const oracle = req.query.oracle as string | undefined;

  if (!depositor || getWalletAddressType(depositor) !== "account") {
    sendError(res, 400, "INVALID_DEPOSITOR", "A valid depositor wallet address is required.");
    return;
  }
  if (!spotToken || getWalletAddressType(spotToken) !== "contract") {
    sendError(res, 400, "INVALID_SPOT_TOKEN", "A valid spotToken contract address is required.");
    return;
  }
  if (!oracle || getWalletAddressType(oracle) !== "contract") {
    sendError(res, 400, "INVALID_ORACLE", "A valid oracle contract address is required.");
    return;
  }

  const quote = await getUnwindQuote(contractId, spotToken, oracle, depositor);
  res.json(quote);
});

export default router;
