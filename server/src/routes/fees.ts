import { Router } from "express";
import {
  getFeeOracleEstimate,
  getFeeDeviationAlert,
  getNetworkFeeBuffer,
  applyFeeBuffer,
  NETWORK_FEE_BUFFERS,
} from "../services/feeOracleService";
import { sendError } from "../utils/errorResponse";

const feesRouter = Router();

feesRouter.get("/", async (_req, res) => {
  try {
    const feeData = await getFeeOracleEstimate();
    res.json(feeData);
  } catch (error) {
    console.error("Failed to serve /api/fees", error);
    sendError(res, 500, "FEE_ESTIMATE_FAILED", "Unable to estimate fees right now.");
  }
});

feesRouter.get("/alert", async (_req, res) => {
  try {
    const result = await getFeeDeviationAlert();
    res.json(result);
  } catch (error) {
    console.error("Failed to serve /api/fees/alert", error);
    sendError(res, 500, "FEE_ALERT_FAILED", "Unable to compute fee deviation alert.");
  }
});

/**
 * GET /api/fees/buffer
 * Returns per-network fee buffer configuration (#1188).
 * Includes the default and all known network-specific buffers.
 *
 * Optional query param: ?passphrase=<network_passphrase>
 * When provided, also returns the resolved buffer for that passphrase.
 */
feesRouter.get("/buffer", (req, res) => {
  const { passphrase } = req.query as { passphrase?: string };

  const response: Record<string, unknown> = {
    networkBuffers: NETWORK_FEE_BUFFERS,
  };

  if (passphrase && typeof passphrase === "string") {
    response.resolvedBuffer = getNetworkFeeBuffer(passphrase);
  }

  res.json(response);
});

/**
 * POST /api/fees/buffer/apply
 * Apply the network fee buffer to a raw fee estimate (#1188).
 *
 * Body: { rawFee: number, passphrase: string }
 * Returns: { rawFee, bufferedFee, bufferPct, passphrase }
 */
feesRouter.post("/buffer/apply", (req, res) => {
  const { rawFee, passphrase } = req.body as { rawFee?: unknown; passphrase?: unknown };

  if (typeof rawFee !== "number" || !Number.isFinite(rawFee) || rawFee < 0) {
    sendError(res, 400, "INVALID_RAW_FEE", "rawFee must be a non-negative number (stroops).");
    return;
  }
  if (typeof passphrase !== "string" || passphrase.trim() === "") {
    sendError(res, 400, "INVALID_PASSPHRASE", "passphrase must be a non-empty string.");
    return;
  }

  const bufferConfig = getNetworkFeeBuffer(passphrase);
  const bufferedFee = applyFeeBuffer(rawFee, passphrase);

  res.json({
    rawFee,
    bufferedFee,
    bufferPct: bufferConfig.bufferPct,
    minFeeStroops: bufferConfig.minFeeStroops,
    passphrase,
  });
});

export default feesRouter;
