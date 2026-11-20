/**
 * Soroban RPC Status & Failover Router
 *
 * Exposes endpoints for monitoring Soroban RPC node health, active endpoint state,
 * failover events, Prometheus metrics integration, and operator failover triggers.
 */

import { Router, Request, Response } from "express";
import {
  sorobanRpcFailoverService,
  SorobanRpcFailoverError,
} from "../services/sorobanRpcFailoverService";
import { sorobanRpcAlertService } from "../services/sorobanRpcAlertService";

const router = Router();

/**
 * GET /api/rpc/status
 *
 * Full status snapshot of Soroban RPC endpoints, active node, failover counters,
 * and recent alert hooks.
 */
router.get("/status", (_req: Request, res: Response) => {
  try {
    const snapshot = sorobanRpcFailoverService.getStatusSnapshot();
    res.json(snapshot);
  } catch (err) {
    console.error("[sorobanRpc] Failed to retrieve status snapshot:", err);
    res.status(500).json({
      error: "Unable to retrieve Soroban RPC status snapshot",
      code: "RPC_STATUS_RETRIEVAL_FAILED",
    });
  }
});

/**
 * GET /api/rpc/health
 *
 * Quick health probe for deployment checks and upstream monitors.
 * Returns 200 (healthy on primary), 200 (degraded on fallback node), or 503 (all down).
 */
router.get("/health", (_req: Request, res: Response) => {
  const snapshot = sorobanRpcFailoverService.getStatusSnapshot();

  if (snapshot.status === "all_down") {
    res.status(503).json({
      status: "unavailable",
      activeEndpoint: snapshot.activeEndpoint,
      error: "All Soroban RPC endpoints are unreachable.",
      code: "ALL_SOROBAN_RPC_ENDPOINTS_DOWN",
      retryable: true,
      timestamp: snapshot.timestamp,
    });
    return;
  }

  if (snapshot.status === "failover_active") {
    res.status(200).json({
      status: "degraded",
      activeEndpoint: snapshot.activeEndpoint,
      activePriority: snapshot.activePriority,
      warning: "Operating on backup/failover Soroban RPC node.",
      totalFailovers: snapshot.totalFailovers,
      timestamp: snapshot.timestamp,
    });
    return;
  }

  res.status(200).json({
    status: "healthy",
    activeEndpoint: snapshot.activeEndpoint,
    activePriority: 0,
    timestamp: snapshot.timestamp,
  });
});

/**
 * POST /api/rpc/failover
 *
 * Trigger manual failover or switch to a specified target endpoint.
 * Useful for operator drills or maintenance windows.
 */
router.post("/failover", async (req: Request, res: Response) => {
  try {
    const { targetEndpoint, reason } = req.body as {
      targetEndpoint?: string;
      reason?: string;
    };

    const result = await sorobanRpcFailoverService.manualFailover(
      targetEndpoint,
      reason ?? "Operator initiated manual failover",
    );

    res.json({
      success: true,
      message: `Soroban RPC failover executed successfully.`,
      activeEndpoint: result.activeEndpoint,
      previousEndpoint: result.previousEndpoint,
      snapshot: sorobanRpcFailoverService.getStatusSnapshot(),
    });
  } catch (err) {
    console.error("[sorobanRpc] Manual failover failed:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Manual failover failed",
      code: "MANUAL_FAILOVER_FAILED",
    });
  }
});

/**
 * POST /api/rpc/probe
 *
 * Probes all endpoints and triggers failback to primary if recovered.
 */
router.post("/probe", async (_req: Request, res: Response) => {
  try {
    await sorobanRpcFailoverService.probeAndRecover();
    res.json({
      success: true,
      snapshot: sorobanRpcFailoverService.getStatusSnapshot(),
    });
  } catch (err) {
    console.error("[sorobanRpc] Probe and recovery failed:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Probe and recovery failed",
      code: "PROBE_RECOVERY_FAILED",
    });
  }
});

/**
 * POST /api/rpc/reset
 *
 * Resets metrics and restore primary endpoint.
 */
router.post("/reset", (_req: Request, res: Response) => {
  sorobanRpcFailoverService.reset();
  res.json({
    success: true,
    message: "Soroban RPC failover metrics reset successfully.",
    snapshot: sorobanRpcFailoverService.getStatusSnapshot(),
  });
});

/**
 * GET /api/rpc/alerts
 *
 * Retrieve recent Soroban RPC alert hook history.
 */
router.get("/alerts", (_req: Request, res: Response) => {
  const alerts = sorobanRpcAlertService.getHistory();
  res.json({ alerts, total: alerts.length });
});

export default router;
