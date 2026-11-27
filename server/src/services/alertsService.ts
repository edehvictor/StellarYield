/**
 * APY Alert Service
 *
 * Manages user-defined APY threshold alerts. When the indexer calculates a
 * new APY for a vault, `evaluateAlerts` is called to check all active alerts
 * for that vault and dispatch emails for any that are triggered.
 *
 * Security:
 *  - MAX_ALERTS_PER_USER caps active alerts to prevent DB bloat.
 *  - Triggered alerts are marked "triggered" and not re-evaluated (no spam).
 *  - No wallet addresses are included in outbound emails.
 *  - Preference records are bound to a network/ledger context (#1908); reads
 *    and writes naming another context are rejected without changing state.
 *
 * Resilience:
 *  - Email dispatch retries up to MAX_DELIVERY_ATTEMPTS times with exponential backoff.
 *  - Permanently failed deliveries land in the dead-letter queue (deadLetterQueue).
 *  - deliveryMetrics tracks sent/failed/retried/dead-lettered counts for operators.
 */

import { PrismaClient } from "@prisma/client";
import { sendEmail } from "./emailService";
import {
  shouldSuppressAlert,
  roundToDecimals,
  type AlertPreferences,
} from "./alertsPreferenceRules";
import {
  recordPreferenceChange,
  getPreferenceAuditHistory,
  getAuditEntryById,
  findRevertTarget,
  type AlertPreferenceAuditEntry,
  type AuditSource,
} from "./alertPreferenceAuditService";
import {
  type AlertContextInput,
  type AlertPreferenceContext,
  AlertPreferenceContextConflictError,
  contextEquals,
  getServerAlertContext,
  parseAlertContext,
  resolveContextForRead,
  resolveContextForWrite,
} from "./alertPreferenceContext";
import { sortNotificationsDeterministically } from "../utils/deterministicSort";

const prisma = new PrismaClient();

/** Hard cap on active alerts per wallet address. */
export const MAX_ALERTS_PER_USER = 20;

/** Maximum delivery attempts before an alert is dead-lettered. */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** Base delay (ms) for exponential backoff between retries. */
export const RETRY_BASE_DELAY_MS = 200;

export type AlertCondition = "above" | "below";

// ── Delivery observability ──────────────────────────────────────────────

export interface DeliveryMetrics {
  sent: number;
  failed: number;
  retried: number;
  deadLettered: number;
}

export interface DeadLetterEntry {
  to: string;
  subject: string;
  attempts: number;
  lastError: string;
  failedAt: string;
}

export const deliveryMetrics: DeliveryMetrics = {
  sent: 0,
  failed: 0,
  retried: 0,
  deadLettered: 0,
};

export const deadLetterQueue: DeadLetterEntry[] = [];

export function resetDeliveryMetrics(): void {
  deliveryMetrics.sent = 0;
  deliveryMetrics.failed = 0;
  deliveryMetrics.retried = 0;
  deliveryMetrics.deadLettered = 0;
  deadLetterQueue.length = 0;
}

export interface CreateAlertInput {
  walletAddress: string;
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: number;
  email: string;
  preferences?: AlertPreferences;
  operationIdentity?: string;
  /** Ledger context bound to the initial preferences (#1908). */
  context?: AlertContextInput;
}

export const ALERT_OPERATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface AlertOperationRecord {
  operationIdentity: string;
  fingerprint: string;
  result: any;
  createdAt: number;
}

const alertPreferencesStore = new Map<string, AlertPreferences>();
const alertLastTriggeredStore = new Map<string, number>();
const alertOperationStore = new Map<string, AlertOperationRecord>();
/**
 * Optimistic-concurrency version per wallet+vault preference record (#1903).
 * 0 means "no preferences yet"; every committed write increments it by one.
 */
const alertPreferencesVersionStore = new Map<string, number>();
/**
 * Network/ledger binding per wallet+vault preference record (#1908). Bound on
 * the first write and preserved by later writes and reverts.
 */
const alertPreferenceContextStore = new Map<string, AlertPreferenceContext>();

export const PREFERENCE_VERSION_CONFLICT = "PREFERENCE_VERSION_CONFLICT";

/**
 * Thrown when a write names an `expectedVersion` that no longer matches the
 * stored record: another writer committed first. Nothing is changed.
 */
export class PreferenceVersionConflictError extends Error {
  readonly code = PREFERENCE_VERSION_CONFLICT;
  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
    readonly currentPreferences: AlertPreferences | null,
  ) {
    super(
      `Alert preferences changed since version ${expectedVersion}; current version is ${currentVersion}. Reload and retry.`,
    );
    this.name = "PreferenceVersionConflictError";
  }
}

/** The current version of a wallet+vault preference record (0 when none). */
export function getAlertPreferencesVersion(walletAddress: string, vaultId: string): number {
  return alertPreferencesVersionStore.get(toAlertKey(walletAddress, vaultId)) ?? 0;
}

/**
 * Checks `expectedVersion` against the stored version before anything is read
 * for the update. `undefined` skips the check (unconditional write, as before).
 */
function assertExpectedVersion(key: string, expectedVersion: number | undefined): void {
  if (expectedVersion === undefined) return;
  const current = alertPreferencesVersionStore.get(key) ?? 0;
  if (current !== expectedVersion) {
    throw new PreferenceVersionConflictError(
      expectedVersion,
      current,
      alertPreferencesStore.get(key) ?? null,
    );
  }
}

/**
 * Serialized commit: check the version, write the preferences, bump the
 * version and run `sideEffect` (the audit record) as one synchronous step, so
 * no other request can interleave. If `sideEffect` throws, the previous
 * preferences and version are restored and the error is rethrown.
 */
function commitPreferences(
  key: string,
  next: AlertPreferences,
  expectedVersion: number | undefined,
  sideEffect?: (before: AlertPreferences | null) => void,
  context?: AlertPreferenceContext,
): number {
  assertExpectedVersion(key, expectedVersion);
  const hadBefore = alertPreferencesStore.has(key);
  const before = alertPreferencesStore.get(key) ?? null;
  const previousVersion = alertPreferencesVersionStore.get(key) ?? 0;
  const hadContext = alertPreferenceContextStore.has(key);
  const previousContext = alertPreferenceContextStore.get(key);
  const nextVersion = previousVersion + 1;
  alertPreferencesStore.set(key, next);
  alertPreferencesVersionStore.set(key, nextVersion);
  if (context) alertPreferenceContextStore.set(key, context);
  try {
    sideEffect?.(before);
  } catch (error) {
    if (hadBefore && before) alertPreferencesStore.set(key, before);
    else alertPreferencesStore.delete(key);
    if (previousVersion === 0) alertPreferencesVersionStore.delete(key);
    else alertPreferencesVersionStore.set(key, previousVersion);
    if (hadContext && previousContext) alertPreferenceContextStore.set(key, previousContext);
    else alertPreferenceContextStore.delete(key);
    throw error;
  }
  return nextVersion;
}

function toAlertKey(walletAddress: string, vaultId: string) {
  return `${walletAddress.toLowerCase()}::${vaultId.toLowerCase()}`;
}

export interface AlertPreferencesValidationResult {
  valid: boolean;
  errors: string[];
  sanitized?: AlertPreferences;
}

/**
 * Validates and sanitizes alert preferences against strict numeric boundaries
 * and integer constraints. Preserves existing state on failure.
 */
export function validateAlertPreferences(raw: unknown): AlertPreferencesValidationResult {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: ["preferences must be an object"] };
  }

  const p = raw as Record<string, unknown>;

  if (p.channel !== "email" && p.channel !== "in_app") {
    errors.push("channel must be email or in_app");
  }

  const cooldown = Number(p.cooldownMinutes);
  if (!Number.isFinite(cooldown) || !Number.isInteger(cooldown) || cooldown < 0 || cooldown > 1440) {
    errors.push("cooldownMinutes must be an integer between 0 and 1440");
  }

  const severity = Number(p.severityThreshold);
  if (!Number.isFinite(severity) || severity < 0 || severity > 1000) {
    errors.push("severityThreshold must be a number between 0 and 1000");
  }

  const quietStart = Number(p.quietHoursStart);
  if (!Number.isFinite(quietStart) || !Number.isInteger(quietStart) || quietStart < 0 || quietStart > 23) {
    errors.push("quietHoursStart must be an integer from 0 to 23");
  }

  const quietEnd = Number(p.quietHoursEnd);
  if (!Number.isFinite(quietEnd) || !Number.isInteger(quietEnd) || quietEnd < 0 || quietEnd > 23) {
    errors.push("quietHoursEnd must be an integer from 0 to 23");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const sanitized: AlertPreferences = {
    channel: p.channel as "email" | "in_app",
    cooldownMinutes: cooldown,
    severityThreshold: roundToDecimals(severity, 2),
    quietHoursStart: quietStart,
    quietHoursEnd: quietEnd,
  };

  return { valid: true, errors: [], sanitized };
}

export function computeAlertFingerprint(input: {
  walletAddress: string;
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: number;
  email: string;
  preferences?: AlertPreferences;
  context?: AlertContextInput;
}): string {
  return JSON.stringify({
    walletAddress: input.walletAddress.trim().toLowerCase(),
    vaultId: input.vaultId.trim().toLowerCase(),
    condition: input.condition,
    thresholdValue: Number(input.thresholdValue),
    email: input.email.trim().toLowerCase(),
    context: input.context ? parseAlertContext(input.context, input.vaultId) ?? null : null,
    preferences: input.preferences
      ? {
          channel: input.preferences.channel,
          cooldownMinutes: Number(input.preferences.cooldownMinutes),
          severityThreshold: Number(input.preferences.severityThreshold),
          quietHoursStart: Number(input.preferences.quietHoursStart),
          quietHoursEnd: Number(input.preferences.quietHoursEnd),
        }
      : null,
  });
}

// ── Alert Preferences & Operation Identity ──────────────────────────────

export function getAlertPreferences(
  walletAddress: string,
  vaultId: string,
  context?: AlertContextInput,
): AlertPreferences | undefined {
  const key = toAlertKey(walletAddress, vaultId);
  if (context !== undefined) {
    resolveContextForRead(
      alertPreferenceContextStore.get(key),
      parseAlertContext(context, vaultId),
      vaultId,
    );
  }
  return alertPreferencesStore.get(key);
}

/** Context describing the stored record, or the one a first write would bind. */
export function getAlertPreferencesContext(
  walletAddress: string,
  vaultId: string,
): AlertPreferenceContext {
  const key = toAlertKey(walletAddress, vaultId);
  return alertPreferenceContextStore.get(key) ?? getServerAlertContext(vaultId);
}

/** Validates a read against the caller's context; throws on a mismatch. */
export function assertAlertPreferencesContext(
  walletAddress: string,
  vaultId: string,
  context?: AlertContextInput,
): AlertPreferenceContext {
  const key = toAlertKey(walletAddress, vaultId);
  return resolveContextForRead(
    alertPreferenceContextStore.get(key),
    parseAlertContext(context, vaultId),
    vaultId,
  );
}

export function setAlertPreferences(
  walletAddress: string,
  vaultId: string,
  preferences: AlertPreferences,
  operationIdentity?: string,
  expectedVersion?: number,
  context?: AlertContextInput,
): { preferences: AlertPreferences; replayed: boolean; version: number } {
  const key = toAlertKey(walletAddress, vaultId);
  const requestedContext = parseAlertContext(context, vaultId);
  const effectiveContext = resolveContextForWrite(
    alertPreferenceContextStore.get(key),
    requestedContext,
    vaultId,
  );
  const currentFingerprint = JSON.stringify({
    walletAddress: walletAddress.trim().toLowerCase(),
    vaultId: vaultId.trim().toLowerCase(),
    preferences: {
      channel: preferences.channel,
      cooldownMinutes: Number(preferences.cooldownMinutes),
      severityThreshold: Number(preferences.severityThreshold),
      quietHoursStart: Number(preferences.quietHoursStart),
      quietHoursEnd: Number(preferences.quietHoursEnd),
    },
    context: effectiveContext,
  });

  if (operationIdentity) {
    const existing = alertOperationStore.get(operationIdentity);
    if (existing) {
      if (Date.now() - existing.createdAt > ALERT_OPERATION_TTL_MS) {
        alertOperationStore.delete(operationIdentity);
      } else if (existing.fingerprint === currentFingerprint) {
        // A safe retry of a write that already committed: same answer, no
        // second write, regardless of the version it was sent with.
        const replay = existing.result as { preferences: AlertPreferences; version: number };
        return { preferences: replay.preferences, replayed: true, version: replay.version };
      } else {
        const error = new Error(
          "Operation identity has already been used with different parameters.",
        );
        (error as any).code = "OPERATION_IDENTITY_CONFLICT";
        throw error;
      }
    }
  }

  // A context or version conflict throws before anything is written or
  // recorded, so the same operation identity can be retried after reload.
  const version = commitPreferences(key, preferences, expectedVersion, undefined, effectiveContext);

  if (operationIdentity) {
    alertOperationStore.set(operationIdentity, {
      operationIdentity,
      fingerprint: currentFingerprint,
      result: { preferences, version },
      createdAt: Date.now(),
    });
  }

  return { preferences, replayed: false, version };
}

export function clearAlertOperationStore(): void {
  alertOperationStore.clear();
}

export function deleteAlertPreferences(walletAddress: string, vaultId: string): boolean {
  const key = toAlertKey(walletAddress, vaultId);
  return alertPreferencesStore.delete(key);
}

export function clearAlertPreferencesStore(): void {
  alertPreferencesStore.clear();
  alertPreferencesVersionStore.clear();
  alertPreferenceContextStore.clear();
  alertLastTriggeredStore.clear();
}

// ── CRUD ────────────────────────────────────────────────────────────────

/**
 * Create a new APY alert for a user.
 * Throws if the user already has MAX_ALERTS_PER_USER active alerts.
 */
export async function createAlert(input: CreateAlertInput) {
  if (!Number.isFinite(input.thresholdValue) || input.thresholdValue < 0 || input.thresholdValue > 1000) {
    throw new Error("thresholdValue must be a number between 0 and 1000");
  }
  const roundedThreshold = roundToDecimals(input.thresholdValue, 4);
  let sanitizedPrefs: AlertPreferences | undefined;
  if (input.preferences) {
    const validation = validateAlertPreferences(input.preferences);
    if (!validation.valid || !validation.sanitized) {
      throw new Error(`Invalid alert preferences: ${validation.errors.join("; ")}`);
    }
    sanitizedPrefs = validation.sanitized;
  }
  const preferenceKey = toAlertKey(input.walletAddress, input.vaultId);
  const bindingContext = input.preferences
    ? resolveContextForWrite(
        alertPreferenceContextStore.get(preferenceKey),
        parseAlertContext(input.context, input.vaultId),
        input.vaultId,
      )
    : undefined;
  const currentFingerprint = computeAlertFingerprint({
    ...input,
    preferences: sanitizedPrefs ?? input.preferences,
    context: bindingContext,
  });

  if (input.operationIdentity) {
    const existing = alertOperationStore.get(input.operationIdentity);
    if (existing) {
      if (Date.now() - existing.createdAt > ALERT_OPERATION_TTL_MS) {
        alertOperationStore.delete(input.operationIdentity);
      } else if (existing.fingerprint === currentFingerprint) {
        return { ...existing.result, __replayed: true };
      } else {
        const error = new Error(
          "Operation identity has already been used with different parameters.",
        );
        (error as any).code = "OPERATION_IDENTITY_CONFLICT";
        throw error;
      }
    }
  }

  const activeCount = await prisma.userAlert.count({
    where: { walletAddress: input.walletAddress, status: "active" },
  });

  if (activeCount >= MAX_ALERTS_PER_USER) {
    throw new Error(
      `Maximum of ${MAX_ALERTS_PER_USER} active alerts per user reached.`,
    );
  }

  const created = await prisma.userAlert.create({
    data: {
      walletAddress: input.walletAddress,
      vaultId: input.vaultId,
      condition: input.condition,
      thresholdValue: roundedThreshold,
      email: input.email,
      status: "active",
    },
  });
  if (sanitizedPrefs) {
    const initial = sanitizedPrefs;
    commitPreferences(
      preferenceKey,
      initial,
      undefined,
      (before) => {
        recordPreferenceChange({
          walletAddress: input.walletAddress,
          vaultId: input.vaultId,
          actor: input.walletAddress,
          source: "api",
          before,
          after: initial,
          reason: "Initial preference set on alert creation",
        });
      },
      bindingContext,
    );
  }

  if (input.operationIdentity) {
    alertOperationStore.set(input.operationIdentity, {
      operationIdentity: input.operationIdentity,
      fingerprint: currentFingerprint,
      result: created,
      createdAt: Date.now(),
    });
  }

  return created;
}

/** List all non-deleted alerts for a wallet address. */
export async function listAlerts(walletAddress: string) {
  const alerts = await prisma.userAlert.findMany({
    where: { walletAddress, status: { not: "deleted" } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  return sortNotificationsDeterministically(alerts);
}

/** Soft-delete an alert (sets status to "deleted"). */
export async function deleteAlert(id: string, walletAddress: string) {
  const alert = await prisma.userAlert.findFirst({
    where: { id, walletAddress },
  });
  if (!alert) throw new Error("Alert not found");

  return prisma.userAlert.update({
    where: { id },
    data: { status: "deleted" },
  });
}

// ── Evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluate all active alerts for a given vault against the latest APY.
 * Dispatches an email and marks the alert as "triggered" when the condition is met.
 *
 * Called by the APY indexer after each new APY calculation.
 *
 * @param vaultId  - Protocol/vault identifier (matches UserAlert.vaultId)
 * @param currentApy - Latest APY percentage (e.g. 10.5 for 10.5%)
 */
export async function evaluateAlerts(
  vaultId: string,
  currentApy: number,
): Promise<void> {
  if (!Number.isFinite(currentApy)) {
    return;
  }
  const roundedApy = roundToDecimals(currentApy, 4);
  const activeAlerts = await prisma.userAlert.findMany({
    where: { vaultId, status: "active" },
  });

  for (const alert of activeAlerts) {
    const triggered =
      (alert.condition === "above" && roundedApy > alert.thresholdValue) ||
      (alert.condition === "below" && roundedApy < alert.thresholdValue);

    if (!triggered) continue;

    const key = toAlertKey(alert.walletAddress, alert.vaultId);
    const preferences = alertPreferencesStore.get(key);
    if (preferences) {
      const now = new Date();
      const suppress = shouldSuppressAlert(
        now,
        alertLastTriggeredStore.get(key),
        preferences,
      );
      if (suppress || roundedApy < preferences.severityThreshold) {
        continue;
      }
      alertLastTriggeredStore.set(key, now.getTime());
    }

    // Mark triggered first to prevent duplicate emails on concurrent evaluations
    await prisma.userAlert.update({
      where: { id: alert.id },
      data: { status: "triggered", triggeredAt: new Date() },
    });

    await dispatchAlertEmail(alert.email, {
      vaultId: alert.vaultId,
      condition: alert.condition as AlertCondition,
      thresholdValue: alert.thresholdValue,
      currentApy: roundedApy,
    });
  }
}

// ── Email dispatch ──────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatchAlertEmail(
  to: string,
  data: {
    vaultId: string;
    condition: AlertCondition;
    thresholdValue: number;
    currentApy: number;
  },
): Promise<void> {
  const direction = data.condition === "above" ? "risen above" : "fallen below";
  const subject = `StellarYield Alert: ${data.vaultId} APY ${direction} ${data.thresholdValue}%`;

  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#6366f1">StellarYield APY Alert</h2>
      <p>Your alert for <strong>${data.vaultId}</strong> has been triggered.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr>
          <td style="padding:8px;color:#6b7280">Vault</td>
          <td style="padding:8px;font-weight:600">${data.vaultId}</td>
        </tr>
        <tr style="background:#f9fafb">
          <td style="padding:8px;color:#6b7280">Condition</td>
          <td style="padding:8px">APY ${direction} ${data.thresholdValue}%</td>
        </tr>
        <tr>
          <td style="padding:8px;color:#6b7280">Current APY</td>
          <td style="padding:8px;font-weight:600;color:#10b981">${data.currentApy.toFixed(2)}%</td>
        </tr>
      </table>
      <p style="color:#6b7280;font-size:13px">
        This alert has been marked as triggered and will not fire again.
        Log in to StellarYield to create a new alert.
      </p>
    </div>
  `;

  let lastError: Error | unknown = null;

  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    try {
      await sendEmail({ to, subject, html });
      deliveryMetrics.sent++;
      return;
    } catch (err) {
      lastError = err;
      deliveryMetrics.failed++;
      if (attempt < MAX_DELIVERY_ATTEMPTS) {
        deliveryMetrics.retried++;
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(`[alertsService] delivery attempt ${attempt} failed, retrying in ${delay}ms`, err);
        await sleep(delay);
      }
    }
  }

  // All attempts exhausted — move to dead-letter queue
  const errorMsg = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`[alertsService] alert email permanently failed after ${MAX_DELIVERY_ATTEMPTS} attempts, dead-lettering`, lastError);
  deliveryMetrics.deadLettered++;
  deadLetterQueue.push({
    to,
    subject,
    attempts: MAX_DELIVERY_ATTEMPTS,
    lastError: errorMsg,
    failedAt: new Date().toISOString(),
  });
}

/** Reset the in-memory preference store. Intended for testing only. */
export function resetAlertPreferencesStore(): void {
  alertPreferencesStore.clear();
  alertPreferencesVersionStore.clear();
  alertPreferenceContextStore.clear();
  alertLastTriggeredStore.clear();
}

export async function dispatchDriftAlert(
  vaultId: string,
  targetWeight: number,
  actualWeight: number,
  driftAmt: number,
  state: "underweight" | "overweight" | "recovered"
): Promise<void> {
  const operatorEmails = ["operator@stellaryield.com"]; // Fixed operator email
  const subject = `StellarYield Drift Alert: ${vaultId} is ${state}`;
  
  const statusMsg = state === "recovered" 
    ? `The vault ${vaultId} has recovered to its target allocation weight.`
    : `The vault ${vaultId} has drifted from its target allocation weight and is currently ${state}.`;

  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#6366f1">Drift Alert</h2>
      <p>${statusMsg}</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr>
          <td style="padding:8px;color:#6b7280">Vault</td>
          <td style="padding:8px;font-weight:600">${vaultId}</td>
        </tr>
        <tr style="background:#f9fafb">
          <td style="padding:8px;color:#6b7280">Target Weight</td>
          <td style="padding:8px">${(targetWeight * 100).toFixed(2)}%</td>
        </tr>
        <tr>
          <td style="padding:8px;color:#6b7280">Actual Weight</td>
          <td style="padding:8px;font-weight:600">${(actualWeight * 100).toFixed(2)}%</td>
        </tr>
        <tr style="background:#f9fafb">
          <td style="padding:8px;color:#6b7280">Drift Amount</td>
          <td style="padding:8px;font-weight:600">${(driftAmt * 100).toFixed(2)}%</td>
        </tr>
      </table>
    </div>
  `;

  for (const to of operatorEmails) {
    try {
      await sendEmail({ to, subject, html });
    } catch (err) {
      console.error("[alertsService] Failed to send drift alert email", err);
    }
  }
}

// ── Preference Management with Audit Trail ──────────────────────────────

/**
 * Update alert preferences for a wallet+vault pair, recording the audit trail.
 * Returns the new preferences and the audit entry.
 */
export function updateAlertPreferences(
  walletAddress: string,
  vaultId: string,
  newPreferences: AlertPreferences,
  options?: {
    actor?: string;
    source?: AuditSource;
    reason?: string;
    /** Optimistic concurrency (#1903): reject unless the stored version matches. */
    expectedVersion?: number;
    /** Ledger context the caller read the record under (#1908). */
    context?: AlertContextInput;
  },
): {
  preferences: AlertPreferences;
  auditEntry: AlertPreferenceAuditEntry;
  version: number;
} {
  const key = toAlertKey(walletAddress, vaultId);
  const validation = validateAlertPreferences(newPreferences);
  if (!validation.valid || !validation.sanitized) {
    throw new Error(`Invalid alert preferences: ${validation.errors.join("; ")}`);
  }
  const sanitized = validation.sanitized;
  const effectiveContext = resolveContextForWrite(
    alertPreferenceContextStore.get(key),
    parseAlertContext(options?.context, vaultId),
    vaultId,
  );
  let auditEntry: AlertPreferenceAuditEntry | undefined;

  const version = commitPreferences(
    key,
    sanitized,
    options?.expectedVersion,
    (before) => {
      auditEntry = recordPreferenceChange({
        walletAddress,
        vaultId,
        actor: options?.actor ?? walletAddress,
        source: options?.source ?? "api",
        before,
        after: sanitized,
        reason: options?.reason ?? "Preferences updated",
      });
    },
    effectiveContext,
  );

  return { preferences: sanitized, auditEntry: auditEntry!, version };
}

/**
 * Revert alert preferences to a previous audit entry's snapshot.
 * Records the revert in the audit trail with source "revert".
 */
export function revertAlertPreferences(
  walletAddress: string,
  vaultId: string,
  targetEntryId?: string,
  expectedVersion?: number,
  context?: AlertContextInput,
): {
  preferences: AlertPreferences;
  auditEntry: AlertPreferenceAuditEntry;
  version: number;
} {
  const key = toAlertKey(walletAddress, vaultId);
  const effectiveContext = resolveContextForWrite(
    alertPreferenceContextStore.get(key),
    parseAlertContext(context, vaultId),
    vaultId,
  );
  // Checked before the audit trail is read, so a stale revert reads nothing.
  assertExpectedVersion(key, expectedVersion);

  let revertTo: AlertPreferenceAuditEntry | undefined;

  if (targetEntryId) {
    revertTo = getAuditEntryById(walletAddress, vaultId, targetEntryId);
    if (!revertTo) {
      throw new Error(`Audit entry ${targetEntryId} not found`);
    }
  } else {
    revertTo = findRevertTarget(walletAddress, vaultId);
    if (!revertTo) {
      throw new Error("No previous preference snapshot to revert to");
    }
  }

  const revertedPrefs = { ...revertTo.after };
  const target = revertTo;
  let auditEntry: AlertPreferenceAuditEntry | undefined;

  const version = commitPreferences(
    key,
    revertedPrefs,
    expectedVersion,
    (before) => {
      auditEntry = recordPreferenceChange({
        walletAddress,
        vaultId,
        actor: walletAddress,
        source: "revert",
        before,
        after: revertedPrefs,
        reason: `Reverted to audit entry ${target.id}`,
      });
    },
    effectiveContext,
  );

  return { preferences: revertedPrefs, auditEntry: auditEntry!, version };
}

/**
 * Explicitly rebind a record to this server's current network/schema context
 * after a network transition or schema migration. Preferences are preserved;
 * only the binding and the version change. Calling it twice is a safe retry.
 */
export function rebindAlertPreferenceContext(
  walletAddress: string,
  vaultId: string,
  options?: {
    expectedVersion?: number;
    expectedContext?: AlertContextInput;
    actor?: string;
    reason?: string;
  },
): {
  preferences: AlertPreferences;
  auditEntry: AlertPreferenceAuditEntry | null;
  version: number;
  context: AlertPreferenceContext;
  replayed: boolean;
} {
  const key = toAlertKey(walletAddress, vaultId);
  const currentPreferences = alertPreferencesStore.get(key);
  const storedContext = alertPreferenceContextStore.get(key);
  if (!currentPreferences || !storedContext) {
    throw new Error("No alert preferences found for this wallet and vault");
  }

  const expectedContext = parseAlertContext(options?.expectedContext, vaultId);
  if (expectedContext && !contextEquals(storedContext, expectedContext)) {
    throw new AlertPreferenceContextConflictError(
      "STORED_CONTEXT_MISMATCH",
      expectedContext,
      storedContext,
    );
  }
  assertExpectedVersion(key, options?.expectedVersion);

  const nextContext = getServerAlertContext(vaultId);
  if (contextEquals(storedContext, nextContext)) {
    return {
      preferences: currentPreferences,
      auditEntry: null,
      version: alertPreferencesVersionStore.get(key) ?? 1,
      context: nextContext,
      replayed: true,
    };
  }

  let auditEntry: AlertPreferenceAuditEntry | undefined;
  const version = commitPreferences(
    key,
    currentPreferences,
    options?.expectedVersion,
    (before) => {
      auditEntry = recordPreferenceChange({
        walletAddress,
        vaultId,
        actor: options?.actor ?? walletAddress,
        source: "system",
        before,
        after: currentPreferences,
        reason:
          options?.reason ??
          `Rebound alert preferences from network ${storedContext.networkId} to ${nextContext.networkId}`,
      });
    },
    nextContext,
  );

  return {
    preferences: currentPreferences,
    auditEntry: auditEntry ?? null,
    version,
    context: nextContext,
    replayed: false,
  };
}
