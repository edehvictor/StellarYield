/**
 * Failover Incident History Service
 *
 * Records provider failover incidents (stale data, outage, recovery) in an
 * in-memory store and exposes helpers to create, resolve, and query them.
 *
 * Each incident captures:
 *   - affected protocol
 *   - trigger reason (stale data / outage / degraded)
 *   - start time and optional recovery time
 *   - outage duration (ms) once resolved
 */

export type FailoverIncidentTrigger = "stale_data" | "outage" | "degraded" | "unknown";

export interface FailoverIncident {
  id: string;
  protocolId: string;
  protocolName: string;
  trigger: FailoverIncidentTrigger;
  reasons: string[];
  startedAt: string;   // ISO-8601
  recoveredAt?: string; // ISO-8601, set on recovery
  durationMs?: number;  // set on recovery
  resolved: boolean;
}

let _incidents: FailoverIncident[] = [];
let _nextId = 1;

function triggerFromReasons(reasons: string[]): FailoverIncidentTrigger {
  const joined = reasons.join(" ").toLowerCase();
  if (joined.includes("stale")) return "stale_data";
  if (joined.includes("down") || joined.includes("critical")) return "outage";
  if (joined.includes("degraded") || joined.includes("uptime")) return "degraded";
  return "unknown";
}

export const failoverIncidentHistoryService = {
  /**
   * Record a new failover incident. Returns the created incident.
   */
  recordIncident(params: {
    protocolId: string;
    protocolName: string;
    reasons: string[];
    startedAt?: string;
  }): FailoverIncident {
    const incident: FailoverIncident = {
      id: String(_nextId++),
      protocolId: params.protocolId,
      protocolName: params.protocolName,
      trigger: triggerFromReasons(params.reasons),
      reasons: params.reasons,
      startedAt: params.startedAt ?? new Date().toISOString(),
      resolved: false,
    };
    _incidents.push(incident);
    return incident;
  },

  /**
   * Mark an open incident for a protocol as resolved.
   * Returns the updated incident, or null if none was open.
   */
  resolveIncident(protocolId: string, recoveredAt?: string): FailoverIncident | null {
    const incident = _incidents
      .slice()
      .reverse()
      .find((i) => i.protocolId === protocolId && !i.resolved);
    if (!incident) return null;

    const recoveryTs = recoveredAt ?? new Date().toISOString();
    incident.recoveredAt = recoveryTs;
    incident.durationMs =
      new Date(recoveryTs).getTime() - new Date(incident.startedAt).getTime();
    incident.resolved = true;
    return incident;
  },

  /**
   * Return all incidents, newest first. Optionally filter by protocolId.
   */
  getHistory(protocolId?: string): FailoverIncident[] {
    const list = protocolId
      ? _incidents.filter((i) => i.protocolId === protocolId)
      : _incidents;
    return list.slice().reverse();
  },

  /** Reset store (test hook). */
  reset(): void {
    _incidents = [];
    _nextId = 1;
  },
};
