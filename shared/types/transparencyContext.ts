/**
 * Network, ledger and version binding for transparency status (#1916).
 *
 * Every transparency snapshot carries the context it was read in: the Stellar
 * network, the ledger it reflects and the payload schema version. Readers say
 * what they expect, and writers say which network they mean, so that
 *
 * - a snapshot from another network is never shown or cached as this one's
 *   (for example after the server or a data source is repointed),
 * - a snapshot from an older ledger never replaces a newer one (for example
 *   when a request lands on an RPC node that is behind), and
 * - a client that cannot read the payload schema is told so instead of
 *   rendering it.
 *
 * Pure and dependency-free so the server and the client share one definition.
 */

/** Schema version of the transparency status payloads. */
export const TRANSPARENCY_SCHEMA_VERSION = "1";

export type TransparencyNetwork = "mainnet" | "testnet" | "futurenet" | "local";

export const TRANSPARENCY_NETWORKS: readonly TransparencyNetwork[] = [
  "mainnet",
  "testnet",
  "futurenet",
  "local",
];

export const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export interface TransparencyContext {
  network: TransparencyNetwork;
  /** Ledger sequence the snapshot reflects. */
  ledger: number;
  /** Payload schema version. */
  version: string;
}

/** What a reader or writer expects; omitted fields are not checked. */
export interface TransparencyContextExpectation {
  network?: TransparencyNetwork;
  version?: string;
  /** Lowest ledger the caller will accept (the last ledger it has shown). */
  minLedger?: number;
}

export type TransparencyContextErrorCode =
  | "INVALID_TRANSPARENCY_CONTEXT"
  | "TRANSPARENCY_NETWORK_MISMATCH"
  | "TRANSPARENCY_VERSION_MISMATCH"
  | "TRANSPARENCY_LEDGER_BEHIND"
  | "TRANSPARENCY_LEDGER_REGRESSION";

export class TransparencyContextError extends Error {
  readonly code: TransparencyContextErrorCode;
  /** True when the same request may succeed later without any change. */
  readonly retryable: boolean;

  constructor(code: TransparencyContextErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "TransparencyContextError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Normalize a network passphrase or label to a transparency network.
 *
 * Accepts the official passphrases and the labels `mainnet`/`public`,
 * `testnet`, `futurenet` and `local`/`standalone`, case-insensitively.
 * Returns `null` for anything else, so an unrecognized value is rejected
 * rather than guessed.
 */
export function normalizeTransparencyNetwork(raw: unknown): TransparencyNetwork | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  if (value === "mainnet" || value === "public" || value === "pubnet" || value.includes("public global")) {
    return "mainnet";
  }
  if (value === "futurenet" || value.includes("future")) return "futurenet";
  if (value === "testnet" || value.includes("test sdf")) return "testnet";
  if (value === "local" || value === "standalone" || value.includes("standalone")) return "local";
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A ledger sequence: a non-negative safe integer. */
export function isValidLedgerSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate an untrusted context object. Throws INVALID_TRANSPARENCY_CONTEXT. */
export function parseTransparencyContext(raw: unknown): TransparencyContext {
  if (!isPlainRecord(raw)) {
    throw new TransparencyContextError(
      "INVALID_TRANSPARENCY_CONTEXT",
      "Transparency context must be an object with network, ledger and version.",
    );
  }
  const network = normalizeTransparencyNetwork(raw.network);
  if (!network) {
    throw new TransparencyContextError(
      "INVALID_TRANSPARENCY_CONTEXT",
      "Transparency context network is missing or not a known Stellar network.",
    );
  }
  if (!isValidLedgerSequence(raw.ledger)) {
    throw new TransparencyContextError(
      "INVALID_TRANSPARENCY_CONTEXT",
      "Transparency context ledger must be a non-negative integer.",
    );
  }
  if (typeof raw.version !== "string" || raw.version.trim() === "") {
    throw new TransparencyContextError(
      "INVALID_TRANSPARENCY_CONTEXT",
      "Transparency context version must be a non-empty string.",
    );
  }
  return { network, ledger: raw.ledger, version: raw.version.trim() };
}

/**
 * Check a snapshot's context against what the caller expects. Network and
 * version mismatches are final; a ledger behind `minLedger` is retryable
 * because the source may catch up.
 */
export function checkTransparencyContext(
  actual: TransparencyContext,
  expected: TransparencyContextExpectation,
): { ok: true } | { ok: false; error: TransparencyContextError } {
  if (expected.network !== undefined && actual.network !== expected.network) {
    return {
      ok: false,
      error: new TransparencyContextError(
        "TRANSPARENCY_NETWORK_MISMATCH",
        `Transparency status is for ${actual.network}, but ${expected.network} was expected.`,
      ),
    };
  }
  if (expected.version !== undefined && actual.version !== expected.version) {
    return {
      ok: false,
      error: new TransparencyContextError(
        "TRANSPARENCY_VERSION_MISMATCH",
        `Transparency status uses schema version ${actual.version}, but ${expected.version} was expected. Reload to get a compatible client.`,
      ),
    };
  }
  if (expected.minLedger !== undefined && actual.ledger < expected.minLedger) {
    return {
      ok: false,
      error: new TransparencyContextError(
        "TRANSPARENCY_LEDGER_BEHIND",
        `Transparency status is at ledger ${actual.ledger}, behind ledger ${expected.minLedger} already shown. Try again shortly.`,
        true,
      ),
    };
  }
  return { ok: true };
}

export type SnapshotDecision =
  | { action: "accept" }
  | { action: "keep-current"; error: TransparencyContextError };

/**
 * Decide whether an incoming snapshot may replace the one already held.
 *
 * - Nothing held: accept if it matches the expected network and version.
 * - Different network or version from what is held or expected: keep the
 *   current snapshot. Switching networks is an explicit reset by the caller,
 *   never a side effect of a response.
 * - Older ledger on the same network: keep the current snapshot.
 * - Same or newer ledger: accept.
 */
export function decideTransparencySnapshot(
  current: TransparencyContext | null,
  incoming: TransparencyContext,
  expected: Pick<TransparencyContextExpectation, "network" | "version"> = {},
): SnapshotDecision {
  const network = expected.network ?? current?.network;
  const version = expected.version ?? current?.version;
  const check = checkTransparencyContext(incoming, { network, version });
  if (!check.ok) return { action: "keep-current", error: check.error };
  if (current && current.network === incoming.network && incoming.ledger < current.ledger) {
    return {
      action: "keep-current",
      error: new TransparencyContextError(
        "TRANSPARENCY_LEDGER_REGRESSION",
        `Ignored transparency status from ledger ${incoming.ledger}; ledger ${current.ledger} is already shown.`,
        true,
      ),
    };
  }
  return { action: "accept" };
}

/**
 * Parse a caller's expectation from query/header strings. Throws
 * INVALID_TRANSPARENCY_CONTEXT for a value that is present but malformed.
 */
export function parseTransparencyExpectation(raw: {
  network?: unknown;
  version?: unknown;
  minLedger?: unknown;
}): TransparencyContextExpectation {
  const expectation: TransparencyContextExpectation = {};
  const present = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");

  if (present(raw.network)) {
    const network = normalizeTransparencyNetwork(raw.network);
    if (!network) {
      throw new TransparencyContextError(
        "INVALID_TRANSPARENCY_CONTEXT",
        `network must be one of ${TRANSPARENCY_NETWORKS.join(", ")} or a Stellar network passphrase.`,
      );
    }
    expectation.network = network;
  }
  if (present(raw.version)) {
    if (typeof raw.version !== "string") {
      throw new TransparencyContextError("INVALID_TRANSPARENCY_CONTEXT", "version must be a string.");
    }
    expectation.version = raw.version.trim();
  }
  if (present(raw.minLedger)) {
    const value =
      typeof raw.minLedger === "number"
        ? raw.minLedger
        : typeof raw.minLedger === "string" && /^\d+$/.test(raw.minLedger.trim())
          ? Number(raw.minLedger.trim())
          : NaN;
    if (!isValidLedgerSequence(value)) {
      throw new TransparencyContextError(
        "INVALID_TRANSPARENCY_CONTEXT",
        "minLedger must be a non-negative integer ledger sequence.",
      );
    }
    expectation.minLedger = value;
  }
  return expectation;
}
