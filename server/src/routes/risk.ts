import { Router, Request, Response } from "express";
import { riskPreferenceDriftService, type RiskPreference, type UserRiskProfile, type PortfolioBehavior } from "../services/riskPreferenceDriftService";
import { stressMatrixService } from "../services/stressMatrixService";
import { apyDispersionService, type ProviderApyInput } from "../services/apyDispersionService";

const router = Router();

const VALID_PREFERENCES: RiskPreference[] = ["conservative", "balanced", "aggressive"];

/**
 * POST /api/risk/drift/detect
 * Detect risk preference drift for a user's portfolio.
 */
router.post("/drift/detect", (req: Request, res: Response) => {
  try {
    const { userId, statedPreference, positions } = req.body as {
      userId?: string;
      statedPreference?: string;
      positions?: PortfolioBehavior["positions"];
    };

    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    if (!statedPreference || !VALID_PREFERENCES.includes(statedPreference as RiskPreference)) {
      res.status(400).json({ error: `statedPreference must be one of: ${VALID_PREFERENCES.join(", ")}` });
      return;
    }

    if (!Array.isArray(positions) || positions.length === 0) {
      res.status(400).json({ error: "positions must be a non-empty array" });
      return;
    }

    const profile: UserRiskProfile = {
      userId,
      statedPreference: statedPreference as RiskPreference,
      maxConcentrationPct: 0,
      maxVolatilityPct: 0,
      minLiquidityUsd: 0,
    };

    const behavior: PortfolioBehavior = {
      currentConcentrationPct: Math.max(...positions.map(p => p.weightPct)),
      currentVolatilityPct: 0,
      currentLiquidityUsd: 0,
      positions,
    };

    const result = riskPreferenceDriftService.detectDrift(profile, behavior);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({
      error: "Failed to detect risk preference drift",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/risk/drift/thresholds/:preference
 * Get drift thresholds for a risk preference.
 */
router.get("/drift/thresholds/:preference", (req: Request, res: Response) => {
  const { preference } = req.params;

  if (!VALID_PREFERENCES.includes(preference as RiskPreference)) {
    res.status(400).json({ error: `preference must be one of: ${VALID_PREFERENCES.join(", ")}` });
    return;
  }

  const thresholds = riskPreferenceDriftService.getThresholdsForPreference(preference as RiskPreference);
  res.json({ success: true, data: { preference, thresholds } });
});

/**
 * POST /api/risk/dispersion/compute
 * Compute APY dispersion for a strategy with provider inputs.
 */
router.post("/dispersion/compute", (req: Request, res: Response) => {
  try {
    const { strategyId, strategyName, inputs } = req.body as {
      strategyId?: string;
      strategyName?: string;
      inputs?: ProviderApyInput[];
    };

    if (!strategyId) {
      res.status(400).json({ error: "strategyId is required" });
      return;
    }

    if (!Array.isArray(inputs)) {
      res.status(400).json({ error: "inputs must be an array" });
      return;
    }

    const result = apyDispersionService.computeDispersion(
      strategyId,
      strategyName || strategyId,
      inputs,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({
      error: "Failed to compute APY dispersion",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/risk/dispersion/config
 * Get current dispersion configuration.
 */
router.get("/dispersion/config", (_req: Request, res: Response) => {
  res.json({ success: true, data: apyDispersionService.getConfig() });
});

/**
 * POST /api/risk/dispersion/config
 * Update dispersion configuration.
 */
router.post("/dispersion/config", (req: Request, res: Response) => {
  try {
    const config = req.body;
    apyDispersionService.updateConfig(config);
    res.json({ success: true, data: apyDispersionService.getConfig() });
  } catch (error) {
    res.status(500).json({
      error: "Failed to update dispersion config",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/risk/stress-matrix/run
 * Run the full stress matrix.
 */
router.get("/stress-matrix/run", (_req: Request, res: Response) => {
  try {
    const result = stressMatrixService.runMatrix();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({
      error: "Failed to run stress matrix",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/risk/stress-matrix/scenarios
 * Get all stress scenarios.
 */
router.get("/stress-matrix/scenarios", (_req: Request, res: Response) => {
  res.json({ success: true, data: stressMatrixService.getScenarios() });
});

/**
 * POST /api/risk/stress-matrix/scenarios
 * Add a custom stress scenario.
 */
router.post("/stress-matrix/scenarios", (req: Request, res: Response) => {
  try {
    const scenario = req.body;
    if (!scenario.id || !scenario.name || !scenario.factors) {
      res.status(400).json({ error: "Scenario must have id, name, and factors" });
      return;
    }
    stressMatrixService.addScenario(scenario);
    res.json({ success: true, message: `Scenario ${scenario.id} added` });
  } catch (error) {
    res.status(500).json({
      error: "Failed to add scenario",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * DELETE /api/risk/stress-matrix/scenarios/:scenarioId
 * Remove a stress scenario.
 */
router.delete("/stress-matrix/scenarios/:scenarioId", (req: Request, res: Response) => {
  const { scenarioId } = req.params;
  const removed = stressMatrixService.removeScenario(scenarioId);

  if (!removed) {
    res.status(404).json({ error: `Scenario ${scenarioId} not found` });
    return;
  }

  res.json({ success: true, message: `Scenario ${scenarioId} removed` });
});

export default router;
