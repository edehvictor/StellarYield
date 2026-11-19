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

export class FailoverIncidentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FailoverIncidentValidationError";
  }
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp) || !/^\d{4}-\d\d-\d\dT/.test(value)) {
    throw new FailoverIncidentValidationError(`${field} must be a valid ISO-8601 timestamp.`);
  }
  return timestamp;
}

function validateIncidentInput(params: {
  protocolId: string;
  protocolName: string;
  reasons: string[];
  startedAt?: string;
}): string {
  if (typeof params.protocolId !== "string" || typeof params.protocolName !== "string" ||
      !params.protocolId.trim() || !params.protocolName.trim()) {
    throw new FailoverIncidentValidationError("protocolId and protocolName must not be empty.");
  }
  if (!Array.isArray(params.reasons) || params.reasons.length === 0 ||
      params.reasons.some((reason) => typeof reason !== "string" || !reason.trim())) {
    throw new FailoverIncidentValidationError("reasons must contain at least one non-empty string.");
  }
  if (params.startedAt !== undefined && typeof params.startedAt !== "string") {
    throw new FailoverIncidentValidationError("startedAt must be a valid ISO-8601 timestamp.");
  }
  const startedAt = params.startedAt ?? new Date().toISOString();
  parseTimestamp(startedAt, "startedAt");
  return startedAt;
}

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
    const startedAt = validateIncidentInput(params);
    const incident: FailoverIncident = {
      id: String(_nextId),
      protocolId: params.protocolId.trim(),
      protocolName: params.protocolName.trim(),
      trigger: triggerFromReasons(params.reasons),
      reasons: [...params.reasons],
      startedAt,
      resolved: false,
    };
    _incidents.push(incident);
    _nextId += 1;
    return { ...incident, reasons: [...incident.reasons] };
  },

  /**
   * Mark an open incident for a protocol as resolved.
   * Returns the updated incident, or null if none was open.
   */
  resolveIncident(protocolId: string, recoveredAt?: string): FailoverIncident | null {
    if (!protocolId.trim()) {
      throw new FailoverIncidentValidationError("protocolId must not be empty.");
    }
    if (recoveredAt !== undefined && typeof recoveredAt !== "string") {
      throw new FailoverIncidentValidationError("recoveredAt must be a valid ISO-8601 timestamp.");
    }
    const recoveryTs = recoveredAt ?? new Date().toISOString();
    const recoveryTime = parseTimestamp(recoveryTs, "recoveredAt");
    const incident = _incidents
      .slice()
      .reverse()
      .find((i) => i.protocolId === protocolId.trim() && !i.resolved);
    if (!incident) {
      // A retried request after a lost response is successful if it repeats
      // the same recovery timestamp. Different timestamps remain a conflict.
      const completed = _incidents
        .slice()
        .reverse()
        .find((i) => i.protocolId === protocolId.trim() && i.resolved);
      if (completed?.recoveredAt === recoveryTs) return { ...completed, reasons: [...completed.reasons] };
      return null;
    }

    const startedTime = parseTimestamp(incident.startedAt, "startedAt");
    if (recoveryTime < startedTime) {
      throw new FailoverIncidentValidationError("recoveredAt must be at or after startedAt.");
    }

    const durationMs = recoveryTime - startedTime;
    // Prepare all completion fields before mutating the stored open incident.
    Object.assign(incident, { recoveredAt: recoveryTs, durationMs, resolved: true });
    return { ...incident, reasons: [...incident.reasons] };
  },

  /**
   * Return all incidents, newest first. Optionally filter by protocolId.
   */
  getHistory(protocolId?: string): FailoverIncident[] {
    const list = protocolId
      ? _incidents.filter((i) => i.protocolId === protocolId)
      : _incidents;
    return list.slice().reverse().map((incident) => ({ ...incident, reasons: [...incident.reasons] }));
  },

  /** Reset store (test hook). */
  reset(): void {
    _incidents = [];
    _nextId = 1;
  },
};
