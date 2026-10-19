/**
 * Contract event version compatibility layer (#1307).
 *
 * Soroban vault events are published unversioned today
 * (`env.events().publish((symbol_short!("deposit"),), ...)`) while
 * `contracts/yield_vault/src/events.rs` defines the intended versioned
 * envelope `(topic, version)`. This module is the single server-side
 * authority that bridges both shapes into one normalized form so the
 * indexer can ingest v1 events now and route future versions
 * deterministically instead of parsing raw provider messages.
 *
 * Envelope shapes accepted:
 * - legacy unversioned: `["deposit"]`            → version 1 (recognized)
 * - versioned tuple:    `["deposit", "1"]`       → version 1 (recognized)
 * - suffixed topic:     `["deposit_v2"]`         → version 2 (unknown → dead-letter)
 *
 * Error contract (typed codes, never raw provider text):
 * - `UNKNOWN_EVENT_TYPE`        — topic is not a known vault event
 * - `UNSUPPORTED_EVENT_VERSION` — known topic but version > supported
 * - `INVALID_EVENT_ENVELOPE`    — empty envelope / bad version literal
 */

/** Current decoder schema version. Mirrors `VAULT_EVENT_SCHEMA_VERSION`. */
export const EVENT_SCHEMA_VERSION = 1;

/** Canonical v1 vault event topics (see `contracts/yield_vault/src/lib.rs`). */
export const KNOWN_VAULT_EVENT_TYPES = [
  "init",
  "deposit",
  "dep_for",
  "withdraw",
  "withdrawal",
  "rebal",
  "tr_sh",
  "strat_cfg",
  "harvest",
  "rescue",
  "kpr_add",
  "pause",
  "unpause",
  "don_set",
  "referral",
  "flash",
  // Zap + settlement companions (same indexer pipeline).
  "zap_init",
  "zap_dep",
  "zap_part",
  "zap_ref",
  "set_eng",
  "set_fee",
  // Legacy generic topics previously accepted by the indexer.
  "mint",
  "burn",
  "transfer",
  "liquidation",
  "repay",
  "borrow",
] as const;

export type VaultEventType = (typeof KNOWN_VAULT_EVENT_TYPES)[number];

/** Aliases that normalize to one canonical type. */
const EVENT_TYPE_ALIASES: Record<string, string> = {
  withdrawal: "withdraw",
  dep_for: "deposit_for",
  tr_sh: "transfer_shares",
  rebal: "rebalance",
  strat_cfg: "strategy_config",
  don_set: "donation_set",
  kpr_add: "keeper_add",
  zap_dep: "zap_deposit",
  zap_part: "zap_partial",
  zap_ref: "zap_refund",
  zap_init: "zap_init",
  set_eng: "set_engine",
  set_fee: "set_fee",
};

export type EventDecodeStatus = "Recognized" | "Unknown" | "Invalid";

export type EventCompatErrorCode =
  | "UNKNOWN_EVENT_TYPE"
  | "UNSUPPORTED_EVENT_VERSION"
  | "INVALID_EVENT_ENVELOPE";

export interface NormalizedContractEvent {
  /** Canonical event type (aliases resolved). */
  eventType: string;
  /** Raw topic as emitted on-chain. */
  rawType: string;
  /** Schema version (legacy envelopes default to 1). */
  schemaVersion: number;
  status: EventDecodeStatus;
}

export class EventCompatError extends Error {
  readonly code: EventCompatErrorCode;
  constructor(code: EventCompatErrorCode, message: string) {
    super(message);
    this.name = "EventCompatError";
    this.code = code;
  }
}

/** Resolve an alias to its canonical type; unknown inputs pass through. */
export function normalizeEventType(raw: string): string {
  const key = raw.trim().toLowerCase();
  return EVENT_TYPE_ALIASES[key] ?? key;
}

/** True when the topic names a known event (after alias/canonicalization). */
export function isKnownEventType(raw: string): boolean {
  const key = raw.trim().toLowerCase();
  if (!key) return false;
  if ((KNOWN_VAULT_EVENT_TYPES as readonly string[]).includes(key)) return true;
  return Object.values(EVENT_TYPE_ALIASES).includes(normalizeEventType(raw));
}

/**
 * Version gate for a known event type.
 * v1 (or unversioned legacy) → Recognized; future → Unknown; bad → Invalid.
 */
export function checkEventVersion(
  eventType: string,
  version: number,
): EventDecodeStatus {
  if (!isKnownEventType(eventType)) return "Invalid";
  if (!Number.isInteger(version) || version < 1) return "Invalid";
  if (version === EVENT_SCHEMA_VERSION) return "Recognized";
  if (version > EVENT_SCHEMA_VERSION) return "Unknown";
  return "Invalid";
}

function parseVersionLiteral(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase().replace(/^v/, "");
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Normalize one event envelope into its canonical (type, version) form.
 * Throws a typed `EventCompatError` for invalid or unsupported envelopes —
 * callers should dead-letter on `UNKNOWN_*` and reject on `INVALID_*`.
 */
export function normalizeContractEvent(
  topics: string[],
): NormalizedContractEvent {
  if (!Array.isArray(topics) || topics.length === 0) {
    throw new EventCompatError(
      "INVALID_EVENT_ENVELOPE",
      "Event envelope must contain at least one topic.",
    );
  }

  const head = String(topics[0] ?? "").trim();
  if (!head) {
    throw new EventCompatError(
      "INVALID_EVENT_ENVELOPE",
      "Event envelope has an empty leading topic.",
    );
  }

  // `deposit_v2` suffixed form.
  const suffixMatch = head.match(/^(.*)_v(\d+)$/i);
  if (suffixMatch) {
    const rawType = suffixMatch[1];
    const version = Number(suffixMatch[2]);
    if (!isKnownEventType(rawType)) {
      throw new EventCompatError(
        "UNKNOWN_EVENT_TYPE",
        `Unknown contract event type: ${rawType}.`,
      );
    }
    const status = checkEventVersion(rawType, version);
    if (status === "Unknown") {
      throw new EventCompatError(
        "UNSUPPORTED_EVENT_VERSION",
        `Event ${normalizeEventType(rawType)} version ${version} is not supported (decoder v${EVENT_SCHEMA_VERSION}).`,
      );
    }
    if (status === "Invalid") {
      throw new EventCompatError(
        "INVALID_EVENT_ENVELOPE",
        `Event ${rawType} carries an invalid version: ${version}.`,
      );
    }
    return {
      eventType: normalizeEventType(rawType),
      rawType,
      schemaVersion: version,
      status,
    };
  }

  // `(topic, version)` tuple form.
  if (topics.length >= 2) {
    const version = parseVersionLiteral(String(topics[1] ?? ""));
    if (version === null) {
      throw new EventCompatError(
        "INVALID_EVENT_ENVELOPE",
        `Event ${head} carries an invalid version literal.`,
      );
    }
    if (!isKnownEventType(head)) {
      throw new EventCompatError(
        "UNKNOWN_EVENT_TYPE",
        `Unknown contract event type: ${head}.`,
      );
    }
    const status = checkEventVersion(head, version);
    if (status === "Unknown") {
      throw new EventCompatError(
        "UNSUPPORTED_EVENT_VERSION",
        `Event ${normalizeEventType(head)} version ${version} is not supported (decoder v${EVENT_SCHEMA_VERSION}).`,
      );
    }
    if (status === "Invalid") {
      throw new EventCompatError(
        "INVALID_EVENT_ENVELOPE",
        `Event ${head} carries an invalid version: ${version}.`,
      );
    }
    return {
      eventType: normalizeEventType(head),
      rawType: head,
      schemaVersion: version,
      status,
    };
  }

  // Legacy unversioned single-topic form → v1.
  if (!isKnownEventType(head)) {
    throw new EventCompatError(
      "UNKNOWN_EVENT_TYPE",
      `Unknown contract event type: ${head}.`,
    );
  }
  return {
    eventType: normalizeEventType(head),
    rawType: head,
    schemaVersion: 1,
    status: "Recognized",
  };
}
