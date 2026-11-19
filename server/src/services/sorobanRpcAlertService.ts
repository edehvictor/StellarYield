/**
 * Soroban RPC Alert Service
 *
 * Dispatches alert hooks when Soroban RPC failover events occur,
 * including node degradation, failover switching, recovery, or total RPC outage.
 *
 * Resilient, typed, and throttled to prevent notification flooding.
 */

import axios from "axios";

export type RpcAlertSeverity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";

export type RpcAlertEventType =
  | "FAILOVER_TRIGGERED"
  | "ALL_ENDPOINTS_DOWN"
  | "PRIMARY_RECOVERED"
  | "ENDPOINT_DEGRADED"
  | "ENDPOINT_RECOVERED";

export interface SorobanRpcAlert {
  id: string;
  timestamp: string;
  severity: RpcAlertSeverity;
  eventType: RpcAlertEventType;
  message: string;
  fromEndpoint?: string;
  toEndpoint?: string;
  failedEndpoint?: string;
  reason: string;
  consecutiveFailures: number;
  totalFailovers: number;
  details?: Record<string, unknown>;
}

export type RpcAlertHook = (alert: SorobanRpcAlert) => Promise<void> | void;

export class SorobanRpcAlertService {
  private hooks: Map<string, RpcAlertHook> = new Map();
  private alertHistory: SorobanRpcAlert[] = [];
  private readonly maxHistorySize = 100;
  private readonly cooldownMs: number;
  private lastAlertTimestamps: Map<string, number> = new Map();

  constructor(cooldownMs = 30_000) {
    this.cooldownMs = cooldownMs;
    this.registerDefaultWebhookHook();
  }

  /**
   * Register an alert hook callback.
   * Returns an unregister function.
   */
  public registerHook(name: string, hook: RpcAlertHook): () => void {
    this.hooks.set(name, hook);
    return () => {
      this.hooks.delete(name);
    };
  }

  /**
   * Unregister an alert hook by name.
   */
  public unregisterHook(name: string): boolean {
    return this.hooks.delete(name);
  }

  /**
   * Check if an alert is within cooldown for its eventType and endpoint.
   */
  private isThrottled(eventType: RpcAlertEventType, endpointKey = "global"): boolean {
    const key = `${eventType}::${endpointKey}`;
    const lastTime = this.lastAlertTimestamps.get(key);
    const now = Date.now();
    if (lastTime && now - lastTime < this.cooldownMs) {
      return true;
    }
    this.lastAlertTimestamps.set(key, now);
    return false;
  }

  /**
   * Dispatch an alert through all registered alert hooks.
   */
  public async dispatchAlert(
    input: Omit<SorobanRpcAlert, "id" | "timestamp">,
    bypassThrottle = false,
  ): Promise<SorobanRpcAlert | null> {
    const endpointKey = input.failedEndpoint || input.fromEndpoint || "global";
    if (!bypassThrottle && this.isThrottled(input.eventType, endpointKey)) {
      return null;
    }

    const alert: SorobanRpcAlert = {
      ...input,
      id: `rpc-alert-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
    };

    // Store in history ring buffer
    this.alertHistory.unshift(alert);
    if (this.alertHistory.length > this.maxHistorySize) {
      this.alertHistory.pop();
    }

    // Dispatch to all registered hooks in parallel (safe from throwing)
    const promises = Array.from(this.hooks.entries()).map(async ([name, hook]) => {
      try {
        await hook(alert);
      } catch (err) {
        console.error(`[SorobanRpcAlertService] Hook '${name}' failed:`, err);
      }
    });

    await Promise.allSettled(promises);
    return alert;
  }

  /**
   * Get recent alert history.
   */
  public getHistory(limit = 20): SorobanRpcAlert[] {
    return this.alertHistory.slice(0, limit);
  }

  /**
   * Clear all alert history and cooldowns (useful in tests).
   */
  public clear(): void {
    this.alertHistory = [];
    this.lastAlertTimestamps.clear();
  }

  /**
   * Default webhook integration for Discord / Slack / custom webhooks.
   */
  private registerDefaultWebhookHook(): void {
    const webhookUrl =
      process.env.SOROBAN_RPC_ALERT_WEBHOOK_URL ?? process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    this.registerHook("default-webhook", async (alert: SorobanRpcAlert) => {
      const colorMap: Record<RpcAlertSeverity, number> = {
        CRITICAL: 0xff0000, // Red
        HIGH: 0xff6600,     // Orange
        WARNING: 0xffaa00,  // Amber
        INFO: 0x3b82f6,     // Blue
      };

      const embed = {
        title: `🚨 Soroban RPC Alert: ${alert.eventType.replace(/_/g, " ")} [${alert.severity}]`,
        description: alert.message,
        color: colorMap[alert.severity] ?? 0x6366f1,
        fields: [
          { name: "Reason", value: alert.reason || "N/A", inline: true },
          { name: "Total Failovers", value: String(alert.totalFailovers), inline: true },
          ...(alert.fromEndpoint ? [{ name: "From Endpoint", value: alert.fromEndpoint, inline: false }] : []),
          ...(alert.toEndpoint ? [{ name: "Active Endpoint", value: alert.toEndpoint, inline: false }] : []),
          ...(alert.failedEndpoint ? [{ name: "Failed Endpoint", value: alert.failedEndpoint, inline: false }] : []),
        ],
        timestamp: alert.timestamp,
        footer: { text: "StellarYield Soroban RPC Failover Monitor" },
      };

      await axios.post(
        webhookUrl,
        { embeds: [embed] },
        { timeout: 5000 },
      );
    });
  }
}

export const sorobanRpcAlertService = new SorobanRpcAlertService();
