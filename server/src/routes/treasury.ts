import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  simulateTreasury,
  compareTreasuryScenarios,
  exportComparisonJSON,
  exportComparisonCSV,
  saveScenario,
  getScenario,
  listScenarios,
  deleteScenario,
  assertValidScenarioInput,
  previewImport,
  TreasuryValidationError,
} from "../services/treasurySimulationService";
import { successEnvelope, errorEnvelope } from "../types/envelope";

const router = Router();

// #935 — treasury simulation/mutation endpoints are compute- and storage-heavy;
// rate-limit to prevent burst abuse with a clear 429 error response.
const treasuryMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many treasury requests. Please try again later." },
});
function validateAllocations(allocations: unknown): allocations is AllocationPosition[] {
  if (!Array.isArray(allocations) || allocations.length === 0) return false;
  const total = (allocations as AllocationPosition[]).reduce(
    (sum, a) => sum + (a.allocationPct ?? 0),
    0,
  );
  if (Math.abs(total - 100) > 0.01) return false;
  return (allocations as AllocationPosition[]).every(
    (a) =>
      typeof a.vaultId === "string" &&
      typeof a.vaultName === "string" &&
      typeof a.allocationPct === "number" &&
      typeof a.apy === "number" &&
      typeof a.tvlUsd === "number" &&
      typeof a.riskScore === "number" &&
      typeof a.rotationCostPct === "number",
  );
}

/**
 * POST /api/treasury/simulate
 * Run a treasury simulation. Optionally saves the scenario.
 */
router.post("/simulate", (req: Request, res: Response) => {
  try {
    const scenario = assertValidScenarioInput({
      ...req.body,
      id: req.body.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    if (req.body.save) {
      saveScenario(scenario);
    }

    const result = simulateTreasury(scenario);
    const warnings = result.concentrationWarnings.length > 0
      ? result.concentrationWarnings
      : undefined;

    res.json(successEnvelope(result, "treasury/simulate", warnings));
  } catch (err) {
    if (err instanceof TreasuryValidationError) {
      res.status(err.statusCode).json(
        errorEnvelope(err.code, err.message, "treasury/simulate", err.details),
      );
      return;
    }
    res.status(400).json(
      errorEnvelope("INVALID_REQUEST", "Invalid request body", "treasury/simulate"),
    );
  }
});

/**
 * POST /api/treasury/compare
 * Run scenario comparison for baseline versus selected stress runs.
 */
router.post("/compare", treasuryMutationLimiter, (req: Request, res: Response) => {
  try {
    const scenario = assertValidScenarioInput({
      ...req.body,
      id: req.body.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const stressRunIds = Array.isArray(req.body.stressRunIds) ? req.body.stressRunIds : undefined;
    const comparison = compareTreasuryScenarios(scenario, stressRunIds);
    const warnings = comparison.summary.totalWarningsCount > 0
      ? comparison.baseline.warnings
      : undefined;

    res.json(successEnvelope(comparison, "treasury/compare", warnings));
  } catch (err) {
    if (err instanceof TreasuryValidationError) {
      res.status(err.statusCode).json(
        errorEnvelope(err.code, err.message, "treasury/compare", err.details),
      );
      return;
    }
    res.status(400).json(
      errorEnvelope("INVALID_REQUEST", "Invalid request body", "treasury/compare"),
    );
  }
});

/**
 * POST /api/treasury/export-comparison
 * Export baseline versus stress scenario comparison in CSV or JSON format.
 */
router.post("/export-comparison", treasuryMutationLimiter, (req: Request, res: Response) => {
  try {
    const scenario = assertValidScenarioInput({
      ...req.body,
      id: req.body.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const stressRunIds = Array.isArray(req.body.stressRunIds) ? req.body.stressRunIds : undefined;
    const comparison = compareTreasuryScenarios(scenario, stressRunIds);
    const format = String(req.body.format || "json").toLowerCase();

    if (format === "csv") {
      const csv = exportComparisonCSV(comparison);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="treasury_scenario_comparison.csv"`);
      res.status(200).send(csv);
      return;
    }

    const jsonStr = exportComparisonJSON(comparison);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="treasury_scenario_comparison.json"`);
    res.status(200).send(jsonStr);
  } catch (err) {
    if (err instanceof TreasuryValidationError) {
      res.status(err.statusCode).json(
        errorEnvelope(err.code, err.message, "treasury/export-comparison", err.details),
      );
      return;
    }
    res.status(400).json(
      errorEnvelope("INVALID_REQUEST", "Invalid request body", "treasury/export-comparison"),
    );
  }
});

/**
 * POST /api/treasury/scenarios
 * Save a scenario without simulating.
 */
router.post("/scenarios", (req: Request, res: Response) => {
  try {
    const scenario = assertValidScenarioInput({
      ...req.body,
      id: req.body.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    saveScenario(scenario);
    res.status(201).json(
      successEnvelope(
        { id: scenario.id, name: scenario.name, createdAt: scenario.createdAt },
        "treasury/scenarios",
      ),
    );
  } catch (err) {
    if (err instanceof TreasuryValidationError) {
      res.status(err.statusCode).json(
        errorEnvelope(err.code, err.message, "treasury/scenarios", err.details),
      );
      return;
    }
    res.status(400).json(
      errorEnvelope("INVALID_REQUEST", "Invalid request body", "treasury/scenarios"),
    );
  }
});

/**
 * GET /api/treasury/scenarios
 * List all saved scenarios.
 */
router.get("/scenarios", (_req: Request, res: Response) => {
  res.json(successEnvelope(listScenarios(), "treasury/scenarios"));
});

/**
 * GET /api/treasury/scenarios/:id
 * Get a saved scenario and its simulation result.
 */
router.get("/scenarios/:id", (req: Request, res: Response) => {
  const scenario = getScenario(req.params.id);
  if (!scenario) {
    res.status(404).json(
      errorEnvelope("NOT_FOUND", "Scenario not found", "treasury/scenarios"),
    );
    return;
  }
  const simulation = simulateTreasury(scenario);
  const warnings = simulation.concentrationWarnings.length > 0
    ? simulation.concentrationWarnings
    : undefined;
  res.json(successEnvelope({ scenario, simulation }, "treasury/scenarios", warnings));
});

/**
 * DELETE /api/treasury/scenarios/:id
 */
router.delete("/scenarios/:id", (req: Request, res: Response) => {
  const deleted = deleteScenario(req.params.id);
  if (!deleted) {
    res.status(404).json(
      errorEnvelope("NOT_FOUND", "Scenario not found", "treasury/scenarios"),
    );
    return;
  }
  res.status(204).send();
});

/**
 * POST /api/treasury/cashflow/preview
 * Validate an array of cashflow rows before importing.
 */
router.post("/cashflow/preview", (req: Request, res: Response) => {
  const rows = req.body.rows ?? req.body;
  if (!Array.isArray(rows)) {
    res.status(400).json(
      errorEnvelope(
        "VALIDATION_ERROR",
        "Request body must contain an array of cashflow rows.",
        "treasury/cashflow/preview",
      ),
    );
    return;
  }
  const preview = previewImport(rows);
  const warnings = preview.warnings?.map((w: { code: string; message: string }) => w.message);
  res.json(successEnvelope(preview, "treasury/cashflow/preview", warnings));
});

/**
 * POST /api/treasury/cashflow/import
 * Validate and store cashflow rows for a scenario.
 * For now this is a stub that delegates to previewImport and returns success.
 */
router.post("/cashflow/import", (req: Request, res: Response) => {
  const { scenarioId, rows } = req.body;
  if (!scenarioId || !Array.isArray(rows)) {
    res.status(400).json(
      errorEnvelope(
        "VALIDATION_ERROR",
        "scenarioId and rows array are required.",
        "treasury/cashflow/import",
      ),
    );
    return;
  }
  const preview = previewImport(rows);
  if (preview.errors.length > 0) {
    res.status(422).json(
      errorEnvelope(
        "CASHFLOW_VALIDATION_ERROR",
        "Cashflow rows contain validation errors.",
        "treasury/cashflow/import",
        { preview },
      ),
    );
    return;
  }
  // Future: persist rows to scenarioStore or a separate store
  res.status(201).json(
    successEnvelope(
      { imported: preview.validRows.length, preview },
      "treasury/cashflow/import",
    ),
  );
});

export default router;
