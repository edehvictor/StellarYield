/**
 * Audit-log filter form model (#1406).
 *
 * The rules mirror `server/src/utils/auditFilters.ts`, so the form can tell
 * the admin what is wrong before a request is sent. The server stays the
 * source of truth and re-validates every request.
 */

/** A Stellar public key: `G` followed by 55 base32 characters. */
export const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

/** Action names are UPPER_SNAKE identifiers; a little punctuation is allowed. */
export const AUDIT_ACTION_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

export const AUDIT_MAX_ACTION_FILTERS = 20;
export const AUDIT_PAGE_SIZE = 25;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Raw text of the filter inputs. Blank means "no filter". */
export interface AuditLogFilterForm {
  wallet: string;
  /** Comma-separated action names. */
  actions: string;
  /** `YYYY-MM-DD` from a date input; the whole UTC day is included. */
  startDate: string;
  endDate: string;
}

export const EMPTY_AUDIT_FILTER_FORM: AuditLogFilterForm = {
  wallet: "",
  actions: "",
  startDate: "",
  endDate: "",
};

export interface AuditLogFilterFormErrors {
  wallet?: string;
  actions?: string;
  startDate?: string;
  endDate?: string;
}

/** Split a comma-separated list into trimmed, de-duplicated names. */
export function parseActionList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((action) => action.trim())
        .filter(Boolean),
    ),
  ];
}

function isRealCalendarDate(value: string): boolean {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** Returns the problems with `form`; an empty object means it can be submitted. */
export function validateAuditFilterForm(
  form: AuditLogFilterForm,
): AuditLogFilterFormErrors {
  const errors: AuditLogFilterFormErrors = {};

  const wallet = form.wallet.trim();
  if (wallet && !STELLAR_ADDRESS_PATTERN.test(wallet.toUpperCase())) {
    errors.wallet =
      "Enter a valid Stellar public key (56 characters starting with G).";
  }

  const actions = parseActionList(form.actions);
  if (actions.length > AUDIT_MAX_ACTION_FILTERS) {
    errors.actions = `Filter by at most ${AUDIT_MAX_ACTION_FILTERS} actions at once.`;
  } else if (actions.some((action) => !AUDIT_ACTION_PATTERN.test(action))) {
    errors.actions =
      "Actions may contain only letters, digits, underscores, dots, colons and hyphens.";
  }

  const start = form.startDate.trim();
  const end = form.endDate.trim();
  if (start && !isRealCalendarDate(start)) {
    errors.startDate = "Enter a valid start date.";
  }
  if (end && !isRealCalendarDate(end)) {
    errors.endDate = "Enter a valid end date.";
  }
  if (!errors.startDate && !errors.endDate && start && end && start > end) {
    errors.endDate = "The end date must not be before the start date.";
  }

  return errors;
}

export function hasFormErrors(errors: AuditLogFilterFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function hasActiveAuditFilters(form: AuditLogFilterForm): boolean {
  return (
    form.wallet.trim() !== "" ||
    parseActionList(form.actions).length > 0 ||
    form.startDate.trim() !== "" ||
    form.endDate.trim() !== ""
  );
}

/**
 * Query string for `GET /api/admin/audit-logs` (and its export). Blank
 * filters are omitted, so an unfiltered request stays a plain list request.
 */
export function buildAuditLogQuery(
  form: AuditLogFilterForm,
  options: { cursor?: string | null; limit?: number } = {},
): string {
  const params = new URLSearchParams();

  const wallet = form.wallet.trim();
  if (wallet) params.set("wallet", wallet.toUpperCase());

  const actions = parseActionList(form.actions);
  if (actions.length > 0) params.set("action", actions.join(","));

  const start = form.startDate.trim();
  if (start) params.set("startDate", start);
  const end = form.endDate.trim();
  if (end) params.set("endDate", end);

  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);

  return params.toString();
}

/** Short human-readable chips describing the applied filters. */
export function describeActiveAuditFilters(form: AuditLogFilterForm): string[] {
  const chips: string[] = [];
  const wallet = form.wallet.trim().toUpperCase();
  if (wallet) chips.push(`Wallet ${wallet.slice(0, 4)}…${wallet.slice(-4)}`);
  const actions = parseActionList(form.actions);
  if (actions.length > 0) chips.push(`Actions: ${actions.join(", ")}`);
  const start = form.startDate.trim();
  const end = form.endDate.trim();
  if (start && end) chips.push(`${start} → ${end}`);
  else if (start) chips.push(`From ${start}`);
  else if (end) chips.push(`Until ${end}`);
  return chips;
}
