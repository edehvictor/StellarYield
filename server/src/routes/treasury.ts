import { Router, Request, Response } from "express";
import {
  simulateTreasury,
  saveScenario,
  getScenario,
  listScenarios,
  deleteScenario,
  type TreasuryScenario,
  type AllocationPosition,
} from "../services/treasurySimulationService";

const router = Router();

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
  const { name, totalCapitalUsd, allocations, save: shouldSave } = req.body as {
    name?: string;
    totalCapitalUsd?: number;
    allocations?: unknown;
    save?: boolean;
  };

  if (typeof totalCapitalUsd !== "number" || totalCapitalUsd <= 0) {
    res.status(400).json({ error: "totalCapitalUsd must be a positive number" });
    return;
  }

  if (!validateAllocations(allocations)) {
    res.status(400).json({
      error: "allocations must be a non-empty array summing to 100% with required fields",
    });
    return;
  }

  const scenario: TreasuryScenario = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: typeof name === "string" && name.trim() ? name.trim() : "Unnamed Scenario",
    totalCapitalUsd,
    allocations,
    createdAt: new Date().toISOString(),
  };

  if (shouldSave) {
    saveScenario(scenario);
  }

  const result = simulateTreasury(scenario);
  res.json(result);
});

/**
 * POST /api/treasury/scenarios
 * Save a scenario without simulating.
 */
router.post("/scenarios", (req: Request, res: Response) => {
  const { name, totalCapitalUsd, allocations } = req.body as {
    name?: string;
    totalCapitalUsd?: number;
    allocations?: unknown;
  };

  if (typeof totalCapitalUsd !== "number" || totalCapitalUsd <= 0) {
    res.status(400).json({ error: "totalCapitalUsd must be a positive number" });
    return;
  }

  if (!validateAllocations(allocations)) {
    res.status(400).json({
      error: "allocations must be a non-empty array summing to 100% with required fields",
    });
    return;
  }

  const scenario: TreasuryScenario = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: typeof name === "string" && name.trim() ? name.trim() : "Unnamed Scenario",
    totalCapitalUsd,
    allocations,
    createdAt: new Date().toISOString(),
  };

  saveScenario(scenario);
  res.status(201).json({ id: scenario.id, name: scenario.name, createdAt: scenario.createdAt });
});

/**
 * GET /api/treasury/scenarios
 * List all saved scenarios.
 */
router.get("/scenarios", (_req: Request, res: Response) => {
  res.json(listScenarios());
});

/**
 * GET /api/treasury/scenarios/:id
 * Get a saved scenario and its simulation result.
 */
router.get("/scenarios/:id", (req: Request, res: Response) => {
  const scenario = getScenario(req.params.id);
  if (!scenario) {
    res.status(404).json({ error: "Scenario not found" });
    return;
  }
  res.json({ scenario, simulation: simulateTreasury(scenario) });
});

/**
 * DELETE /api/treasury/scenarios/:id
 */
router.delete("/scenarios/:id", (req: Request, res: Response) => {
  const deleted = deleteScenario(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Scenario not found" });
    return;
  }
  res.status(204).send();
});

export default router;
