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
 */

import { PrismaClient } from "@prisma/client";
import { sendEmail } from "./emailService";

const prisma = new PrismaClient();

/** Hard cap on active alerts per wallet address. */
export const MAX_ALERTS_PER_USER = 20;

export type AlertCondition = "above" | "below";

export interface CreateAlertInput {
  walletAddress: string;
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: number;
  email: string;
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

  return prisma.userAlert.create({
    data: {
      walletAddress: input.walletAddress,
      vaultId: input.vaultId,
      condition: input.condition,
      thresholdValue: input.thresholdValue,
      email: input.email,
      status: "active",
    },
  });
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

  try {
    await sendEmail({ to, subject, html });
  } catch (err) {
    // Log but don't throw — a failed email should not roll back the DB update
    console.error("[alertsService] Failed to send alert email", err);
  }
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
