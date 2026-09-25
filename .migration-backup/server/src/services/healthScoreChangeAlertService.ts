// ── Health Score Change Alert Service ──────────────────────────────────────
// Detects significant changes in strategy health scores and dispatches
// alerts with old/new score context and the factors that changed.

import { sendEmail } from "./emailService";
import type { StrategyHealthScore, StrategyHealthMetrics } from "./strategyHealthService";

export interface HealthScoreChangeAlert {
  strategyId: string;
  strategyName: string;
  previousScore: number;
  currentScore: number;
  previousStatus: string;
  currentStatus: string;
  scoreDelta: number;
  changedFactors: ChangedFactor[];
  timestamp: string;
}

export interface ChangedFactor {
  metric: string;
  previousValue: number;
  currentValue: number;
  delta: number;
  significant: boolean;
}

// ── Configuration ─────────────────────────────────────────────────────────

const SCORE_CHANGE_THRESHOLD = 10; // Minimum score change to trigger alert
const METRIC_CHANGE_THRESHOLD = 0.15; // 15% change in a metric to be "significant"
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between alerts for same strategy

// ── State ─────────────────────────────────────────────────────────────────

const previousScores = new Map<string, StrategyHealthScore>();
const lastAlertTime = new Map<string, number>();
const alertHistory: HealthScoreChangeAlert[] = [];

const MAX_HISTORY = 200;

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Evaluate a new health score against the previous one.
 * Returns an alert if the change is significant, null otherwise.
 */
export function evaluateHealthScoreChange(
  current: StrategyHealthScore,
): HealthScoreChangeAlert | null {
  const previous = previousScores.get(current.strategyId);

  // Store current score for next comparison
  previousScores.set(current.strategyId, { ...current });

  if (!previous) {
    return null; // No baseline to compare against
  }

  const scoreDelta = current.overallScore - previous.overallScore;
  const absDelta = Math.abs(scoreDelta);

  // Check if change exceeds threshold
  if (absDelta < SCORE_CHANGE_THRESHOLD) {
    return null;
  }

  // Check cooldown
  const lastAlert = lastAlertTime.get(current.strategyId);
  if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) {
    return null;
  }

  // Identify changed factors
  const changedFactors = identifyChangedFactors(previous.metrics, current.metrics);

  const alert: HealthScoreChangeAlert = {
    strategyId: current.strategyId,
    strategyName: current.strategyName,
    previousScore: previous.overallScore,
    currentScore: current.overallScore,
    previousStatus: previous.status,
    currentStatus: current.status,
    scoreDelta,
    changedFactors,
    timestamp: new Date().toISOString(),
  };

  // Record alert
  lastAlertTime.set(current.strategyId, Date.now());
  alertHistory.unshift(alert);
  if (alertHistory.length > MAX_HISTORY) alertHistory.length = MAX_HISTORY;

  return alert;
}

/**
 * Dispatch a health score change alert email.
 */
export async function dispatchHealthScoreChangeAlert(
  alert: HealthScoreChangeAlert,
  recipientEmail: string,
): Promise<void> {
  const direction = alert.scoreDelta > 0 ? "improved" : "declined";
  const directionColor = alert.scoreDelta > 0 ? "#10b981" : "#ef4444";

  const factorRows = alert.changedFactors
    .filter((f) => f.significant)
    .map(
      (f) => `
      <tr>
        <td style="padding:6px 8px;color:#6b7280;text-transform:capitalize">${formatMetricName(f.metric)}</td>
        <td style="padding:6px 8px">${(f.previousValue * 100).toFixed(1)}%</td>
        <td style="padding:6px 8px;font-weight:600">${(f.currentValue * 100).toFixed(1)}%</td>
        <td style="padding:6px 8px;color:${f.delta > 0 ? "#10b981" : "#ef4444"}">
          ${f.delta > 0 ? "+" : ""}${(f.delta * 100).toFixed(1)}%
        </td>
      </tr>`,
    )
    .join("");

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
      <h2 style="color:#6366f1">StellarYield Health Score Alert</h2>
      <p>Strategy <strong>${alert.strategyName}</strong> health score has ${direction}.</p>

      <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f9fafb;border-radius:8px;overflow:hidden">
        <tr>
          <td style="padding:8px 12px;color:#6b7280">Previous Score</td>
          <td style="padding:8px 12px;font-weight:600">${alert.previousScore} (${alert.previousStatus})</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;color:#6b7280">Current Score</td>
          <td style="padding:8px 12px;font-weight:600;color:${directionColor}">${alert.currentScore} (${alert.currentStatus})</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;color:#6b7280">Change</td>
          <td style="padding:8px 12px;font-weight:600;color:${directionColor}">
            ${alert.scoreDelta > 0 ? "+" : ""}${alert.scoreDelta} points
          </td>
        </tr>
      </table>

      ${
        factorRows
          ? `
        <h3 style="color:#374151;font-size:14px;margin-top:24px">Changed Factors</h3>
        <table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:13px">
          <thead>
            <tr style="border-bottom:1px solid #e5e7eb">
              <th style="text-align:left;padding:6px 8px;color:#9ca3af;font-weight:500">Metric</th>
              <th style="text-align:left;padding:6px 8px;color:#9ca3af;font-weight:500">Previous</th>
              <th style="text-align:left;padding:6px 8px;color:#9ca3af;font-weight:500">Current</th>
              <th style="text-align:left;padding:6px 8px;color:#9ca3af;font-weight:500">Change</th>
            </tr>
          </thead>
          <tbody>${factorRows}</tbody>
        </table>
      `
          : ""
      }

      <p style="color:#6b7280;font-size:12px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:12px">
        This alert was generated because the health score changed by ${Math.abs(alert.scoreDelta)} points
        (threshold: ${SCORE_CHANGE_THRESHOLD}).
      </p>
    </div>
  `;

  try {
    await sendEmail({
      to: recipientEmail,
      subject: `StellarYield: ${alert.strategyName} health ${direction} to ${alert.currentScore}`,
      html,
    });
  } catch (err) {
    console.error("[healthScoreChangeAlert] Failed to send email", err);
  }
}

/**
 * Get recent health score change alerts.
 */
export function getAlertHistory(limit: number = 50): HealthScoreChangeAlert[] {
  return alertHistory.slice(0, limit);
}

/**
 * Clear state (for testing).
 */
export function resetState(): void {
  previousScores.clear();
  lastAlertTime.clear();
  alertHistory.length = 0;
}

// ── Internal helpers ──────────────────────────────────────────────────────

function identifyChangedFactors(
  prev: StrategyHealthMetrics,
  curr: StrategyHealthMetrics,
): ChangedFactor[] {
  const metrics: Array<{ key: keyof StrategyHealthMetrics; prev: number; curr: number }> = [
    { key: "contractSafety", prev: prev.contractSafety, curr: curr.contractSafety },
    { key: "dataFreshness", prev: prev.dataFreshness, curr: curr.dataFreshness },
    { key: "providerUptime", prev: prev.providerUptime, curr: curr.providerUptime },
    { key: "liquidityConditions", prev: prev.liquidityConditions, curr: curr.liquidityConditions },
    { key: "executionOutcomes", prev: prev.executionOutcomes, curr: curr.executionOutcomes },
    { key: "volatilityIndex", prev: prev.volatilityIndex, curr: curr.volatilityIndex },
    { key: "errorRate", prev: prev.errorRate, curr: curr.errorRate },
    { key: "latency", prev: prev.latency, curr: curr.latency },
  ];

  return metrics.map(({ key, prev: p, curr: c }) => {
    const delta = c - p;
    const absDelta = Math.abs(delta);
    const base = Math.max(Math.abs(p), 0.001);
    const pctChange = absDelta / base;

    return {
      metric: key,
      previousValue: p,
      currentValue: c,
      delta,
      significant: pctChange >= METRIC_CHANGE_THRESHOLD,
    };
  });
}

function formatMetricName(metric: string): string {
  return metric
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
