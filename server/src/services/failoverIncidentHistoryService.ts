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
  /** Optimistic concurrency token. Increments on every mutation. */
  version: number;
}

let _incidents: FailoverIncident[] = [];
let _nextId = 1;

export class FailoverIncidentValidationError extends Error {
  readonly code = "MALFORMED_INCIDENT_PAYLOAD";

  constructor(message: string) {
    super(message);
    this.name = "FailoverIncidentValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Thrown when a caller's expected version no longer matches the stored state. */
export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyConflictError";
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
}): { protocolId: string; protocolName: string; reasons: string[]; startedAt: string } {
  if (!isPlainObject(params)) {
    throw new FailoverIncidentValidationError("incident payload must be an object.");
  }
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
  return {
    protocolId: params.protocolId.trim(),
    protocolName: params.protocolName.trim(),
    reasons: params.reasons.map((reason) => reason.trim()),
    startedAt,
  };
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
    const validated = validateIncidentInput(params);
    const incident: FailoverIncident = {
      id: String(_nextId),
      protocolId: validated.protocolId,
      protocolName: validated.protocolName,
      trigger: triggerFromReasons(validated.reasons),
      reasons: [...validated.reasons],
      startedAt: validated.startedAt,
      resolved: false,
      version: 1,
    };
    _incidents.push(incident);
    _nextId += 1;
    return { ...incident, reasons: [...incident.reasons] };
  },

  /**
   * Mark an open incident for a protocol as resolved.
   * Returns the updated incident, or null if none was open.
   *
   * Optimistic concurrency: when `expectedVersion` is provided and does not
   * match the stored incident's current version, the state has changed
   * concurrently and a `ConcurrencyConflictError` is thrown without mutating
   * anything, so the caller can re-read and retry safely.
   */
  resolveIncident(
    protocolId: string,
    recoveredAt?: string,
    expectedVersion?: number,
  ): FailoverIncident | null {
    if (typeof protocolId !== "string" || !protocolId.trim()) {
      throw new FailoverIncidentValidationError("protocolId must not be empty.");
    }
    if (recoveredAt !== undefined && typeof recoveredAt !== "string") {
      throw new FailoverIncidentValidationError("recoveredAt must be a valid ISO-8601 timestamp.");
    }
    if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) {
      throw new FailoverIncidentValidationError("expectedVersion must be an integer.");
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

    // Optimistic concurrency guard: reject if the caller's view is stale.
    // This runs before any mutation, so existing state is preserved on conflict.
    if (expectedVersion !== undefined && incident.version !== expectedVersion) {
      throw new ConcurrencyConflictError(
        `Incident ${incident.id} for protocol ${protocolId.trim()} has been updated concurrently (expected v${expectedVersion}, current v${incident.version}).`,
      );
    }

    const startedTime = parseTimestamp(incident.startedAt, "startedAt");
    if (recoveryTime < startedTime) {
      throw new FailoverIncidentValidationError("recoveredAt must be at or after startedAt.");
    }

    const durationMs = recoveryTime - startedTime;
    // Prepare all completion fields before mutating the stored open incident.
    Object.assign(incident, { recoveredAt: recoveryTs, durationMs, resolved: true, version: incident.version + 1 });
    return { ...incident, reasons: [...incident.reasons] };
  },

  /**
   * Return all incidents, newest first. Optionally filter by protocolId.
   */
  getHistory(protocolId?: string): FailoverIncident[] {
    if (protocolId !== undefined && (typeof protocolId !== "string" || !protocolId.trim())) {
      throw new FailoverIncidentValidationError("protocolId filter must be a non-empty string.");
    }
    const normalizedId = protocolId?.trim();
    const list = normalizedId
      ? _incidents.filter((i) => i.protocolId === normalizedId)
      : _incidents;
    return list.slice().reverse().map((incident) => ({ ...incident, reasons: [...incident.reasons] }));
  },

  /** Reset store (test hook). */
  reset(): void {
    _incidents = [];
    _nextId = 1;
  },
};
