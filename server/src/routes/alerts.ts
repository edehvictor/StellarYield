/**
 * APY Alert Routes
 *
 * POST   /api/alerts          — Create a new alert
 * GET    /api/alerts/:wallet  — List alerts for a wallet
 * DELETE /api/alerts/:id      — Delete (soft) an alert
 *
 * Preference reads return the record's version in `ETag` and
 * `X-Preferences-Version`. Preference writes accept that version back as
 * `If-Match` (or `expectedVersion` in the body) and answer 409
 * PREFERENCE_VERSION_CONFLICT when another write committed first (#1903).
 */

import { Router, Request, Response } from "express";
import {
  createAlert,
  listAlerts,
  deleteAlert,
  getAlertPreferences,
  setAlertPreferences,
  updateAlertPreferences,
  revertAlertPreferences,
  getAlertPreferencesVersion,
  type PreferenceVersionConflictError,
  MAX_ALERTS_PER_USER,
  type AlertCondition,
} from "../services/alertsService";
import {
  getPreferenceAuditHistory,
} from "../services/alertPreferenceAuditService";
import type { AlertPreferences } from "../services/alertsPreferenceRules";

const router = Router();

const VALID_CONDITIONS: AlertCondition[] = ["above", "below"];

class InvalidExpectedVersionError extends Error {}

/**
 * The version a preference write expects (#1903), from `If-Match` (`"3"`,
 * `W/"3"` or `3`) or else `expectedVersion` in the body. `undefined` when
 * neither is sent, which keeps the old unconditional write.
 */
export function readExpectedVersion(req: Request): number | undefined {
  const header = req.headers["if-match"];
  const raw =
    typeof header === "string" && header.trim() !== ""
      ? header.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1")
      : (req.body as { expectedVersion?: unknown } | undefined)?.expectedVersion;
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value < 0 || String(raw).trim() === "") {
    throw new InvalidExpectedVersionError(
      "If-Match / expectedVersion must be a non-negative integer version",
    );
  }
  return value;
}

function setVersionHeaders(res: Response, version: number): void {
  res.setHeader("ETag", `"${version}"`);
  res.setHeader("X-Preferences-Version", String(version));
}

/** 409 with what the client needs to reload and retry, or false. */
function sendVersionConflict(res: Response, err: unknown): boolean {
  // Matched by code so the check also holds across module mocks.
  if ((err as { code?: unknown } | null)?.code !== "PREFERENCE_VERSION_CONFLICT") return false;
  const conflict = err as PreferenceVersionConflictError;
  setVersionHeaders(res, conflict.currentVersion);
  res.status(409).json({
    error: conflict.message,
    code: conflict.code,
    expectedVersion: conflict.expectedVersion,
    currentVersion: conflict.currentVersion,
    preferences: conflict.currentPreferences,
  });
  return true;
}

/** Parses the expected version, answering 400 itself when it is malformed. */
function expectedVersionOr400(req: Request, res: Response): { ok: true; value: number | undefined } | { ok: false } {
  try {
    return { ok: true, value: readExpectedVersion(req) };
  } catch (err) {
    if (err instanceof InvalidExpectedVersionError) {
      res.status(400).json({ error: err.message, code: "INVALID_EXPECTED_VERSION" });
      return { ok: false };
    }
    throw err;
  }
}

/** POST /api/alerts */
router.post("/", async (req: Request, res: Response) => {
  const operationIdentity =
    (req.headers["x-operation-identity"] as string | undefined) ??
    (req.headers["idempotency-key"] as string | undefined) ??
    (req.body?.operationIdentity as string | undefined);

  const { walletAddress, vaultId, condition, thresholdValue, email } = req.body as {
    walletAddress?: string;
    vaultId?: string;
    condition?: string;
    thresholdValue?: unknown;
    email?: string;
    operationIdentity?: string;
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
      operationIdentity,
    });

    if ((alert as any).__replayed) {
      res.setHeader("X-Idempotent-Replayed", "true");
      const { __replayed, ...cleanAlert } = alert as any;
      res.status(200).json(cleanAlert);
      return;
    }

    res.status(201).json(alert);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : "Failed to create alert";
    if (err.code === "OPERATION_IDENTITY_CONFLICT" || message.includes("Operation identity has already been used")) {
      res.status(409).json({ error: message, code: "OPERATION_IDENTITY_CONFLICT" });
      return;
    }
    const status = message.includes("Maximum") ? 429 : 500;
    res.status(status).json({ error: message });
  }
});

/** GET /api/alerts/preferences/:wallet/:vaultId */
router.get("/preferences/:wallet/:vaultId", (req: Request, res: Response) => {
  const { wallet, vaultId } = req.params;
  const preferences = getAlertPreferences(wallet, vaultId);
  if (!preferences) {
    res.status(404).json({ error: "Alert preferences not found" });
    return;
  }
  setVersionHeaders(res, getAlertPreferencesVersion(wallet, vaultId));
  res.json(preferences);
});

/** PUT /api/alerts/preferences */
router.put("/preferences", (req: Request, res: Response) => {
  const operationIdentity =
    (req.headers["x-operation-identity"] as string | undefined) ??
    (req.headers["idempotency-key"] as string | undefined) ??
    (req.body?.operationIdentity as string | undefined);

  const { walletAddress, vaultId, preferences } = req.body as {
    walletAddress?: string;
    vaultId?: string;
    preferences?: {
      channel?: string;
      cooldownMinutes?: unknown;
      severityThreshold?: unknown;
      quietHoursStart?: unknown;
      quietHoursEnd?: unknown;
    };
    operationIdentity?: string;
  };

  if (!walletAddress || !vaultId || !preferences) {
    res.status(400).json({ error: "walletAddress, vaultId, and preferences are required" });
    return;
  }

  const channel = preferences.channel;
  const cooldownMinutes = Number(preferences.cooldownMinutes);
  const severityThreshold = Number(preferences.severityThreshold);
  const quietHoursStart = Number(preferences.quietHoursStart);
  const quietHoursEnd = Number(preferences.quietHoursEnd);

  if (!["email", "in_app"].includes(String(channel))) {
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

  const expected = expectedVersionOr400(req, res);
  if (!expected.ok) return;

  try {
    const result = setAlertPreferences(
      walletAddress,
      vaultId,
      {
        channel: channel as "email" | "in_app",
        cooldownMinutes,
        severityThreshold,
        quietHoursStart,
        quietHoursEnd,
      },
      operationIdentity,
      // Only passed when sent, so unconditional writes keep their old call shape.
      ...(expected.value === undefined ? [] : [expected.value]),
    );

    if (result.replayed) {
      res.setHeader("X-Idempotent-Replayed", "true");
    }
    setVersionHeaders(res, result.version);
    res.json(result.preferences);
  } catch (err: any) {
    if (sendVersionConflict(res, err)) return;
    const message = err instanceof Error ? err.message : "Failed to update alert preferences";
    if (err.code === "OPERATION_IDENTITY_CONFLICT" || message.includes("Operation identity has already been used")) {
      res.status(409).json({ error: message, code: "OPERATION_IDENTITY_CONFLICT" });
      return;
    }
    res.status(500).json({ error: message });
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
  const version = getAlertPreferencesVersion(wallet, vaultId);
  setVersionHeaders(res, version);
  res.json({ walletAddress: wallet, vaultId, preferences, version });
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

  const expected = expectedVersionOr400(req, res);
  if (!expected.ok) return;

  try {
    const { preferences, auditEntry, version } = updateAlertPreferences(wallet, vaultId, newPrefs, {
      actor: wallet,
      source: "api",
      reason: req.body.reason as string | undefined,
      expectedVersion: expected.value,
    });
    setVersionHeaders(res, version);
    res.json({ walletAddress: wallet, vaultId, preferences, auditEntry, version });
  } catch (err) {
    if (sendVersionConflict(res, err)) return;
    const message = err instanceof Error ? err.message : "Failed to update alert preferences";
    res.status(500).json({ error: message });
  }
});

/** POST /api/alerts/:wallet/preferences/:vaultId/revert */
router.post("/:wallet/preferences/:vaultId/revert", (req: Request, res: Response) => {
  const { wallet, vaultId } = req.params;
  const { entryId } = req.body as { entryId?: string };
  const expected = expectedVersionOr400(req, res);
  if (!expected.ok) return;

  try {
    const { preferences, auditEntry, version } = revertAlertPreferences(
      wallet,
      vaultId,
      entryId,
      expected.value,
    );
    setVersionHeaders(res, version);
    res.json({ walletAddress: wallet, vaultId, preferences, auditEntry, version });
  } catch (err) {
    if (sendVersionConflict(res, err)) return;
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
