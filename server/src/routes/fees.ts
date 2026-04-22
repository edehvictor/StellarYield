import { Router } from "express";
import { getFeeOracleEstimate } from "../services/feeOracleService";

const feesRouter = Router();

feesRouter.get("/", async (_req, res) => {
  try {
    const feeData = await getFeeOracleEstimate();
    res.json(feeData);
  } catch (error) {
    console.error("Failed to serve /api/fees", error);
    res.status(500).json({
      error: "Unable to estimate fees right now.",
    });
  }
});

export default feesRouter;
