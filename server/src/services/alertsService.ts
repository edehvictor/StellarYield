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
}

const alertPreferencesStore = new Map<string, AlertPreferences>();
const alertLastTriggeredStore = new Map<string, number>();

function toAlertKey(walletAddress: string, vaultId: string) {
  return `${walletAddress.toLowerCase()}::${vaultId.toLowerCase()}`;
}

// ── CRUD ────────────────────────────────────────────────────────────────

/**
 * Create a new APY alert for a user.
 * Throws if the user already has MAX_ALERTS_PER_USER active alerts.
 */
export async function createAlert(input: CreateAlertInput) {
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
    alertPreferencesStore.set(key, input.preferences);
    recordPreferenceChange({
      walletAddress: input.walletAddress,
      vaultId: input.vaultId,
      actor: input.walletAddress,
      source: "api",
      before: null,
      after: input.preferences,
      reason: "Initial preference set on alert creation",
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
  options?: { actor?: string; source?: AuditSource; reason?: string },
): {
  preferences: AlertPreferences;
  auditEntry: AlertPreferenceAuditEntry;
} {
  const key = toAlertKey(walletAddress, vaultId);
  const before = alertPreferencesStore.get(key) ?? null;

  alertPreferencesStore.set(key, newPreferences);

  const auditEntry = recordPreferenceChange({
    walletAddress,
    vaultId,
    actor: options?.actor ?? walletAddress,
    source: options?.source ?? "api",
    before,
    after: newPreferences,
    reason: options?.reason ?? "Preferences updated",
  });

  return { preferences: newPreferences, auditEntry };
}

/**
 * Retrieve the current alert preferences for a wallet+vault pair.
 */
export function getAlertPreferences(
  walletAddress: string,
  vaultId: string,
): AlertPreferences | undefined {
  const key = toAlertKey(walletAddress, vaultId);
  return alertPreferencesStore.get(key);
}

/**
 * Revert alert preferences to a previous audit entry's snapshot.
 * Records the revert in the audit trail with source "revert".
 */
export function revertAlertPreferences(
  walletAddress: string,
  vaultId: string,
  targetEntryId?: string,
): {
  preferences: AlertPreferences;
  auditEntry: AlertPreferenceAuditEntry;
} {
  const key = toAlertKey(walletAddress, vaultId);
  const currentPrefs = alertPreferencesStore.get(key);

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
  alertPreferencesStore.set(key, revertedPrefs);

  const auditEntry = recordPreferenceChange({
    walletAddress,
    vaultId,
    actor: walletAddress,
    source: "revert",
    before: currentPrefs ?? null,
    after: revertedPrefs,
    reason: `Reverted to audit entry ${revertTo.id}`,
  });

  return { preferences: revertedPrefs, auditEntry };
}
