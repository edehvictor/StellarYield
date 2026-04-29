/**
 * APY Alert Routes
 *
 * POST   /api/alerts          — Create a new alert
 * GET    /api/alerts/:wallet  — List alerts for a wallet
 * DELETE /api/alerts/:id      — Delete (soft) an alert
 */

import { Router, Request, Response } from "express";
import {
  createAlert,
  listAlerts,
  deleteAlert,
  MAX_ALERTS_PER_USER,
  type AlertCondition,
} from "../services/alertsService";

const router = Router();

const VALID_CONDITIONS: AlertCondition[] = ["above", "below"];

/** POST /api/alerts */
router.post("/", async (req: Request, res: Response) => {
  const { walletAddress, vaultId, condition, thresholdValue, email } = req.body as {
    walletAddress?: string;
    vaultId?: string;
    condition?: string;
    thresholdValue?: unknown;
    email?: string;
  };

  if (!walletAddress || !vaultId || !condition || thresholdValue === undefined || !email) {
    res.status(400).json({ error: "walletAddress, vaultId, condition, thresholdValue, and email are required" });
    return;
  }

  if (!VALID_CONDITIONS.includes(condition as AlertCondition)) {
    res.status(400).json({ error: `condition must be one of: ${VALID_CONDITIONS.join(", ")}` });
    return;
  }

  const threshold = Number(thresholdValue);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1000) {
    res.status(400).json({ error: "thresholdValue must be a number between 0 and 1000" });
    return;
  }

  try {
    const alert = await createAlert({
      walletAddress,
      vaultId,
      condition: condition as AlertCondition,
      thresholdValue: threshold,
      email,
    });
    res.status(201).json(alert);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create alert";
    const status = message.includes("Maximum") ? 429 : 500;
    res.status(status).json({ error: message });
  }
});

/** GET /api/alerts/:wallet */
router.get("/:wallet", async (req: Request, res: Response) => {
  const { wallet } = req.params;
  try {
    const alerts = await listAlerts(wallet);
    res.json(alerts);
  } catch (err) {
    console.error("[alerts] listAlerts failed", err);
    res.status(500).json({ error: "Failed to fetch alerts" });
  }
});

/** DELETE /api/alerts/:id */
router.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { walletAddress } = req.body as { walletAddress?: string };

  if (!walletAddress) {
    res.status(400).json({ error: "walletAddress is required in request body" });
    return;
  }

  try {
    await deleteAlert(id, walletAddress);
    res.status(204).end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete alert";
    const status = message === "Alert not found" ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

export { MAX_ALERTS_PER_USER };
export default router;
