import { apiUrl } from "../../lib/api";
import { getNetworkPassphrase } from "../../lib/networkEnv";
import type {
  AlertPreferenceContext,
  AlertPreferences,
  CreateAlertPayload,
  UserAlert,
  WatchlistDigestPreference,
} from "./types";

const ALERTS_BASE = apiUrl("/api/alerts");
const NOTIFICATIONS_BASE = apiUrl("/api/notifications");

/** Must match `ALERT_PREFERENCE_SCHEMA_VERSION` on the server. */
export const ALERT_PREFERENCE_SCHEMA_VERSION = 1;

export type AlertClassPreference = Record<string, boolean>;

/** Network/ledger binding returned by the server (hashed network id). */
export interface ServerAlertPreferenceContext {
  networkId: string;
  vaultId: string;
  schemaVersion: number;
}

/** Build the explicit context for the network this client is configured for. */
export function buildAlertPreferenceContext(
  vaultId: string,
): AlertPreferenceContext {
  return {
    networkPassphrase: getNetworkPassphrase(),
    vaultId: vaultId.toLowerCase(),
    schemaVersion: ALERT_PREFERENCE_SCHEMA_VERSION,
  };
}

function contextHeaders(context: AlertPreferenceContext): Record<string, string> {
  return {
    "X-Alert-Network-Passphrase": context.networkPassphrase,
    "X-Alert-Schema-Version": String(context.schemaVersion),
    "X-Alert-Context-Vault": context.vaultId,
  };
}

function readServerContext(res: Response): ServerAlertPreferenceContext | null {
  const networkId = res.headers.get("X-Alert-Network-Id");
  const schemaVersion = Number(res.headers.get("X-Alert-Schema-Version"));
  const vaultId = res.headers.get("X-Alert-Context-Vault");
  if (!networkId || !Number.isSafeInteger(schemaVersion) || !vaultId) return null;
  return { networkId, vaultId, schemaVersion };
}

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

export async function fetchAlerts(walletAddress: string): Promise<UserAlert[]> {
  const res = await fetch(`${ALERTS_BASE}/${encodeURIComponent(walletAddress)}`);
  if (!res.ok) throw new Error("Failed to fetch alerts");
  return res.json() as Promise<UserAlert[]>;
}

export async function createAlert(payload: CreateAlertPayload): Promise<UserAlert> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (payload.operationIdentity) {
    headers["X-Operation-Identity"] = payload.operationIdentity;
    headers["Idempotency-Key"] = payload.operationIdentity;
  }
  const context = payload.context ?? buildAlertPreferenceContext(payload.vaultId);
  Object.assign(headers, contextHeaders(context));
  const res = await fetch(ALERTS_BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, context }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to create alert");
  }
  return res.json() as Promise<UserAlert>;
}

export async function deleteAlert(id: string, walletAddress: string): Promise<void> {
  const res = await fetch(`${ALERTS_BASE}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress }),
  });
  if (!res.ok && res.status !== 204) throw new Error("Failed to delete alert");
}

/** Alert preferences with the server's optimistic-concurrency version (#1903). */
export interface VersionedAlertPreferences {
  preferences: AlertPreferences;
  /** 0 when the wallet+vault has no preferences yet. */
  version: number;
  /** Immutable hash of the exact preference snapshot read from the server. */
  configurationFingerprint: string | null;
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
    readonly currentFingerprint: string | null = null,
  ) {
    super(message);
    this.name = "AlertPreferencesConflictError";
  }
}

export class AlertPreferencesFingerprintConflictError extends Error {
  readonly code = "PREFERENCE_FINGERPRINT_CONFLICT";
  constructor(
    message: string,
    readonly currentFingerprint: string | null,
    readonly currentVersion: number,
    readonly currentPreferences: AlertPreferences | null,
  ) {
    super(message);
    this.name = "AlertPreferencesFingerprintConflictError";
  }
}

/** The record belongs to another network/ledger context; no retry without a rebind. */
export class AlertPreferencesContextConflictError extends Error {
  readonly code = "PREFERENCE_CONTEXT_CONFLICT";
  constructor(
    message: string,
    readonly reason: string | undefined,
    readonly currentContext: ServerAlertPreferenceContext | null,
  ) {
    super(message);
    this.name = "AlertPreferencesContextConflictError";
  }
}

/** Reads the version from `X-Preferences-Version`, falling back to `ETag`. */
function readVersion(res: Response): number {
  const raw =
    res.headers.get("X-Preferences-Version") ??
    res.headers.get("ETag")?.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  const version = Number(raw);
  return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

async function throwPreferenceError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    reason?: string;
    currentVersion?: number;
    preferences?: AlertPreferences | null;
    currentContext?: ServerAlertPreferenceContext;
    currentFingerprint?: string | null;
  };
  if (body.code === "PREFERENCE_CONTEXT_CONFLICT") {
    throw new AlertPreferencesContextConflictError(
      body.error ?? "Alert preferences belong to a different network or ledger. Reload and retry.",
      body.reason,
      body.currentContext ?? readServerContext(res),
    );
  }
  if (body.code === "PREFERENCE_VERSION_CONFLICT") {
    throw new AlertPreferencesConflictError(
      body.error ?? "Alert preferences changed elsewhere. Reload and try again.",
      typeof body.currentVersion === "number" ? body.currentVersion : readVersion(res),
      body.preferences ?? null,
      body.currentFingerprint ?? res.headers.get("X-Preferences-Fingerprint"),
    );
  }
  if (body.code === "PREFERENCE_FINGERPRINT_CONFLICT") {
    throw new AlertPreferencesFingerprintConflictError(
      body.error ?? "Alert preferences changed elsewhere. Refresh and try again.",
      body.currentFingerprint ?? res.headers.get("X-Preferences-Fingerprint"),
      typeof body.currentVersion === "number" ? body.currentVersion : readVersion(res),
      body.preferences ?? null,
    );
  }
  throw new Error(body.error ?? "Failed to save alert preferences");
}

export async function fetchAlertPreferencesVersioned(
  walletAddress: string,
  vaultId: string,
  options: { context?: AlertPreferenceContext } = {},
): Promise<VersionedAlertPreferences | null> {
  const context = options.context ?? buildAlertPreferenceContext(vaultId);
  const res = await fetch(
    `${ALERTS_BASE}/preferences/${encodeURIComponent(walletAddress)}/${encodeURIComponent(vaultId)}`,
    { headers: contextHeaders(context) },
  );
  if (res.status === 404) return null;
  if (res.status === 409) await throwPreferenceError(res);
  if (!res.ok) throw new Error("Failed to fetch alert preferences");
  const preferences = (await res.json()) as AlertPreferences;
  return {
    preferences,
    version: readVersion(res),
    configurationFingerprint: res.headers.get("X-Preferences-Fingerprint"),
  };
}

export async function fetchAlertPreferences(
  walletAddress: string,
  vaultId: string,
  options: { context?: AlertPreferenceContext } = {},
): Promise<AlertPreferences | null> {
  const versioned = await fetchAlertPreferencesVersioned(walletAddress, vaultId, options);
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
  options: {
    operationIdentity?: string;
    expectedVersion?: number;
    expectedFingerprint?: string | null;
    context?: AlertPreferenceContext;
  } = {},
): Promise<VersionedAlertPreferences> {
  const { operationIdentity, expectedVersion, expectedFingerprint } = options;
  const context = options.context ?? buildAlertPreferenceContext(vaultId);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...contextHeaders(context),
  };
  if (operationIdentity) {
    headers["X-Operation-Identity"] = operationIdentity;
    headers["Idempotency-Key"] = operationIdentity;
  }
  if (expectedVersion !== undefined) headers["If-Match"] = `"${expectedVersion}"`;
  if (expectedFingerprint) headers["If-Preferences-Fingerprint"] = expectedFingerprint;
  const res = await fetch(`${ALERTS_BASE}/preferences`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      walletAddress,
      vaultId,
      preferences,
      operationIdentity,
      context,
      configurationFingerprint: expectedFingerprint,
    }),
  });
  if (res.status === 409) await throwPreferenceError(res);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to save alert preferences");
  }
  const saved = (await res.json()) as AlertPreferences;
  return {
    preferences: saved,
    version: readVersion(res),
    configurationFingerprint: res.headers.get("X-Preferences-Fingerprint"),
  };
}

export async function saveAlertPreferences(
  walletAddress: string,
  vaultId: string,
  preferences: AlertPreferences,
  operationIdentity?: string,
  expectedVersion?: number,
  context?: AlertPreferenceContext,
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
  options: { context?: AlertPreferenceContext } = {},
): Promise<VersionedAlertPreferences> {
  const context = options.context ?? buildAlertPreferenceContext(vaultId);
  const current = await fetchAlertPreferencesVersioned(walletAddress, vaultId, { context });
  let base: AlertPreferences | null = current?.preferences ?? null;
  let version = current?.version ?? 0;
  let configurationFingerprint = current?.configurationFingerprint ?? null;
  for (let attempt = 1; ; attempt++) {
    try {
      return await saveAlertPreferencesVersioned(walletAddress, vaultId, change(base), {
        expectedVersion: version,
        expectedFingerprint: configurationFingerprint,
        context,
        operationIdentity: `op-prefs-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      });
    } catch (error) {
      if (error instanceof AlertPreferencesConflictError) {
        base = error.currentPreferences;
        version = error.currentVersion;
        configurationFingerprint = error.currentFingerprint;
      } else if (error instanceof AlertPreferencesFingerprintConflictError) {
        base = error.currentPreferences;
        version = error.currentVersion;
        configurationFingerprint = error.currentFingerprint;
      } else {
        throw error;
      }
      if (attempt >= maxAttempts) throw error;
    }
  }
}

export interface AlertPreferenceRebindResult {
  preferences: AlertPreferences;
  version: number;
  context: ServerAlertPreferenceContext;
  replayed: boolean;
}

/**
 * Explicitly move a record to this server's network/schema context after a
 * transition. `expectedContext` must be the binding being replaced, so a
 * stale client cannot silently adopt another network's preferences.
 */
export async function rebindAlertPreferenceContext(
  walletAddress: string,
  vaultId: string,
  expectedContext: AlertPreferenceContext,
  expectedVersion?: number,
): Promise<AlertPreferenceRebindResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...contextHeaders(expectedContext),
  };
  const res = await fetch(
    `${ALERTS_BASE}/${encodeURIComponent(walletAddress)}/preferences/${encodeURIComponent(vaultId)}/rebind`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ context: expectedContext, expectedVersion }),
    },
  );
  if (res.status === 409) await throwPreferenceError(res);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to rebind alert preferences");
  }
  return (await res.json()) as AlertPreferenceRebindResult;
}

export async function fetchDigestPreference(
  walletAddress: string,
): Promise<WatchlistDigestPreference> {
  const res = await fetch(
    `${NOTIFICATIONS_BASE}/digest/preferences/${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) throw new Error("Failed to fetch digest preferences");
  return res.json() as Promise<WatchlistDigestPreference>;
}

export async function saveDigestPreference(
  walletAddress: string,
  payload: WatchlistDigestPreference,
  operationIdentity?: string,
): Promise<WatchlistDigestPreference> {
  const opId = operationIdentity ?? payload.operationIdentity;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
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
  return res.json() as Promise<WatchlistDigestPreference>;
}

export async function fetchNotificationPreferences(
  walletAddress: string,
): Promise<NotificationPreferences> {
  const res = await fetch(
    `${NOTIFICATIONS_BASE}/preferences/${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) throw new Error("Failed to fetch notification preferences");
  return res.json() as Promise<NotificationPreferences>;
}

export async function saveNotificationPreferences(
  walletAddress: string,
  payload: NotificationPreferences,
): Promise<NotificationPreferences> {
  const res = await fetch(
    `${NOTIFICATIONS_BASE}/preferences/${encodeURIComponent(walletAddress)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to save notification preferences");
  }
  return res.json() as Promise<NotificationPreferences>;
}
