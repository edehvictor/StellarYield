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
  updateAlertPreferences,
  getAlertPreferences,
  revertAlertPreferences,
  MAX_ALERTS_PER_USER,
  type AlertCondition,
} from "../services/alertsService";
import {
  getPreferenceAuditHistory,
} from "../services/alertPreferenceAuditService";
import type { AlertPreferences } from "../services/alertsPreferenceRules";

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
    preferences?: {
      channel?: string;
      cooldownMinutes?: unknown;
      severityThreshold?: unknown;
      quietHoursStart?: unknown;
      quietHoursEnd?: unknown;
    };
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
    let preferences;
    if (req.body.preferences) {
      const channel = req.body.preferences.channel;
      const cooldownMinutes = Number(req.body.preferences.cooldownMinutes);
      const severityThreshold = Number(req.body.preferences.severityThreshold);
      const quietHoursStart = Number(req.body.preferences.quietHoursStart);
      const quietHoursEnd = Number(req.body.preferences.quietHoursEnd);

      if (!["email", "in_app"].includes(channel)) {
        res.status(400).json({ error: "preferences.channel must be email or in_app" });
        return;
      }
      if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 1440) {
        res.status(400).json({ error: "preferences.cooldownMinutes must be between 0 and 1440" });
        return;
      }
      if (!Number.isFinite(severityThreshold) || severityThreshold < 0 || severityThreshold > 1000) {
        res.status(400).json({ error: "preferences.severityThreshold must be between 0 and 1000" });
        return;
      }
      if (!Number.isInteger(quietHoursStart) || quietHoursStart < 0 || quietHoursStart > 23) {
        res.status(400).json({ error: "preferences.quietHoursStart must be an integer from 0 to 23" });
        return;
      }
      if (!Number.isInteger(quietHoursEnd) || quietHoursEnd < 0 || quietHoursEnd > 23) {
        res.status(400).json({ error: "preferences.quietHoursEnd must be an integer from 0 to 23" });
        return;
      }

      preferences = {
        channel: channel as "email" | "in_app",
        cooldownMinutes,
        severityThreshold,
        quietHoursStart,
        quietHoursEnd,
      };
    }

    const alert = await createAlert({
      walletAddress,
      vaultId,
      condition: condition as AlertCondition,
      thresholdValue: threshold,
      email,
      preferences,
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

/** GET /api/alerts/:wallet/preferences/history */
router.get("/:wallet/preferences/history", (req: Request, res: Response) => {
  const { wallet } = req.params;
  const { vaultId } = req.query as { vaultId?: string };

  if (!vaultId) {
    res.status(400).json({ error: "vaultId query parameter is required" });
    return;
  }

  const history = getPreferenceAuditHistory(wallet, vaultId);
  res.json({ walletAddress: wallet, vaultId, history });
});

/** GET /api/alerts/:wallet/preferences/:vaultId */
router.get("/:wallet/preferences/:vaultId", (req: Request, res: Response) => {
  const { wallet, vaultId } = req.params;
  const preferences = getAlertPreferences(wallet, vaultId);
  if (!preferences) {
    res.status(404).json({ error: "No preferences found for this wallet and vault" });
    return;
  }
  res.json({ walletAddress: wallet, vaultId, preferences });
});

/** PUT /api/alerts/:wallet/preferences/:vaultId */
router.put("/:wallet/preferences/:vaultId", (req: Request, res: Response) => {
  const { wallet, vaultId } = req.params;
  const { channel, cooldownMinutes, severityThreshold, quietHoursStart, quietHoursEnd } =
    req.body as Record<string, unknown>;

  if (!["email", "in_app"].includes(channel as string)) {
    res.status(400).json({ error: "channel must be email or in_app" });
    return;
  }
  if (!Number.isFinite(Number(cooldownMinutes)) || Number(cooldownMinutes) < 0 || Number(cooldownMinutes) > 1440) {
    res.status(400).json({ error: "cooldownMinutes must be between 0 and 1440" });
    return;
  }
  if (!Number.isFinite(Number(severityThreshold)) || Number(severityThreshold) < 0 || Number(severityThreshold) > 1000) {
    res.status(400).json({ error: "severityThreshold must be between 0 and 1000" });
    return;
  }
  if (!Number.isInteger(Number(quietHoursStart)) || Number(quietHoursStart) < 0 || Number(quietHoursStart) > 23) {
    res.status(400).json({ error: "quietHoursStart must be an integer from 0 to 23" });
    return;
  }
  if (!Number.isInteger(Number(quietHoursEnd)) || Number(quietHoursEnd) < 0 || Number(quietHoursEnd) > 23) {
    res.status(400).json({ error: "quietHoursEnd must be an integer from 0 to 23" });
    return;
  }

  const newPrefs: AlertPreferences = {
    channel: channel as "email" | "in_app",
    cooldownMinutes: Number(cooldownMinutes),
    severityThreshold: Number(severityThreshold),
    quietHoursStart: Number(quietHoursStart),
    quietHoursEnd: Number(quietHoursEnd),
  };

  const { preferences, auditEntry } = updateAlertPreferences(wallet, vaultId, newPrefs, {
    actor: wallet,
    source: "api",
    reason: req.body.reason as string | undefined,
  });

  res.json({ walletAddress: wallet, vaultId, preferences, auditEntry });
});

/** POST /api/alerts/:wallet/preferences/:vaultId/revert */
router.post("/:wallet/preferences/:vaultId/revert", (req: Request, res: Response) => {
  const { wallet, vaultId } = req.params;
  const { entryId } = req.body as { entryId?: string };

  try {
    const { preferences, auditEntry } = revertAlertPreferences(wallet, vaultId, entryId);
    res.json({ walletAddress: wallet, vaultId, preferences, auditEntry });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to revert preferences";
    const status = message.includes("not found") ? 404 : 500;
    res.status(status).json({ error: message });
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
