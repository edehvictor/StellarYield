import { Router } from "express";
import { getYieldData } from "../services/yieldService";

const yieldsRouter = Router();

yieldsRouter.get("/", async (_req, res) => {
  try {
    const yields = await getYieldData();
    res.json(yields);
  } catch (error) {
    console.error("Failed to serve /api/yields.", error);
    res.status(500).json({
      error: "Unable to fetch yield data right now.",
    });
  }
});

export default yieldsRouter;
