import { Router, Request, Response } from "express";
import {
  simulateDeposit,
  SimulationParams,
  simulateRebalance,
  validateRebalanceParams,
  runRebalanceBacktest,
  validateRebalanceBacktestParams,
  type RebalanceParams,
  type RebalanceBacktestParams,
} from "../services/simulationService";
import {
  simulateFailover,
  DEFAULT_FAILOVER_THRESHOLDS,
  type FailoverSimulationInput,
  type ProtocolSimulationFixture,
} from "../services/protocolFailoverService";

const router = Router();

router.post("/deposit", (req: Request, res: Response) => {
  try {
    const { strategyId, amount, token } = req.body;

    if (!strategyId || amount === undefined || amount === null || !token) {
      res.status(400).json({
        error: "Missing required fields: strategyId, amount, token",
      });
      return;
    }

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount < 0) {
      res.status(400).json({
        error: "amount must be a positive number",
      });
      return;
    }

    const params: SimulationParams = {
      strategyId: String(strategyId),
      amount: numAmount,
      token: String(token),
    };

    const result = simulateDeposit(params);
    
    // Safety check - ensuring it's clearly marked as simulation output
    res.json({
      ...result,
      isSimulationOnly: true, // redundancy
    });
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : "Simulation failed",
    });
  }
});

/**
 * POST /api/simulator/rebalance
 *
 * Sandbox preview of a portfolio rebalance: projected blended APY before/after,
 * estimated turnover fees, per-leg allocation drift, and warnings for high
 * fees, stale data, and liquidity risk. Simulation-only — never executes a
 * rebalance.
 */
router.post("/rebalance", (req: Request, res: Response) => {
  try {
    const params = req.body as RebalanceParams;

    const validationErrors = validateRebalanceParams(params);
    if (validationErrors.length > 0) {
      res.status(400).json({
        error: "Invalid rebalance parameters",
        details: validationErrors,
      });
      return;
    }

    const preview = simulateRebalance(params);
    res.json(preview);
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : "Rebalance simulation failed",
    });
  }
});

/**
 * POST /api/simulator/rebalance-backtest
 *
 * Runs a deterministic historical rebalance backtest and compares the
 * rebalanced portfolio against a passive-hold benchmark. Simulation-only.
 */
router.post("/rebalance-backtest", (req: Request, res: Response) => {
  try {
    const params = req.body as RebalanceBacktestParams;
    const errors = validateRebalanceBacktestParams(params);
    if (errors.length > 0) {
      res.status(400).json({ error: "Invalid backtest parameters", details: errors });
      return;
    }
    const result = runRebalanceBacktest(params);
    res.json(result);
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : "Rebalance backtest failed",
    });
  }
});

/**
 * POST /api/simulator/failover
 *
 * Dry-run a failover pass against synthetic protocol health fixtures.
 * Returns which protocols would be included or excluded, per-protocol
 * evaluations, and the decision log — all clearly marked simulationOnly.
 *
 * This endpoint is read-only and never touches the live failoverRegistry,
 * so it cannot affect production state under any circumstances.
 *
 * Request body:
 *   fixtures    — array of protocol health snapshots to evaluate
 *   thresholds  — (optional) override failover thresholds for this run
 *
 * Example fixture for a simulated outage:
 *   { "id": "blend", "name": "Blend", "status": "down" }
 *
 * Example fixture for a stale-data scenario:
 *   { "id": "blend", "name": "Blend", "status": "healthy",
 *     "lastUpdatedAt": "2020-01-01T00:00:00.000Z" }
 */
router.post("/failover", (req: Request, res: Response) => {
  const { fixtures, thresholds } = req.body as Partial<FailoverSimulationInput>;

  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    res.status(400).json({
      error: "fixtures must be a non-empty array of protocol health snapshots.",
    });
    return;
  }

  const VALID_STATUSES = new Set(["healthy", "degraded", "critical", "down", "unknown"]);

  const validationErrors: string[] = [];
  (fixtures as ProtocolSimulationFixture[]).forEach((f, i) => {
    if (typeof f.id !== "string" || !f.id.trim()) {
      validationErrors.push(`fixtures[${i}].id must be a non-empty string`);
    }
    if (typeof f.name !== "string" || !f.name.trim()) {
      validationErrors.push(`fixtures[${i}].name must be a non-empty string`);
    }
    if (!VALID_STATUSES.has(f.status)) {
      validationErrors.push(
        `fixtures[${i}].status must be one of: ${[...VALID_STATUSES].join(", ")}`,
      );
    }
    if (f.lastUpdatedAt !== undefined && isNaN(Date.parse(f.lastUpdatedAt))) {
      validationErrors.push(`fixtures[${i}].lastUpdatedAt must be a valid ISO-8601 timestamp`);
    }
    if (f.providerUptime !== undefined) {
      const u = Number(f.providerUptime);
      if (!Number.isFinite(u) || u < 0 || u > 1) {
        validationErrors.push(`fixtures[${i}].providerUptime must be a number in [0, 1]`);
      }
    }
    if (f.recentErrorCount !== undefined) {
      const e = Number(f.recentErrorCount);
      if (!Number.isFinite(e) || e < 0 || !Number.isInteger(e)) {
        validationErrors.push(`fixtures[${i}].recentErrorCount must be a non-negative integer`);
      }
    }
  });

  if (validationErrors.length > 0) {
    res.status(400).json({ error: "Invalid simulation input", details: validationErrors });
    return;
  }

  // Sanitise thresholds — only accept known numeric/array keys; ignore anything else.
  let safeThresholds: Partial<typeof DEFAULT_FAILOVER_THRESHOLDS> | undefined;
  if (thresholds && typeof thresholds === "object") {
    safeThresholds = {};
    if (typeof thresholds.maxDataAgeMs === "number" && thresholds.maxDataAgeMs > 0) {
      safeThresholds.maxDataAgeMs = thresholds.maxDataAgeMs;
    }
    if (typeof thresholds.minUptimeRatio === "number" &&
        thresholds.minUptimeRatio >= 0 && thresholds.minUptimeRatio <= 1) {
      safeThresholds.minUptimeRatio = thresholds.minUptimeRatio;
    }
    if (typeof thresholds.maxRecentErrors === "number" && thresholds.maxRecentErrors >= 0) {
      safeThresholds.maxRecentErrors = thresholds.maxRecentErrors;
    }
  }

  try {
    const result = simulateFailover({ fixtures, thresholds: safeThresholds });
    res.json(result);
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : "Failover simulation failed",
    });
  }
});

export default router;
