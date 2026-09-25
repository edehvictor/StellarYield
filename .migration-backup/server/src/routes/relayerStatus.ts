import { Router } from "express";
import { sendError } from "../utils/errorResponse";
import { getRelayerStatus } from "../services/relayerStatusService";

const relayerStatusRouter = Router();

/**
 * GET /api/relayer/status
 * Read-only endpoint exposing bridge relayer health metrics.
 * Shows queue depth, replay protection state, relay failures, and recent activity.
 */
const handleStatus = (_req: any, res: any) => {
  try {
    const status = getRelayerStatus();
    res.json(status);
  } catch (error) {
    console.error("Failed to serve /api/relayer/status.", error);
    sendError(
      res,
      500,
      "RELAYER_STATUS_FAILED",
      "Unable to fetch relayer status right now.",
    );
  }
};

relayerStatusRouter.get("/", handleStatus);
relayerStatusRouter.get("/status", handleStatus);

export default relayerStatusRouter;
