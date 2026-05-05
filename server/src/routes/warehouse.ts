import { Router } from "express";
import {
  getHistoricalRange,
  getProtocolStats,
  startYieldWarehouseJobs,
} from "../services/yieldWarehouseService";

const warehouseRouter = Router();

warehouseRouter.get("/history", async (req, res) => {
  try {
    const protocol = req.query.protocol as string | undefined;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const granularity = (req.query.granularity as "hourly" | "daily") || "daily";
    const limit = Math.min(Number.parseInt(req.query.limit as string, 10) || 100, 1000);

    if (!startDate || !endDate) {
      res.status(400).json({
        error: "startDate and endDate are required (ISO 8601 format)",
      });
      return;
    }

    const history = await getHistoricalRange({
      protocol,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      granularity,
      limit,
    });

    res.json(history);
  } catch (error) {
    console.error("Failed to fetch historical data.", error);
    res.status(500).json({
      error: "Unable to fetch historical data",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

warehouseRouter.get("/stats/:protocol", async (req, res) => {
  try {
    const stats = await getProtocolStats(req.params.protocol);

    if (!stats) {
      res.status(404).json({
        error: "Protocol not found or database unavailable",
      });
      return;
    }

    res.json(stats);
  } catch (error) {
    console.error("Failed to fetch protocol stats.", error);
    res.status(500).json({
      error: "Unable to fetch protocol stats",
      requestId: (req as unknown as { requestId?: string }).requestId,
    });
  }
});

warehouseRouter.post("/jobs/start", (_req, res) => {
  startYieldWarehouseJobs();
  res.json({ message: "Warehouse jobs started" });
});

export default warehouseRouter;