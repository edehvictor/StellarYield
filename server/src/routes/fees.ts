import { Router } from "express";
import { getFeeOracleEstimate } from "../services/feeOracleService";
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

export default feesRouter;
