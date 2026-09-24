import axios from "axios";
import type { HealthStatus } from "../routes/health";
import { AlertSeverity, normalizeSeverity } from "../utils/alertSeverity";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HEALTH_ENDPOINT =
  process.env.HEALTH_ENDPOINT_URL ?? "http://localhost:3001/api/health";
const CHECK_INTERVAL = Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? "60000");

export async function startHealthMonitor() {
  console.log("🚀 Starting Health Monitor...");

  setInterval(async () => {
    try {
      const response = await axios.get<HealthStatus>(HEALTH_ENDPOINT, {
        timeout: 10_000,
      });
      const status = response.data;

      const issues: string[] = [];
      if (status.database === "down") issues.push("❌ Database is DOWN");
      if (status.horizon === "down") issues.push("❌ Stellar Horizon is DOWN");
      if (status.sorobanRpc === "down")
        issues.push("❌ Soroban RPC is DOWN");
      if (status.indexer === "down") issues.push("❌ Indexer is DOWN");
      if (status.indexer === "warning")
        issues.push(
          `⚠️ Indexer is lagging (${status.indexerLag ?? "?"} ledgers behind)`,
        );
      if (status.sorobanRpc === "warning")
        issues.push("⚠️ Soroban RPC is degraded");

      if (issues.length > 0) {
        const severity = issues.some((i) => i.startsWith("❌"))
          ? AlertSeverity.HIGH
          : AlertSeverity.MEDIUM;
        await sendAlert(issues.join("\n"), severity);
      }
    } catch {
      await sendAlert("🚨 BACKEND API IS UNREACHABLE!", AlertSeverity.CRITICAL);
    }
  }, CHECK_INTERVAL);
}

export async function sendAlert(message: string, rawSeverity: string) {
  // Normalize so every alert this service emits uses one of the four
  // canonical AlertSeverity levels, regardless of what the caller passed.
  const severity = normalizeSeverity(rawSeverity);

  if (!DISCORD_WEBHOOK_URL) {
    console.warn("Alert triggered but no webhook URL configured:", message);
    return;
  }

  const color =
    severity === AlertSeverity.CRITICAL
      ? 0xff0000
      : severity === AlertSeverity.HIGH
        ? 0xff6600
        : severity === AlertSeverity.MEDIUM
          ? 0xffaa00
          : 0xffdd55;

  const payload = {
    embeds: [
      {
        title: `Backend Health Alert — ${severity}`,
        description: message,
        color,
        timestamp: new Date().toISOString(),
        footer: { text: "Stellar Yield Monitor" },
      },
    ],
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, payload);
  } catch (err) {
    console.error("Failed to send alert to Discord", err);
  }
}
