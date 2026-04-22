import axios from "axios";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HEALTH_ENDPOINT = "http://localhost:3001/api/health";
const CHECK_INTERVAL = 60000; // 1 minute

export async function startHealthMonitor() {
  console.log("🚀 Starting Health Monitor...");
  
  setInterval(async () => {
    try {
      const response = await axios.get(HEALTH_ENDPOINT);
      const status = response.data;
      
      const issues = [];
      if (status.database === "down") issues.push("❌ Database is DOWN");
      if (status.horizon === "down") issues.push("❌ Stellar Horizon is DOWN");
      if (status.indexer === "warning") issues.push("⚠️ Indexer is lagging behind");

      if (issues.length > 0) {
        await sendAlert(issues.join("\n"), "HIGH");
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

  const payload = {
    embeds: [{
      title: `Backend Health Alert - ${severity}`,
      description: message,
      color: severity === "CRITICAL" ? 0xFF0000 : 0xFFAA00,
      timestamp: new Date().toISOString(),
      footer: { text: "Stellar Yield Monitor" }
    }]
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, payload);
  } catch (err) {
    console.error("Failed to send alert to Discord", err);
  }
}
