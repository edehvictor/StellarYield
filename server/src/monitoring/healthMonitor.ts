import axios from "axios";
import type { HealthStatus } from "../routes/health";

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
          ? "HIGH"
          : "MEDIUM";
        await sendAlert(issues.join("\n"), severity);
      }
    } catch {
      await sendAlert("🚨 BACKEND API IS UNREACHABLE!", "CRITICAL");
    }
  }, CHECK_INTERVAL);
}

async function sendAlert(message: string, severity: string) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn("Alert triggered but no webhook URL configured:", message);
    return;
  }

  const color =
    severity === "CRITICAL" ? 0xff0000 : severity === "HIGH" ? 0xff6600 : 0xffaa00;

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
