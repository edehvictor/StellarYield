/**
 * Portfolio Regime Shift Notification Engine — Issue #376
 *
 * Detects when a user's portfolio has entered a materially different yield/risk
 * regime and dispatches notifications (in-app + optional email) with a concise
 * rationale.
 *
 * Cooldown: one notification per wallet per (previousRegime → currentRegime)
 * transition within REGIME_SHIFT_COOLDOWN_MS to prevent alert fatigue.
 *
 * Security: every DB query is scoped by walletAddress to prevent cross-user leakage.
 */

import { PrismaClient } from "@prisma/client";
import {
  YieldRegimeService,
  YieldSnapshot,
  YieldRegime,
  RegimeClassification,
} from "./yieldRegimeService";
import { sendEmail } from "./emailService";

const prisma = new PrismaClient();

export const REGIME_SHIFT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MIN_CONFIDENCE = 0.3;

export interface RegimeShiftInput {
  walletAddress: string;
  snapshots: YieldSnapshot[];
  email?: string;
  timeWindow?: "24h" | "7d" | "30d";
}

export interface RegimeShiftResult {
  shifted: boolean;
  previousRegime: YieldRegime | null;
  currentRegime: YieldRegime;
  classification: RegimeClassification;
  notificationSent: boolean;
  cooldownActive: boolean;
  alertId?: string;
}

const regimeService = new YieldRegimeService();

export async function detectAndNotifyRegimeShift(
  input: RegimeShiftInput
): Promise<RegimeShiftResult> {
  const { walletAddress, snapshots, email, timeWindow = "7d" } = input;
  const wallet = walletAddress.toLowerCase();

  const classification = regimeService.classifyRegime(snapshots, timeWindow);
  const currentRegime = classification.regime;

  const lastAlert = await prisma.portfolioRegimeShiftAlert.findFirst({
    where: { walletAddress: wallet },
    orderBy: { createdAt: "desc" },
  });

  // Seed initial state on first detection — no notification yet
  if (lastAlert === null) {
    await prisma.portfolioRegimeShiftAlert.create({
      data: {
        walletAddress: wallet,
        previousRegime: currentRegime,
        currentRegime,
        confidence: classification.confidence,
        rationale: "Initial portfolio regime recorded",
      },
    });
    return {
      shifted: false,
      previousRegime: null,
      currentRegime,
      classification,
      notificationSent: false,
      cooldownActive: false,
    };
  }

  const previousRegime = lastAlert.currentRegime as YieldRegime;
  const shifted = previousRegime !== currentRegime;

  if (!shifted || classification.confidence < MIN_CONFIDENCE) {
    return {
      shifted,
      previousRegime,
      currentRegime,
      classification,
      notificationSent: false,
      cooldownActive: false,
    };
  }

  // Deduplication: block if same transition already alerted within cooldown window
  const cooldownCutoff = new Date(Date.now() - REGIME_SHIFT_COOLDOWN_MS);
  const recentDuplicate = await prisma.portfolioRegimeShiftAlert.findFirst({
    where: {
      walletAddress: wallet,
      previousRegime,
      currentRegime,
      createdAt: { gte: cooldownCutoff },
    },
  });

  if (recentDuplicate) {
    return {
      shifted: true,
      previousRegime,
      currentRegime,
      classification,
      notificationSent: false,
      cooldownActive: true,
    };
  }

  const alert = await prisma.portfolioRegimeShiftAlert.create({
    data: {
      walletAddress: wallet,
      previousRegime,
      currentRegime,
      confidence: classification.confidence,
      rationale: classification.reasoning,
    },
  });

  await prisma.notification.create({
    data: {
      walletAddress: wallet,
      type: "REGIME_SHIFT",
      title: buildNotificationTitle(previousRegime, currentRegime),
      message: buildNotificationMessage(classification, previousRegime),
    },
  });

  let notificationSent = true;

  if (email) {
    try {
      await sendEmail({
        to: email,
        subject: buildEmailSubject(currentRegime),
        html: buildEmailHtml(classification, previousRegime),
      });
      await prisma.portfolioRegimeShiftAlert.update({
        where: { id: alert.id },
        data: { notified: true, notifiedAt: new Date() },
      });
    } catch (err) {
      console.error("[portfolioRegimeShift] Email dispatch failed for", wallet, err);
      notificationSent = false;
    }
  }

  return {
    shifted: true,
    previousRegime,
    currentRegime,
    classification,
    notificationSent,
    cooldownActive: false,
    alertId: alert.id,
  };
}

export async function getShiftHistory(
  walletAddress: string,
  limit = 20
) {
  return prisma.portfolioRegimeShiftAlert.findMany({
    where: { walletAddress: walletAddress.toLowerCase() },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// ── Label helpers ──────────────────────────────────────────────────────────────

const REGIME_LABELS: Record<YieldRegime, string> = {
  stable: "Stable",
  "high-volatility": "High Volatility",
  "declining-yield": "Declining Yield",
  "incentive-spike": "Incentive Spike",
};

function label(r: YieldRegime): string {
  return REGIME_LABELS[r] ?? r;
}

// ── Copy builders ─────────────────────────────────────────────────────────────

function buildNotificationTitle(prev: YieldRegime, curr: YieldRegime): string {
  return `Portfolio regime shift: ${label(prev)} → ${label(curr)}`;
}

function buildNotificationMessage(
  c: RegimeClassification,
  prev: YieldRegime
): string {
  return (
    `Your portfolio has moved from a ${label(prev)} regime to ` +
    `${label(c.regime)} (${(c.confidence * 100).toFixed(0)}% confidence). ` +
    c.reasoning
  );
}

function buildEmailSubject(curr: YieldRegime): string {
  return `StellarYield: Your portfolio entered a ${label(curr)} regime`;
}

function buildEmailHtml(c: RegimeClassification, prev: YieldRegime): string {
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#6366f1">Portfolio Regime Shift Detected</h2>
      <p>Your portfolio has entered a materially different yield regime.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr>
          <td style="padding:8px;color:#6b7280">Previous Regime</td>
          <td style="padding:8px;font-weight:600">${label(prev)}</td>
        </tr>
        <tr style="background:#f9fafb">
          <td style="padding:8px;color:#6b7280">Current Regime</td>
          <td style="padding:8px;font-weight:600;color:#6366f1">${label(c.regime)}</td>
        </tr>
        <tr>
          <td style="padding:8px;color:#6b7280">Confidence</td>
          <td style="padding:8px">${(c.confidence * 100).toFixed(0)}%</td>
        </tr>
        <tr style="background:#f9fafb">
          <td style="padding:8px;color:#6b7280">Analysis Window</td>
          <td style="padding:8px">${c.timeWindow}</td>
        </tr>
      </table>
      <p><strong>What changed:</strong> ${c.reasoning}</p>
      <hr/>
      <p style="color:#6b7280;font-size:13px">
        Log in to StellarYield to review your portfolio and adjust your strategy.
      </p>
    </div>
  `;
}
