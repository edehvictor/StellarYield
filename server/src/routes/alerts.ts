/**
 * APY Alert Routes
 *
 * POST   /api/alerts          — Create a new alert
 * GET    /api/alerts/:wallet  — List alerts for a wallet
 * DELETE /api/alerts/:id      — Delete (soft) an alert
 *
 * Preference reads return the record's version in `ETag` and
 * `X-Preferences-Version`, plus its network/ledger binding in
 * `X-Alert-Network-Id` / `X-Alert-Schema-Version`. Writes accept that version
 * back as `If-Match` (or `expectedVersion` in the body) and answer 409
 * PREFERENCE_VERSION_CONFLICT when another write committed first (#1903).
 * Reads and writes also carry the explicit context (headers or `context` in
 * the body); a mismatch answers 409 PREFERENCE_CONTEXT_CONFLICT and changes
 * nothing (#1908).
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
  rebindAlertPreferenceContext,
  getAlertPreferencesVersion,
  type PreferenceVersionConflictError,
  MAX_ALERTS_PER_USER,
  type AlertCondition,
} from "../services/alertsService";
import {
  getPreferenceAuditHistory,
} from "../services/alertPreferenceAuditService";
import type { AlertPreferences } from "../services/alertsPreferenceRules";
import {
  type AlertPreferenceContext,
  AlertPreferenceContextConflictError,
  InvalidAlertContextError,
  getServerAlertContext,
  readAlertContext,
} from "../services/alertPreferenceContext";

const router = Router();

const VALID_CONDITIONS: AlertCondition[] = ["above", "below"];

class InvalidExpectedVersionError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAlertPreferences(
  value: unknown,
): { ok: true; preferences: AlertPreferences } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "preferences must be an object" };
  const { channel, cooldownMinutes, severityThreshold, quietHoursStart, quietHoursEnd } = value;
  if (channel !== "email" && channel !== "in_app") {
    return { ok: false, error: "preferences.channel must be email or in_app" };
  }
  if (
    typeof cooldownMinutes !== "number" ||
    !Number.isFinite(cooldownMinutes) ||
    cooldownMinutes < 0 ||
    cooldownMinutes > 1440
  ) {
    return { ok: false, error: "preferences.cooldownMinutes must be between 0 and 1440" };
  }
  if (
    typeof severityThreshold !== "number" ||
    !Number.isFinite(severityThreshold) ||
    severityThreshold < 0 ||
    severityThreshold > 1000
  ) {
    return { ok: false, error: "preferences.severityThreshold must be between 0 and 1000" };
  }
  if (
    typeof quietHoursStart !== "number" ||
    !Number.isInteger(quietHoursStart) ||
    quietHoursStart < 0 ||
    quietHoursStart > 23
  ) {
    return { ok: false, error: "preferences.quietHoursStart must be an integer from 0 to 23" };
  }
  if (
    typeof quietHoursEnd !== "number" ||
    !Number.isInteger(quietHoursEnd) ||
    quietHoursEnd < 0 ||
    quietHoursEnd > 23
  ) {
    return { ok: false, error: "preferences.quietHoursEnd must be an integer from 0 to 23" };
  }
  return {
    ok: true,
    preferences: {
      channel,
      cooldownMinutes,
      severityThreshold,
      quietHoursStart,
      quietHoursEnd,
    },
  };
}

function invalidAlertPreferences(res: Response, error: string): void {
  res.status(400).json({ error, code: "INVALID_ALERT_PREFERENCES" });
}

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

function setContextHeaders(res: Response, vaultId: string): void {
  const context = getServerAlertContext(vaultId);
  res.setHeader("X-Alert-Network-Id", context.networkId);
  res.setHeader("X-Alert-Schema-Version", String(context.schemaVersion));
  res.setHeader("X-Alert-Context-Vault", context.vaultId);
}

/** 409 with the stored binding so callers can rebind or retry, or false. */
function sendContextConflict(res: Response, err: unknown): boolean {
  if (!(err instanceof AlertPreferenceContextConflictError)) return false;
  setContextHeaders(res, err.currentContext.vaultId);
  res.status(409).json({
    error: err.message,
    code: err.code,
    reason: err.reason,
    expectedContext: err.expectedContext,
    currentContext: err.currentContext,
  });
  return true;
}

/** Parses the explicit context, answering 400 itself when it is malformed. */
function contextOr400(
  req: Request,
  res: Response,
  vaultId: string,
): { ok: true; value: AlertPreferenceContext | undefined } | { ok: false } {
  try {
    return { ok: true, value: readAlertContext(req, vaultId) };
  } catch (err) {
    if (err instanceof InvalidAlertContextError) {
      res.status(400).json({ error: err.message, code: err.code });
      return { ok: false };
    }
    throw err;
  }
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
  if (!isRecord(req.body)) {
    res.status(400).json({ error: "Request body must be an object", code: "INVALID_ALERT_REQUEST" });
    return;
  }
  const body = req.body;
  const operationIdentity =
    (req.headers["x-operation-identity"] as string | undefined) ??
    (req.headers["idempotency-key"] as string | undefined) ??
    (typeof body.operationIdentity === "string" ? body.operationIdentity : undefined);

  const { walletAddress, vaultId, condition, thresholdValue, email } = body as {
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

  const contextInput = contextOr400(req, res, vaultId);
  if (!contextInput.ok) return;

  try {
    let preferences: AlertPreferences | undefined;
    if (body.preferences !== undefined) {
      const parsedPreferences = parseAlertPreferences(body.preferences);
      if (!parsedPreferences.ok) {
        invalidAlertPreferences(res, parsedPreferences.error);
        return;
      }
      preferences = parsedPreferences.preferences;
    }

    const alert = await createAlert({
      walletAddress,
      vaultId,
      condition: condition as AlertCondition,
      thresholdValue: threshold,
      email,
      preferences,
      operationIdentity,
      context: contextInput.value,
    });

    if (preferences) setContextHeaders(res, vaultId);
    if ((alert as any).__replayed) {
      res.setHeader("X-Idempotent-Replayed", "true");
      const { __replayed, ...cleanAlert } = alert as any;
      res.status(200).json(cleanAlert);
      return;
    }

    res.status(201).json(alert);
  } catch (err: any) {
    if (sendContextConflict(res, err)) return;
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
  const contextInput = contextOr400(req, res, vaultId);
  if (!contextInput.ok) return;

  try {
    const preferences = getAlertPreferences(wallet, vaultId, contextInput.value);
    if (!preferences) {
      res.status(404).json({ error: "Alert preferences not found" });
      return;
    }
    setVersionHeaders(res, getAlertPreferencesVersion(wallet, vaultId));
    setContextHeaders(res, vaultId);
    res.json(preferences);
  } catch (err) {
    if (sendContextConflict(res, err)) return;
    const message = err instanceof Error ? err.message : "Failed to read alert preferences";
    res.status(500).json({ error: message });
  }
});

/** PUT /api/alerts/preferences */
router.put("/preferences", (req: Request, res: Response) => {
  if (!isRecord(req.body)) {
    invalidAlertPreferences(res, "Request body must be an object");
    return;
  }
  const body = req.body;
  const identityHeader = req.headers["x-operation-identity"] ?? req.headers["idempotency-key"];
  if (identityHeader !== undefined && typeof identityHeader !== "string") {
    invalidAlertPreferences(res, "operation identity header must be a string");
    return;
  }
  if (body.operationIdentity !== undefined && typeof body.operationIdentity !== "string") {
    invalidAlertPreferences(res, "operationIdentity must be a string");
    return;
  }
  const operationIdentity = identityHeader ?? body.operationIdentity;

  const { walletAddress, vaultId } = body;
  if (
    typeof walletAddress !== "string" ||
    !walletAddress ||
    typeof vaultId !== "string" ||
    !vaultId
  ) {
    invalidAlertPreferences(res, "walletAddress and vaultId are required");
    return;
  }

  const parsedPreferences = parseAlertPreferences(body.preferences);
  if (!parsedPreferences.ok) {
    invalidAlertPreferences(res, parsedPreferences.error);
    return;
  }
  const expected = expectedVersionOr400(req, res);
  if (!expected.ok) return;
  const contextInput = contextOr400(req, res, vaultId);
  if (!contextInput.ok) return;

  try {
    const result = setAlertPreferences(
      walletAddress,
      vaultId,
      parsedPreferences.preferences,
      operationIdentity,
      // Only passed when sent, so unconditional writes keep their old call shape.
      ...(expected.value === undefined ? [] : [expected.value]),
      contextInput.value,
    );

    if (result.replayed) {
      res.setHeader("X-Idempotent-Replayed", "true");
    }
    setVersionHeaders(res, result.version);
    setContextHeaders(res, vaultId);
    res.json(result.preferences);
  } catch (err: any) {
    if (sendVersionConflict(res, err)) return;
    if (sendContextConflict(res, err)) return;
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
  const contextInput = contextOr400(req, res, vaultId);
  if (!contextInput.ok) return;

  try {
    const preferences = getAlertPreferences(wallet, vaultId, contextInput.value);
    if (!preferences) {
      res.status(404).json({ error: "No preferences found for this wallet and vault" });
      return;
    }
    const version = getAlertPreferencesVersion(wallet, vaultId);
    setVersionHeaders(res, version);
    setContextHeaders(res, vaultId);
    res.json({
      walletAddress: wallet,
      vaultId,
      preferences,
      version,
      context: getServerAlertContext(vaultId),
    });
  } catch (err) {
    if (sendContextConflict(res, err)) return;
    const message = err instanceof Error ? err.message : "Failed to read alert preferences";
    res.status(500).json({ error: message });
  }
});

/** PUT /api/alerts/:wallet/preferences/:vaultId */
router.put("/:wallet/preferences/:vaultId", (req: Request, res: Response) => {
  const { wallet, vaultId } = req.params;
  if (!isRecord(req.body)) {
    invalidAlertPreferences(res, "Request body must be an object");
    return;
  }
  const parsedPreferences = parseAlertPreferences(req.body);
  if (!parsedPreferences.ok) {
    invalidAlertPreferences(res, parsedPreferences.error);
    return;
  }
  if (req.body.reason !== undefined && typeof req.body.reason !== "string") {
    invalidAlertPreferences(res, "reason must be a string");
    return;
  }

  const newPrefs = parsedPreferences.preferences;

  const expected = expectedVersionOr400(req, res);
  if (!expected.ok) return;
  const contextInput = contextOr400(req, res, vaultId);
  if (!contextInput.ok) return;

  try {
    const { preferences, auditEntry, version } = updateAlertPreferences(wallet, vaultId, newPrefs, {
      actor: wallet,
      source: "api",
      reason: req.body.reason,
      expectedVersion: expected.value,
      context: contextInput.value,
    });
    setVersionHeaders(res, version);
    setContextHeaders(res, vaultId);
    res.json({ walletAddress: wallet, vaultId, preferences, auditEntry, version });
  } catch (err) {
    if (sendVersionConflict(res, err)) return;
    if (sendContextConflict(res, err)) return;
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
  const contextInput = contextOr400(req, res, vaultId);
  if (!contextInput.ok) return;

  try {
    const { preferences, auditEntry, version } = revertAlertPreferences(
      wallet,
      vaultId,
      entryId,
      expected.value,
      contextInput.value,
    );
    setVersionHeaders(res, version);
    setContextHeaders(res, vaultId);
    res.json({ walletAddress: wallet, vaultId, preferences, auditEntry, version });
  } catch (err) {
    if (sendVersionConflict(res, err)) return;
    if (sendContextConflict(res, err)) return;
    const message = err instanceof Error ? err.message : "Failed to revert preferences";
    const status = message.includes("not found") ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

/**
 * POST /api/alerts/:wallet/preferences/:vaultId/rebind
 *
 * Explicitly migrate a preference binding after a network/schema transition.
 * The old context must be named (body `context` or headers) so a stale client
 * cannot silently adopt another ledger's preferences.
 */
router.post("/:wallet/preferences/:vaultId/rebind", (req: Request, res: Response) => {
  const { wallet, vaultId } = req.params;
  const contextInput = contextOr400(req, res, vaultId);
  if (!contextInput.ok) return;
  const expected = expectedVersionOr400(req, res);
  if (!expected.ok) return;

  try {
    const result = rebindAlertPreferenceContext(wallet, vaultId, {
      expectedContext: contextInput.value,
      expectedVersion: expected.value,
      actor: wallet,
      reason: req.body.reason as string | undefined,
    });
    setVersionHeaders(res, result.version);
    setContextHeaders(res, vaultId);
    if (result.replayed) res.setHeader("X-Idempotent-Replayed", "true");
    res.json(result);
  } catch (err) {
    if (sendVersionConflict(res, err)) return;
    if (sendContextConflict(res, err)) return;
    const message = err instanceof Error ? err.message : "Failed to rebind alert preferences";
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
