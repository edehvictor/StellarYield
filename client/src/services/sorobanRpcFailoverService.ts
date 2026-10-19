/**
 * Client Soroban RPC Failover Service
 *
 * Interacts with the backend `/api/rpc` endpoints to fetch Soroban RPC
 * node health, failover metrics, and alert hook telemetry.
 */

import { getApiBase } from "../lib/api";

export interface SorobanRpcEndpointInfo {
  url: string;
  priority: number;
  status: "healthy" | "degraded" | "down";
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalFailoversFrom: number;
  totalFailoversTo: number;
  latencyMs: number;
  lastCheckedAt: string | null;
  lastFailureReason: string | null;
  lastRecoveredAt: string | null;
}

export interface RpcFailoverIncident {
  id: string;
  timestamp: string;
  fromEndpoint: string;
  toEndpoint: string;
  reason: string;
  errorCode?: string;
  activePriority: number;
}

export interface SorobanRpcAlert {
  id: string;
  timestamp: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  eventType: string;
  message: string;
  fromEndpoint?: string;
  toEndpoint?: string;
  failedEndpoint?: string;
  reason: string;
  consecutiveFailures: number;
  totalFailovers: number;
}

export interface SorobanRpcStatusSnapshot {
  activeEndpoint: string;
  activePriority: number;
  status: "healthy" | "failover_active" | "all_down";
  totalFailovers: number;
  configuredEndpointsCount: number;
  endpoints: SorobanRpcEndpointInfo[];
  recentFailovers: RpcFailoverIncident[];
  recentAlerts: SorobanRpcAlert[];
  timestamp: string;
}

export async function fetchSorobanRpcStatus(): Promise<SorobanRpcStatusSnapshot> {
  const base = getApiBase();
  const res = await fetch(`${base}/api/rpc/status`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Soroban RPC status (HTTP ${res.status})`);
  }
  return res.json();
}

export async function triggerManualFailover(
  targetEndpoint?: string,
  reason?: string,
): Promise<{ success: boolean; activeEndpoint: string }> {
  const base = getApiBase();
  const res = await fetch(`${base}/api/rpc/failover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetEndpoint, reason }),
  });
  if (!res.ok) {
    throw new Error(`Failover trigger failed (HTTP ${res.status})`);
  }
  return res.json();
}

export async function triggerProbeRecovery(): Promise<{ success: boolean }> {
  const base = getApiBase();
  const res = await fetch(`${base}/api/rpc/probe`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Probe recovery failed (HTTP ${res.status})`);
  }
  return res.json();
}
