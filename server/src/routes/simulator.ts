import { Router, Request, Response } from "express";
import { simulateDeposit, SimulationParams } from "../services/simulationService";

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

export default router;
