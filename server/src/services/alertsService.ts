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
 *
 * Resilience:
 *  - Email dispatch retries up to MAX_DELIVERY_ATTEMPTS times with exponential backoff.
 *  - Permanently failed deliveries land in the dead-letter queue (deadLetterQueue).
 *  - deliveryMetrics tracks sent/failed/retried/dead-lettered counts for operators.
 */

import { PrismaClient } from "@prisma/client";
import { sendEmail } from "./emailService";
import { shouldSuppressAlert, type AlertPreferences } from "./alertsPreferenceRules";
import {
  recordPreferenceChange,
  getPreferenceAuditHistory,
  getAuditEntryById,
  findRevertTarget,
  type AlertPreferenceAuditEntry,
  type AuditSource,
} from "./alertPreferenceAuditService";

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
): number {
  assertExpectedVersion(key, expectedVersion);
  const hadBefore = alertPreferencesStore.has(key);
  const before = alertPreferencesStore.get(key) ?? null;
  const previousVersion = alertPreferencesVersionStore.get(key) ?? 0;
  const nextVersion = previousVersion + 1;
  alertPreferencesStore.set(key, next);
  alertPreferencesVersionStore.set(key, nextVersion);
  try {
    sideEffect?.(before);
  } catch (error) {
    if (hadBefore && before) alertPreferencesStore.set(key, before);
    else alertPreferencesStore.delete(key);
    if (previousVersion === 0) alertPreferencesVersionStore.delete(key);
    else alertPreferencesVersionStore.set(key, previousVersion);
    throw error;
  }
  return nextVersion;
}

function toAlertKey(walletAddress: string, vaultId: string) {
  return `${walletAddress.toLowerCase()}::${vaultId.toLowerCase()}`;
}

export function computeAlertFingerprint(input: {
  walletAddress: string;
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: number;
  email: string;
  preferences?: AlertPreferences;
}): string {
  return JSON.stringify({
    walletAddress: input.walletAddress.trim().toLowerCase(),
    vaultId: input.vaultId.trim().toLowerCase(),
    condition: input.condition,
    thresholdValue: Number(input.thresholdValue),
    email: input.email.trim().toLowerCase(),
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
): AlertPreferences | undefined {
  return alertPreferencesStore.get(toAlertKey(walletAddress, vaultId));
}

export function setAlertPreferences(
  walletAddress: string,
  vaultId: string,
  preferences: AlertPreferences,
  operationIdentity?: string,
  expectedVersion?: number,
): { preferences: AlertPreferences; replayed: boolean; version: number } {
  const key = toAlertKey(walletAddress, vaultId);
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

  // A version conflict throws before anything is written or recorded, so the
  // same operation identity can be retried after the client reloads.
  const version = commitPreferences(key, preferences, expectedVersion);

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

export function clearAlertPreferencesStore(): void {
  alertPreferencesStore.clear();
  alertPreferencesVersionStore.clear();
  alertLastTriggeredStore.clear();
}

// ── CRUD ────────────────────────────────────────────────────────────────

/**
 * Create a new APY alert for a user.
 * Throws if the user already has MAX_ALERTS_PER_USER active alerts.
 */
export async function createAlert(input: CreateAlertInput) {
  const currentFingerprint = computeAlertFingerprint(input);

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
      thresholdValue: input.thresholdValue,
      email: input.email,
      status: "active",
    },
  });
  if (input.preferences) {
    const key = toAlertKey(input.walletAddress, input.vaultId);
    const initial = input.preferences;
    commitPreferences(key, initial, undefined, (before) => {
      recordPreferenceChange({
        walletAddress: input.walletAddress,
        vaultId: input.vaultId,
        actor: input.walletAddress,
        source: "api",
        before,
        after: initial,
        reason: "Initial preference set on alert creation",
      });
    });
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
  return prisma.userAlert.findMany({
    where: { walletAddress, status: { not: "deleted" } },
    orderBy: { createdAt: "desc" },
  });
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
  const activeAlerts = await prisma.userAlert.findMany({
    where: { vaultId, status: "active" },
  });

  for (const alert of activeAlerts) {
    const triggered =
      (alert.condition === "above" && currentApy > alert.thresholdValue) ||
      (alert.condition === "below" && currentApy < alert.thresholdValue);

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
      if (suppress || currentApy < preferences.severityThreshold) {
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
      currentApy,
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
  },
): {
  preferences: AlertPreferences;
  auditEntry: AlertPreferenceAuditEntry;
  version: number;
} {
  const key = toAlertKey(walletAddress, vaultId);
  let auditEntry: AlertPreferenceAuditEntry | undefined;

  const version = commitPreferences(key, newPreferences, options?.expectedVersion, (before) => {
    auditEntry = recordPreferenceChange({
      walletAddress,
      vaultId,
      actor: options?.actor ?? walletAddress,
      source: options?.source ?? "api",
      before,
      after: newPreferences,
      reason: options?.reason ?? "Preferences updated",
    });
  });

  return { preferences: newPreferences, auditEntry: auditEntry!, version };
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
): {
  preferences: AlertPreferences;
  auditEntry: AlertPreferenceAuditEntry;
  version: number;
} {
  const key = toAlertKey(walletAddress, vaultId);
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

  const version = commitPreferences(key, revertedPrefs, expectedVersion, (before) => {
    auditEntry = recordPreferenceChange({
      walletAddress,
      vaultId,
      actor: walletAddress,
      source: "revert",
      before,
      after: revertedPrefs,
      reason: `Reverted to audit entry ${target.id}`,
    });
  });

  return { preferences: revertedPrefs, auditEntry: auditEntry!, version };
}
