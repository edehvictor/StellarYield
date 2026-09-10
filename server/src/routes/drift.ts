import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  DriftService,
  DriftSignal,
  GroupingOptions,
  AnomalySeverityBand,
} from "../services/driftService";

const router = Router();

const driftRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many drift detection requests. Please try again later." },
});

/**
 * POST /api/drift/group
 * Group an arbitrary collection of drift signals across portfolio, vault, and strategy services.
 */
router.post("/group", driftRateLimiter, (req: Request, res: Response) => {
  try {
    const { signals, options } = req.body as {
      signals?: DriftSignal[];
      options?: GroupingOptions;
    };

    if (!Array.isArray(signals)) {
      res.status(400).json({ error: "signals must be an array of DriftSignal objects" });
      return;
    }

    const grouped = DriftService.groupSignals(signals, options);
    res.json({ success: true, data: grouped });
  } catch (error) {
    res.status(500).json({
      error: "Failed to group drift signals",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/drift/evaluate
 * Evaluates current vault USD allocations and external signals, records state, and returns grouped anomalies.
 */
router.post("/evaluate", driftRateLimiter, async (req: Request, res: Response) => {
  try {
    const { vaultValuesUsd, externalSignals, options } = req.body as {
      vaultValuesUsd?: Record<string, number>;
      externalSignals?: DriftSignal[];
      options?: GroupingOptions;
    };

    if (!vaultValuesUsd || typeof vaultValuesUsd !== "object") {
      res.status(400).json({ error: "vaultValuesUsd must be a mapping of vaultId to USD value" });
      return;
    }

    const grouped = await DriftService.evaluateGroupedDriftEvents(
      vaultValuesUsd,
      Array.isArray(externalSignals) ? externalSignals : [],
      options
    );

    res.json({ success: true, data: grouped });
  } catch (error) {
    res.status(500).json({
      error: "Failed to evaluate grouped drift events",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/drift/anomalies
 * Retrieves active grouped anomalies with optional filtering by source, severity, or asset.
 */
router.get("/anomalies", (req: Request, res: Response) => {
  try {
    let anomalies = DriftService.getActiveGroupedAnomalies();

    const { source, severity, asset } = req.query as {
      source?: string;
      severity?: string;
      asset?: string;
    };

    if (source) {
      const srcUpper = source.toLowerCase();
      anomalies = anomalies.filter((a) => a.sources.some((s) => s.toLowerCase() === srcUpper));
    }

    if (severity) {
      const sevUpper = severity.toUpperCase() as AnomalySeverityBand;
      anomalies = anomalies.filter((a) => a.aggregateSeverity === sevUpper);
    }

    if (asset) {
      const assetUpper = asset.toLowerCase();
      anomalies = anomalies.filter(
        (a) => a.primaryAsset.toLowerCase() === assetUpper || a.signals.some((s) => s.asset.toLowerCase() === assetUpper)
      );
    }

    res.json({ success: true, count: anomalies.length, data: anomalies });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch active drift anomalies",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
