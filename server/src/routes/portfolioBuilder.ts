import { Router, Request, Response } from "express";
import { sendError } from "../utils/errorResponse";
import {
  PortfolioBuilderValidationError,
  validatePortfolioBuilderPayload,
} from "../services/portfolioBuilderValidation";

const router = Router();

/**
 * POST /api/portfolio/builder/validate
 *
 * Re-check a portfolio builder draft for dust allocations before deposits are
 * submitted. Returns 200 with `valid: false` and typed issues when the payload
 * is well-formed but would leave dust; malformed input returns a typed 400.
 *
 * Example:
 * ```json
 * {
 *   "totalAmount": "100",
 *   "minimumAllocationAmount": "1",
 *   "allocations": [
 *     { "vaultContractId": "blend", "vaultName": "Blend", "weight": 50 },
 *     { "vaultContractId": "soroswap", "vaultName": "Soroswap", "weight": 50 }
 *   ]
 * }
 * ```
 */
router.post("/validate", (req: Request, res: Response): void => {
  try {
    res.json(validatePortfolioBuilderPayload(req.body));
  } catch (error) {
    if (error instanceof PortfolioBuilderValidationError) {
      sendError(
        res,
        error.statusCode,
        error.code,
        error.message,
        error.details,
        undefined,
        false,
      );
      return;
    }

    sendError(
      res,
      500,
      "PORTFOLIO_VALIDATION_UNAVAILABLE",
      "The allocation could not be validated. Please retry.",
      undefined,
      undefined,
      true,
    );
  }
});

export default router;
