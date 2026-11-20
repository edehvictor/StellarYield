import { apiUrl } from "../../lib/api";
import type {
  AlertPreferences,
  CreateAlertPayload,
  UserAlert,
  WatchlistDigestPreference,
} from "./types";

const ALERTS_BASE = apiUrl("/api/alerts");
const NOTIFICATIONS_BASE = apiUrl("/api/notifications");

export type AlertClassPreference = Record<string, boolean>;

/**
 * Channel-level notification preferences.
 * `enabled` is the default state for all alert classes on this channel.
 * `alertClasses` values override `enabled` for specific alert classes.
 */
export interface ChannelNotificationPreference {
  enabled: boolean;
  alertClasses: AlertClassPreference;
}

export interface NotificationPreferences {
  channels: {
    email: ChannelNotificationPreference;
    digest: ChannelNotificationPreference;
    in_app: ChannelNotificationPreference;
  };
}

/**
 * Explicit network/ledger context for governance-adjacent reads and writes.
 * When supplied, the context is sent as request headers and any response that
 * reports a different network/ledger is rejected before callers observe it.
 */
export interface AlertContext {
  network?: string;
  ledger?: number | string;
  version?: number | string;
}

/** Thrown when the server responds for a different context than requested. */
export class AlertContextMismatchError extends Error {
  readonly code = "ALERT_CONTEXT_MISMATCH";
  constructor(
    message: string,
    readonly expected: AlertContext,
    readonly actual: AlertContext,
  ) {
    super(message);
    this.name = "AlertContextMismatchError";
  }
}

function contextHeaders(context?: AlertContext): Record<string, string> {
  if (!context) return {};
  const headers: Record<string, string> = {};
  if (context.network) headers["X-Network"] = context.network;
  if (context.ledger !== undefined) headers["X-Ledger"] = String(context.ledger);
  if (context.version !== undefined) headers["X-Context-Version"] = String(context.version);
  return headers;
}

function responseContext(res: Response): AlertContext {
  const network = res.headers.get("X-Network") ?? undefined;
  const ledgerRaw = res.headers.get("X-Ledger");
  const versionRaw = res.headers.get("X-Context-Version");
  const ledger = ledgerRaw === null ? undefined : Number.isSafeInteger(Number(ledgerRaw)) ? Number(ledgerRaw) : ledgerRaw;
  return {
    network,
    ledger,
    version: versionRaw === null ? undefined : versionRaw,
  };
}

/**
 * Rejects a response whose context headers disagree with the requested context.
 * Absent response headers are tolerated for backward compatibility; present ones
 * must match exactly.
 */
function assertContext(res: Response, expected?: AlertContext): void {
  if (!expected) return;
  const actual = responseContext(res);
  const mismatches: string[] = [];
  if (expected.network !== undefined && actual.network !== undefined && actual.network !== expected.network) {
    mismatches.push(`network ${String(actual.network)} != ${expected.network}`);
  }
  if (expected.ledger !== undefined && actual.ledger !== undefined && String(actual.ledger) !== String(expected.ledger)) {
    mismatches.push(`ledger ${String(actual.ledger)} != ${String(expected.ledger)}`);
  }
  if (expected.version !== undefined && actual.version !== undefined && String(actual.version) !== String(expected.version)) {
    mismatches.push(`version ${String(actual.version)} != ${String(expected.version)}`);
  }
  if (mismatches.length > 0) {
    throw new AlertContextMismatchError(
      `Alert response context mismatch: ${mismatches.join(", ")}`,
      expected,
      actual,
    );
  }
}

export async function fetchAlerts(
  walletAddress: string,
  context?: AlertContext,
): Promise<UserAlert[]> {
  const res = await fetch(`${ALERTS_BASE}/${encodeURIComponent(walletAddress)}`, {
    headers: contextHeaders(context),
  });
  if (!res.ok) throw new Error("Failed to fetch alerts");
  assertContext(res, context);
  return res.json() as Promise<UserAlert[]>;
}

export async function createAlert(
  payload: CreateAlertPayload,
  context?: AlertContext,
): Promise<UserAlert> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...contextHeaders(context),
  };
  if (payload.operationIdentity) {
    headers["X-Operation-Identity"] = payload.operationIdentity;
    headers["Idempotency-Key"] = payload.operationIdentity;
  }
  const res = await fetch(ALERTS_BASE, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to create alert");
  }
  assertContext(res, context);
  return res.json() as Promise<UserAlert>;
}

export async function deleteAlert(
  id: string,
  walletAddress: string,
  context?: AlertContext,
): Promise<void> {
  const res = await fetch(`${ALERTS_BASE}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...contextHeaders(context) },
    body: JSON.stringify({ walletAddress }),
  });
  if (!res.ok && res.status !== 204) throw new Error("Failed to delete alert");
  assertContext(res, context);
}

/** Alert preferences with the server's optimistic-concurrency version (#1903). */
export interface VersionedAlertPreferences {
  preferences: AlertPreferences;
  /** 0 when the wallet+vault has no preferences yet. */
  version: number;
}

/**
 * Another write committed after `expectedVersion` was read. Carries the
 * server's current record so the caller can show it or reapply its change.
 */
export class AlertPreferencesConflictError extends Error {
  readonly code = "PREFERENCE_VERSION_CONFLICT";
  constructor(
    message: string,
    readonly currentVersion: number,
    readonly currentPreferences: AlertPreferences | null,
  ) {
    super(message);
    this.name = "AlertPreferencesConflictError";
  }
}

/** Reads the version from `X-Preferences-Version`, falling back to `EDag`. */
function readVersion(res: Response): number {
  const raw =
    res.headers.get("X-Preferences-Version") ??
    res.headers.get("ETag")?.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  const version = Number(raw);
  return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

export async function fetchAlertPreferencesVersioned(
  walletAddress: string,
  vaultId: string,
  context?: AlertContext,
): Promise<VersionedAlertPreferences | null> {
  const res = await fetch(
    `${ALERTS_BASE}/preferences/${encodeURIComponent(walletAddress)}/${encodeURIComponent(vaultId)}`,
    { headers: contextHeaders(context) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to fetch alert preferences");
  assertContext(res, context);
  const preferences = (await res.json()) as AlertPreferences;
  return { preferences, version: readVersion(res) };
}

export async function fetchAlertPreferences(
  walletAddress: string,
  vaultId: string,
  context?: AlertContext,
): Promise<AlertPreferences | null> {
  const versioned = await fetchAlertPreferencesVersioned(walletAddress, vaultId, context);
  return versioned ? versioned.preferences : null;
}

/**
 * Saves preferences. With `expectedVersion` the write only commits if nobody
 * else saved since that version was read; otherwise it throws
 * `AlertPreferencesConflictError` and the server keeps its record unchanged.
 */
export async function saveAlertPreferencesVersioned(
  walletAddress: string,
  vaultId: string,
  preferences: AlertPreferences,
  options: { operationIdentity?: string; expectedVersion?: number; context?: AlertContext } = {},
): Promise<VersionedAlertPreferences> {
  const { operationIdentity, expectedVersion, context } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...contextHeaders(context),
  };
  if (operationIdentity) {
    headers["X-Operation-Identity"] = operationIdentity;
    headers["Idempotency-Key"] = operationIdentity;
  }
  if (expectedVersion !== undefined) headers["If-Match"] = `"${expectedVersion}"`;
  const res = await fetch(`${ALERTS_BASE}/preferences`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      walletAddress,
      vaultId,
      preferences,
      operationIdentity,
    }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      currentVersion?: number;
      preferences?: AlertPreferences | null;
    };
    if (body.code === "PREFERENCE_VERSION_CONFLICT") {
      throw new AlertPreferencesConflictError(
        body.error ?? "Alert preferences changed elsewhere. Reload and try again.",
        typeof body.currentVersion === "number" ? body.currentVersion : readVersion(res),
        body.preferences ?? null,
      );
    }
    throw new Error(body.error ?? "Failed to save alert preferences");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to save alert preferences");
  }
  assertContext(res, context);
  const saved = (await res.json()) as AlertPreferences;
  return { preferences: saved, version: readVersion(res) };
}

export async function saveAlertPreferences(
  walletAddress: string,
  vaultId: string,
  preferences: AlertPreferences,
  operationIdentity?: string,
  expectedVersion?: number,
  context?: AlertContext,
): Promise<AlertPreferences> {
  const saved = await saveAlertPreferencesVersioned(walletAddress, vaultId, preferences, {
    operationIdentity,
    expectedVersion,
    context,
  });
  return saved.preferences;
}

/**
 * Read-modify-write under optimistic concurrency: reads the current record,
 * applies `change`, saves with that version, and on a conflict re-applies
 * `change` to the server's newer record, up to `maxAttempts` times. Each
 * attempt uses a fresh operation identity, since its body differs. Other
 * errors are thrown at once; the server record is untouched by any failure.
 */
export async function updateAlertPreferencesSafely(
  walletAddress: string,
  vaultId: string,
  change: (current: AlertPreferences | null) => AlertPreferences,
  maxAttempts = 3,
  context?: AlertContext,
): Promise<VersionedAlertPreferences> {
  const current = await fetchAlertPreferencesVersioned(walletAddress, vaultId, context);
  let base: AlertPreferences | null = current?.preferences ?? null;
  let version = current?.version ?? 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await saveAlertPreferencesVersioned(walletAddress, vaultId, change(base), {
        expectedVersion: version,
        operationIdentity: `op-prefs-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        context,
      });
    } catch (error) {
      if (!(error instanceof AlertPreferencesConflictError) || attempt >= maxAttempts) throw error;
      base = error.currentPreferences;
      version = error.currentVersion;
    }
  }
}

export async function fetchDigestPreference(
  walletAddress: string,
  context?: AlertContext,
): Promise<WatchlistDigestPreference> {
  const res = await fetch(
    `${NOTIFICATIONS_BASE}/digest/preferences/${encodeURIComponent(walletAddress)}`,
    { headers: contextHeaders(context) },
  );
  if (!res.ok) throw new Error("Failed to fetch digest preferences");
  assertContext(res, context);
  return res.json() as Promise<WatchlistDigestPreference>;
}

export async function saveDigestPreference(
  walletAddress: string,
  payload: WatchlistDigestPreference,
  operationIdentity?: string,
  context?: AlertContext,
): Promise<WatchlistDigestPreference> {
  const opId = operationIdentity ?? payload.operationIdentity;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...contextHeaders(context),
  };
  if (opId) {
    headers["X-Operation-Identity"] = opId;
    headers["Idempotency-Key"] = opId;
  }
  const bodyPayload = opId ? { ...payload, operationIdentity: opId } : payload;
  const res = await fetch(
    `${NOTIFICATIONS_BASE}/digest/preferences/${encodeURIComponent(walletAddress)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(bodyPayload),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to save digest preferences");
  }
  assertContext(res, context);
  return res.json() as Promise<WatchlistDigestPreference>;
}
