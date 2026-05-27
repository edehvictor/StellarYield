import { Router } from "express";
import { CorrelationService } from "../services/correlationService";

const correlationRouter = Router();

correlationRouter.get("/", async (req, res) => {
  try {
    const windowDays = req.query.window ? parseInt(req.query.window as string, 10) : 30;
    
    // Fail safely if validation fails for window input
    if (isNaN(windowDays) || windowDays <= 0 || windowDays > 365) {
      return res.status(400).json({ error: "Invalid window parameter. Must be between 1 and 365 days." });
    }

    const data = await CorrelationService.getCorrelationMatrix(windowDays);
    res.json(data);
  } catch (error) {
    console.error("Failed to calculate correlation matrix:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to fetch correlation data right now."
    });
  }
});

export default correlationRouter;
