/**
 * Alert preference ledger context (Issue #1908).
 *
 * A preference record belongs to one Stellar network and one preference
 * schema/ledger layout. Reads and writes carry that context explicitly so a
 * network switch, a vault redeployment, or a schema migration can never
 * silently read or overwrite another ledger's preferences.
 *
 * The context is the off-chain counterpart of the isolated lending
 * `LedgerContext`: network id (SHA-256 of the passphrase), binding id (vault)
 * and storage version.
 */

import type { Request } from "express";
import { computeChecksum } from "../utils/checksum";

export const ALERT_PREFERENCE_SCHEMA_VERSION = 1;

export const PREFERENCE_CONTEXT_CONFLICT = "PREFERENCE_CONTEXT_CONFLICT";
export const INVALID_ALERT_CONTEXT = "INVALID_ALERT_CONTEXT";

const DEFAULT_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

export interface AlertPreferenceContext {
  /** SHA-256 hex of the network passphrase the record is bound to. */
  networkId: string;
  /** Vault deployment the record is bound to (case-insensitive). */
  vaultId: string;
  /** Preference record layout version. */
  schemaVersion: number;
}

/** Caller-supplied context. Either a network id or the raw passphrase is enough. */
export interface AlertContextInput {
  networkId?: string;
  networkPassphrase?: string;
  vaultId?: string;
  schemaVersion?: number | string;
}

export type ContextConflictReason =
  | "WRONG_NETWORK"
  | "WRONG_VERSION"
  | "STORED_CONTEXT_MISMATCH";

export class InvalidAlertContextError extends Error {
  readonly code = INVALID_ALERT_CONTEXT;

  constructor(message: string) {
    super(message);
    this.name = "InvalidAlertContextError";
  }
}

/** Thrown before any state changes when a request names the wrong context. */
export class AlertPreferenceContextConflictError extends Error {
  readonly code = PREFERENCE_CONTEXT_CONFLICT;

  constructor(
    readonly reason: ContextConflictReason,
    readonly expectedContext: AlertPreferenceContext | null,
    readonly currentContext: AlertPreferenceContext,
  ) {
    super(
      `Alert preferences are bound to a different network/ledger context (${reason}). Reload the context and retry.`,
    );
    this.name = "AlertPreferenceContextConflictError";
  }
}

/** Reads the same passphrase the rest of the server uses for Soroban calls. */
export function getServerNetworkId(): string {
  const passphrase =
    process.env.NETWORK_PASSPHRASE ??
    process.env.STELLAR_NETWORK_PASSPHRASE ??
    DEFAULT_NETWORK_PASSPHRASE;
  return computeChecksum(passphrase);
}

export function getServerAlertContext(vaultId: string): AlertPreferenceContext {
  return {
    networkId: getServerNetworkId(),
    vaultId: vaultId.toLowerCase(),
    schemaVersion: ALERT_PREFERENCE_SCHEMA_VERSION,
  };
}

const NETWORK_ID_PATTERN = /^[0-9a-f]{64}$/i;

function isNetworkId(value: unknown): value is string {
  return typeof value === "string" && NETWORK_ID_PATTERN.test(value);
}

/** Normalizes caller input, rejecting anything that cannot identify a ledger. */
export function parseAlertContext(
  raw: AlertContextInput | null | undefined,
  vaultId: string,
): AlertPreferenceContext | undefined {
  if (raw === undefined || raw === null) return undefined;

  const networkId =
    raw.networkId ??
    (raw.networkPassphrase ? computeChecksum(raw.networkPassphrase) : undefined);
  const schemaVersion =
    raw.schemaVersion === undefined
      ? ALERT_PREFERENCE_SCHEMA_VERSION
      : Number(raw.schemaVersion);
  const boundVaultId = raw.vaultId ?? vaultId;

  if (!isNetworkId(networkId)) {
    throw new InvalidAlertContextError(
      "context.networkId must be a 64-character SHA-256 hex string, or context.networkPassphrase must be provided",
    );
  }
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new InvalidAlertContextError(
      "context.schemaVersion must be a positive integer",
    );
  }
  if (String(boundVaultId).toLowerCase() !== vaultId.toLowerCase()) {
    throw new InvalidAlertContextError(
      "context.vaultId does not match the vault being read or written",
    );
  }

  return {
    networkId: networkId.toLowerCase(),
    vaultId: vaultId.toLowerCase(),
    schemaVersion,
  };
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim() !== "") {
    return value[0].trim();
  }
  return undefined;
}

/** Reads the context from headers or body; `undefined` keeps legacy callers working. */
export function readAlertContext(
  req: Request,
  vaultId: string,
): AlertPreferenceContext | undefined {
  const body = (req.body as { context?: AlertContextInput } | undefined)?.context;
  const query = req.query as {
    networkId?: string;
    networkPassphrase?: string;
    schemaVersion?: string;
  };
  const networkPassphrase = header(req, "x-alert-network-passphrase");

  if (
    !header(req, "x-alert-network-id") &&
    !networkPassphrase &&
    !header(req, "x-alert-schema-version") &&
    !body &&
    !query.networkId &&
    !query.networkPassphrase &&
    !query.schemaVersion
  ) {
    return undefined;
  }

  return parseAlertContext(
    {
      networkId:
        header(req, "x-alert-network-id") ?? body?.networkId ?? query.networkId,
      networkPassphrase: networkPassphrase ?? body?.networkPassphrase ?? query.networkPassphrase,
      vaultId: body?.vaultId,
      schemaVersion:
        header(req, "x-alert-schema-version") ??
        body?.schemaVersion ??
        query.schemaVersion,
    },
    vaultId,
  );
}

export function contextEquals(
  a: AlertPreferenceContext,
  b: AlertPreferenceContext,
): boolean {
  return (
    a.networkId.toLowerCase() === b.networkId.toLowerCase() &&
    a.vaultId.toLowerCase() === b.vaultId.toLowerCase() &&
    a.schemaVersion === b.schemaVersion
  );
}

/** Rejects a context that does not belong to the network this server serves. */
export function assertServerContext(context: AlertPreferenceContext): void {
  const server = getServerAlertContext(context.vaultId);
  if (context.networkId !== server.networkId) {
    throw new AlertPreferenceContextConflictError("WRONG_NETWORK", context, server);
  }
  if (context.schemaVersion !== server.schemaVersion) {
    throw new AlertPreferenceContextConflictError("WRONG_VERSION", context, server);
  }
}

/**
 * Returns the context a write must stamp on the record. An explicit context
 * must match both this server and an existing stored binding; a caller that
 * omits one inherits the stored binding (legacy) or the server default.
 */
export function resolveContextForWrite(
  stored: AlertPreferenceContext | undefined,
  requested: AlertPreferenceContext | undefined,
  vaultId: string,
): AlertPreferenceContext {
  if (requested) assertServerContext(requested);
  if (stored) {
    assertServerContext(stored);
    if (requested && !contextEquals(stored, requested)) {
      throw new AlertPreferenceContextConflictError(
        "STORED_CONTEXT_MISMATCH",
        requested,
        stored,
      );
    }
    return stored;
  }
  return requested ?? getServerAlertContext(vaultId);
}

/** Same rules for reads, returning the context that describes the response. */
export function resolveContextForRead(
  stored: AlertPreferenceContext | undefined,
  requested: AlertPreferenceContext | undefined,
  vaultId: string,
): AlertPreferenceContext {
  const current = stored ?? getServerAlertContext(vaultId);
  assertServerContext(current);
  if (requested) {
    assertServerContext(requested);
    if (!contextEquals(current, requested)) {
      throw new AlertPreferenceContextConflictError(
        "STORED_CONTEXT_MISMATCH",
        requested,
        current,
      );
    }
  }
  return current;
}
