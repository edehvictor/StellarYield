/**
 * Portfolio import validation for external CSV files (#1340).
 *
 *   POST /api/portfolio/import/validate   { "csv": "<file contents>" }
 *
 * Validates a holdings CSV without importing anything. A structurally valid
 * file answers 200 with a preview (valid holdings, per-row issues, totals);
 * a file-level problem answers with the stable code from
 * `PORTFOLIO_IMPORT_FAILURES` (e.g. 422 `IMPORT_MISSING_COLUMNS`).
 */
import { Router, Request, Response } from "express";
import { sendError } from "../utils/errorResponse";
import {
  PORTFOLIO_IMPORT_FAILURES,
  validatePortfolioImportCsv,
} from "../../../shared/types/portfolioImport";

const router = Router();

router.post("/validate", (req: Request, res: Response) => {
  const csv = (req.body as { csv?: unknown } | undefined)?.csv;
  if (typeof csv !== "string") {
    return sendError(
      res,
      400,
      "IMPORT_INVALID_REQUEST",
      "Send the CSV file contents as a string in the `csv` field.",
    );
  }

  const result = validatePortfolioImportCsv(csv);
  if (!result.ok) {
    return sendError(
      res,
      PORTFOLIO_IMPORT_FAILURES[result.error.code].httpStatus,
      result.error.code,
      result.error.message,
      result.error.details,
    );
  }

  res.json(result.preview);
});

export default router;
