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
  assertValidCurrentAllocations,
  buildRebalancingPreview,
  exportRebalancingPreviewJSON,
  exportRebalancingPreviewCSV,
  previewImport,
  TreasuryValidationError,
  RebalancingPreviewError,
  type AllocationPosition,
} from "../services/treasurySimulationService";
import { successEnvelope, errorEnvelope } from "../types/envelope";
import { toExportFailure } from "../types/exportFailure";
import { requireAdmin } from "../middleware/authz";
import {
  validatePolicy,
  evaluatePolicy,
  type PolicyEvaluationContext,
} from "../services/allocationPolicyDsl";
import {
  TreasuryWithdrawalError,
  treasuryWithdrawalCooldownService,
} from "../services/treasuryWithdrawalCooldownService";
import {
  saveSimulationSnapshot,
  listSimulationSnapshots,
  getSimulationSnapshot,
  SimulationSnapshotError,
} from "../services/rebalanceSimulationSnapshotService";

const router = Router();

/**
 * Emit a typed error envelope for treasury export routes (#1122).
 *
 * Validation errors keep their original code and gain `category: "validation"`
 * so the UI can branch on category without knowing every code. Anything else
 * is classified deterministically (timeout / service failure) via
 * `toExportFailure` instead of being reported as a generic invalid request.
 */
function sendTreasuryExportError(res: Response, err: unknown, route: string): void {
  if (err instanceof TreasuryValidationError || err instanceof RebalancingPreviewError) {
    res.status(err.statusCode).json(
      errorEnvelope(err.code, err.message, route, err.details, {
        category: "validation",
        retryable: false,
      }),
    );
    return;
  }

  const failure = toExportFailure(err);
  res.status(failure.httpStatus).json(
    errorEnvelope(failure.code, failure.message, route, failure.details, {
      category: failure.category,
      retryable: failure.retryable,
    }),
  );
}

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
router.post("/simulate", requireAdmin, async (req: Request, res: Response) => {
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

    // #1419: persist a point-in-time snapshot of this result on request.
    // Best-effort — a snapshot-persistence failure never fails the
    // simulation itself, since the (already-computed) result is still
    // valid and useful without history.
    let snapshotId: string | undefined;
    if (req.body.snapshot) {
      try {
        const snapshot = await saveSimulationSnapshot(scenario, result, { saved: !!req.body.save });
        snapshotId = snapshot.id;
      } catch {
        // Swallowed intentionally — see comment above.
      }
    }

    res.json(successEnvelope({ ...result, snapshotId }, "treasury/simulate", warnings));
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
router.post("/compare", treasuryMutationLimiter, requireAdmin, (req: Request, res: Response) => {
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
router.post("/export-comparison", treasuryMutationLimiter, requireAdmin, (req: Request, res: Response) => {
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
    res.setHeader('Content-Disposition', `attachment; filename="treasury_scenario_comparison.json"`);
    res.status(200).send(jsonStr);
  } catch (err) {
    sendTreasuryExportError(res, err, "treasury/export-comparison");
  }
});

/**
 * POST /api/treasury/rebalancing/preview/export
 * Deterministically export the rebalancing preview between a target scenario
 * and an optional current allocation set (JSON or CSV). The export contains no
 * wall-clock timestamp, so identical inputs produce byte-identical files.
 */
router.post(
  "/rebalancing/preview/export",
  treasuryMutationLimiter,
  (req: Request, res: Response) => {
    try {
      const scenario = assertValidScenarioInput({
        ...req.body,
        id: String(req.body.id ?? "rebalancing-preview")
          .trim(),
      });
      const currentAllocations = assertValidCurrentAllocations(
        req.body.currentAllocations,
      );
      const preview = buildRebalancingPreview(scenario, currentAllocations);
      const format = String(req.body.format || "json").toLowerCase();

      if (format === "csv") {
        const csv = exportRebalancingPreviewCSV(preview);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="treasury_rebalancing_preview.csv"`,
        );
        res.status(200).send(csv);
        return;
      }

      const jsonStr = exportRebalancingPreviewJSON(preview);
      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="treasury_rebalancing_preview.json"`,
      );
      res.status(200).send(jsonStr);
    } catch (err) {
      sendTreasuryExportError(res, err, "treasury/rebalancing/preview/export");
    }
  },
);

/**
 * POST /api/treasury/scenarios
 * Save a scenario without simulating.
 */
router.post("/scenarios", requireAdmin, (req: Request, res: Response) => {
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
router.delete("/scenarios/:id", requireAdmin, (req: Request, res: Response) => {
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
 * POST /api/treasury/policy/dry-run
 * Validate (and optionally evaluate) an allocation policy without persisting it.
 *
 * Never calls storePolicy — the policy store is left untouched. Optional
 * `contexts` run evaluatePolicy against each provided vault context so callers
 * can preview rule matches before committing a policy.
 */
router.post("/policy/dry-run", requireAdmin, (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      policy?: unknown;
      contexts?: unknown;
    };

    if (body.policy === undefined) {
      res.status(400).json(
        errorEnvelope(
          "INVALID_POLICY",
          "Request body must include a `policy` object.",
          "treasury/policy/dry-run",
        ),
      );
      return;
    }

    const validation = validatePolicy(body.policy);
    if (!validation.ok) {
      res.status(422).json(
        errorEnvelope(
          "INVALID_POLICY",
          "Policy failed validation.",
          "treasury/policy/dry-run",
          { errors: validation.errors },
        ),
      );
      return;
    }

    let evaluations: ReturnType<typeof evaluatePolicy>[] | undefined;
    if (body.contexts !== undefined) {
      if (!Array.isArray(body.contexts)) {
        res.status(400).json(
          errorEnvelope(
            "INVALID_POLICY",
            "`contexts` must be an array of evaluation contexts when provided.",
            "treasury/policy/dry-run",
          ),
        );
        return;
      }
      evaluations = body.contexts.map((raw) =>
        evaluatePolicy(validation.policy, raw as PolicyEvaluationContext),
      );
    }

    res.json(
      successEnvelope(
        {
          policy: validation.policy,
          persisted: false,
          evaluations,
        },
        "treasury/policy/dry-run",
      ),
    );
  } catch {
    res.status(400).json(
      errorEnvelope(
        "INVALID_POLICY",
        "Invalid request body",
        "treasury/policy/dry-run",
      ),
    );
  }
});

/**
 * POST /api/treasury/cashflow/preview
 * Validate an array of cashflow rows before importing.
 */
router.post("/cashflow/preview", requireAdmin, (req: Request, res: Response) => {
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
router.post("/cashflow/import", requireAdmin, (req: Request, res: Response) => {
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

// ── Treasury withdrawal cooldown (#1343) ─────────────────────────────────────

/**
 * Emit a typed error envelope for treasury withdrawal cooldown routes.
 * `COOLDOWN_ACTIVE` is retryable once the cooldown lapses; validation and
 * not-found failures are not.
 */
function sendWithdrawalError(res: Response, err: unknown, route: string): void {
  if (err instanceof TreasuryWithdrawalError) {
    const classification =
      err.code === "COOLDOWN_ACTIVE"
        ? { category: "validation", retryable: true }
        : { category: "validation", retryable: false };
    res.status(err.statusCode).json(
      errorEnvelope(err.code, err.message, route, err.details, classification),
    );
    return;
  }
  res.status(400).json(
    errorEnvelope("INVALID_REQUEST", "Invalid request body", route),
  );
}

/**
 * POST /api/treasury/withdrawals
 * Submit a treasury withdrawal request (admin only). Enforces the per-vault
 * cooldown: 409 COOLDOWN_ACTIVE while a recent pending withdrawal still
 * consumes the vault's cooldown window.
 */
router.post(
  "/withdrawals",
  treasuryMutationLimiter,
  requireAdmin,
  (req: Request, res: Response) => {
    try {
      const withdrawal = treasuryWithdrawalCooldownService.submitWithdrawal({
        vaultId: req.body?.vaultId,
        amountUsd: req.body?.amountUsd,
        requestedBy:
          req.body?.requestedBy ??
          (req as Request & { user?: { id?: string } }).user?.id,
        memo: req.body?.memo,
      });
      res.status(201).json(successEnvelope(withdrawal, "treasury/withdrawals"));
    } catch (err) {
      sendWithdrawalError(res, err, "treasury/withdrawals");
    }
  },
);

/**
 * GET /api/treasury/withdrawals
 * List withdrawal requests (admin only), newest first. Optional
 * `?vaultId=` filter.
 */
router.get("/withdrawals", requireAdmin, (req: Request, res: Response) => {
  const vaultId =
    typeof req.query.vaultId === "string" && req.query.vaultId.length > 0
      ? { vaultId: req.query.vaultId }
      : {};
  res.json(
    successEnvelope(
      treasuryWithdrawalCooldownService.listWithdrawals(vaultId),
      "treasury/withdrawals",
    ),
  );
});

/**
 * GET /api/treasury/withdrawals/cooldown?vaultId=...
 * Cooldown status for a vault (admin only): whether a new submission would
 * be rejected, remaining time, and the blocking pending withdrawal.
 */
router.get("/withdrawals/cooldown", requireAdmin, (req: Request, res: Response) => {
  const vaultId = req.query.vaultId;
  if (typeof vaultId !== "string" || vaultId.trim().length === 0) {
    res.status(400).json(
      errorEnvelope(
        "INVALID_REQUEST",
        "vaultId query parameter is required.",
        "treasury/withdrawals/cooldown",
        { field: "vaultId" },
      ),
    );
    return;
  }
  res.json(
    successEnvelope(
      treasuryWithdrawalCooldownService.getCooldownStatus(vaultId.trim()),
      "treasury/withdrawals/cooldown",
    ),
  );
});

/**
 * POST /api/treasury/withdrawals/:id/cancel
 * Cancel a pending withdrawal (admin only), freeing its vault's cooldown
 * immediately.
 */
router.post(
  "/withdrawals/:id/cancel",
  treasuryMutationLimiter,
  requireAdmin,
  (req: Request, res: Response) => {
    try {
      const withdrawal = treasuryWithdrawalCooldownService.cancelWithdrawal(
        req.params.id,
      );
      res.json(successEnvelope(withdrawal, "treasury/withdrawals"));
    } catch (err) {
      sendWithdrawalError(res, err, "treasury/withdrawals");
    }
  },
);

function sendSnapshotError(res: Response, err: unknown, route: string): void {
  if (err instanceof SimulationSnapshotError) {
    res.status(err.statusCode).json(errorEnvelope(err.code, err.message, route));
    return;
  }
  res.status(503).json(
    errorEnvelope("SNAPSHOT_UNAVAILABLE", "Simulation snapshot storage is unavailable.", route),
  );
}

/**
 * GET /api/treasury/simulation-snapshots
 *
 * #1419 — Lists persisted rebalance-simulation result snapshots,
 * newest first. Optionally scoped to one scenario via `?scenarioId=`.
 * Cursor-paginated via `?cursor=` (a snapshot id) and `?limit=`.
 */
router.get("/simulation-snapshots", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { scenarioId, cursor } = req.query;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const page = await listSimulationSnapshots({
      scenarioId: typeof scenarioId === "string" ? scenarioId : undefined,
      cursor: typeof cursor === "string" ? cursor : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    res.json(successEnvelope(page, "treasury/simulation-snapshots"));
  } catch (err) {
    sendSnapshotError(res, err, "treasury/simulation-snapshots");
  }
});

/**
 * GET /api/treasury/simulation-snapshots/:id
 *
 * #1419 — Fetches one persisted simulation snapshot by id.
 */
router.get("/simulation-snapshots/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const snapshot = await getSimulationSnapshot(req.params.id);
    res.json(successEnvelope(snapshot, "treasury/simulation-snapshots"));
  } catch (err) {
    sendSnapshotError(res, err, "treasury/simulation-snapshots");
  }
});

export default router;
