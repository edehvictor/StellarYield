/**
 * Audit-log query filters (#1406): wallet, action and date range.
 *
 * The admin audit endpoints (`GET /api/admin/audit-logs` and its CSV export)
 * used to pass raw query strings straight into the in-memory filter. An
 * unparseable date became `NaN`, and every `>=` / `<=` comparison against
 * `NaN` is false, so a typo silently returned an empty page instead of an
 * error. This module parses and validates the query once, so both endpoints
 * share the same rules and report the same stable, typed errors.
 */

import type { AuditLogEntry } from "../middleware/audit";

/** A Stellar public key: `G` followed by 55 base32 characters. */
export const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

/** Action names are UPPER_SNAKE identifiers; a little punctuation is allowed. */
export const AUDIT_ACTION_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

/** Upper bound on how many actions one request can ask for. */
export const AUDIT_MAX_ACTION_FILTERS = 20;

/** Upper bound on rows in one CSV export. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

/**
 * Keys under `changes` that carry a wallet address. Anything an admin action
 * changed *for* a wallet (rather than the admin who did it) lives here.
 */
export const AUDIT_WALLET_CHANGE_KEYS: ReadonlySet<string> = new Set([
  "wallet",
  "walletaddress",
  "address",
  "useraddress",
  "owner",
  "recipient",
  "account",
  "actoraddress",
  "targetwallet",
]);

/** How deep into `changes` a wallet key is searched for (e.g. `changes.after.wallet`). */
const WALLET_SEARCH_MAX_DEPTH = 3;

/** Normalised filters, ready for `getAuditLogs`. */
export interface AuditLogFilters {
  userId?: string;
  /** Upper-cased Stellar public key. */
  wallet?: string;
  /** Trimmed, de-duplicated action names. */
  actions?: string[];
  resource?: string;
  /** ISO 8601 instant; entries at or after it match. */
  startDate?: string;
  /** ISO 8601 instant; entries at or before it match. */
  endDate?: string;
}

export type AuditFilterErrorCode =
  | "INVALID_FILTER"
  | "INVALID_WALLET"
  | "INVALID_ACTION"
  | "INVALID_DATE"
  | "INVALID_DATE_RANGE";

export interface AuditFilterError {
  code: AuditFilterErrorCode;
  /** Stable, user-presentable message — never a raw parser error. */
  message: string;
  /** The query parameter that failed validation. */
  field: string;
}

export type ParseAuditFiltersResult =
  | { ok: true; filters: AuditLogFilters }
  | { ok: false; error: AuditFilterError };

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * ISO 8601 date-time with an explicit zone. A zone is required because
 * `new Date("2025-01-01T10:00:00")` is parsed as *local* time, which would
 * make the same request return different rows on differently configured
 * servers.
 */
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A query value that was left blank (`?wallet=`) counts as "not provided". */
function readString(value: unknown): string | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function fail(
  code: AuditFilterErrorCode,
  field: string,
  message: string,
): ParseAuditFiltersResult {
  return { ok: false, error: { code, field, message } };
}

/**
 * Parse one date boundary to an ISO instant, or `null` when it is invalid.
 *
 * A date-only value (`2025-01-31`) is the whole UTC day: the start boundary
 * is 00:00:00.000Z and the end boundary is 23:59:59.999Z, so a date-range
 * picker that sends `endDate=2025-01-31` includes that day's entries.
 */
export function parseAuditDateBoundary(
  raw: string,
  edge: "start" | "end",
): string | null {
  const dateOnly = DATE_ONLY_PATTERN.exec(raw);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    const probe = new Date(Date.UTC(year, month - 1, day));
    // Reject rollovers such as 2025-02-30 (which Date would turn into Mar 2).
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      return null;
    }
    const time = edge === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z";
    return `${raw}${time}`;
  }

  if (!DATE_TIME_PATTERN.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Split `A,B` and repeated `action=A&action=B` into one trimmed list. */
function readActions(value: unknown): string[] | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  const parts = Array.isArray(value) ? value : [value];
  const actions: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") return "invalid";
    for (const piece of part.split(",")) {
      const action = piece.trim();
      if (action) actions.push(action);
    }
  }
  return actions.length === 0 ? undefined : [...new Set(actions)];
}

/**
 * Validate the filter portion of an audit-log query string.
 *
 * `limit` and `cursor` are pagination, not filters, and are handled by the
 * route; every parameter here is optional, and blank values are ignored.
 */
export function parseAuditLogFilterQuery(
  query: Record<string, unknown>,
): ParseAuditFiltersResult {
  const filters: AuditLogFilters = {};

  const userId = readString(query.userId);
  if (userId === "invalid") {
    return fail("INVALID_FILTER", "userId", "userId must be a single value.");
  }
  if (userId) filters.userId = userId;

  const resource = readString(query.resource);
  if (resource === "invalid") {
    return fail("INVALID_FILTER", "resource", "resource must be a single value.");
  }
  if (resource) filters.resource = resource;

  const wallet = readString(query.wallet);
  if (wallet === "invalid") {
    return fail("INVALID_WALLET", "wallet", "wallet must be a single Stellar address.");
  }
  if (wallet) {
    const normalized = wallet.toUpperCase();
    if (!STELLAR_ADDRESS_PATTERN.test(normalized)) {
      return fail(
        "INVALID_WALLET",
        "wallet",
        "wallet must be a valid Stellar public key (56 characters starting with G).",
      );
    }
    filters.wallet = normalized;
  }

  const actions = readActions(query.action);
  if (actions === "invalid") {
    return fail("INVALID_ACTION", "action", "action must be a string or a list of strings.");
  }
  if (actions) {
    if (actions.length > AUDIT_MAX_ACTION_FILTERS) {
      return fail(
        "INVALID_ACTION",
        "action",
        `At most ${AUDIT_MAX_ACTION_FILTERS} actions can be filtered at once.`,
      );
    }
    if (actions.some((action) => !AUDIT_ACTION_PATTERN.test(action))) {
      return fail(
        "INVALID_ACTION",
        "action",
        "Each action may contain only letters, digits, underscores, dots, colons and hyphens (max 100 characters).",
      );
    }
    filters.actions = actions;
  }

  for (const [field, edge] of [
    ["startDate", "start"],
    ["endDate", "end"],
  ] as const) {
    const raw = readString(query[field]);
    if (raw === "invalid") {
      return fail("INVALID_DATE", field, `${field} must be a single ISO 8601 date or date-time.`);
    }
    if (!raw) continue;
    const parsed = parseAuditDateBoundary(raw, edge);
    if (!parsed) {
      return fail(
        "INVALID_DATE",
        field,
        `${field} must be a calendar date (YYYY-MM-DD) or an ISO 8601 date-time with a time zone.`,
      );
    }
    filters[field] = parsed;
  }

  if (
    filters.startDate &&
    filters.endDate &&
    Date.parse(filters.startDate) > Date.parse(filters.endDate)
  ) {
    return fail("INVALID_DATE_RANGE", "startDate", "startDate must not be after endDate.");
  }

  return { ok: true, filters };
}

function includesWalletDeep(
  value: unknown,
  wallet: string,
  depth: number,
): boolean {
  if (depth > WALLET_SEARCH_MAX_DEPTH || value === null || typeof value !== "object") {
    return false;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof child === "string" &&
      AUDIT_WALLET_CHANGE_KEYS.has(key.toLowerCase()) &&
      child.trim().toUpperCase() === wallet
    ) {
      return true;
    }
    if (typeof child === "object" && includesWalletDeep(child, wallet, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * True when `wallet` (upper-case Stellar key) is the acting identity, the
 * targeted resource, or a wallet recorded in the entry's `changes`.
 */
export function auditEntryInvolvesWallet(
  entry: Pick<AuditLogEntry, "userId" | "resourceId" | "changes">,
  wallet: string,
): boolean {
  const target = wallet.trim().toUpperCase();
  if (entry.userId?.trim().toUpperCase() === target) return true;
  if (entry.resourceId?.trim().toUpperCase() === target) return true;
  return includesWalletDeep(entry.changes, target, 0);
}
