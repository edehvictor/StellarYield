/**
 * Client for the admin audit-log endpoints (#1406).
 *
 * Every failure is reduced to an `AuditLogRequestError` with a stable code and
 * message, so the UI never renders raw provider or network output.
 */

import { apiFetch, apiUrl } from "../../lib/api";
import {
  AUDIT_PAGE_SIZE,
  buildAuditLogQuery,
  type AuditLogFilterForm,
} from "./auditLogFilters";

export interface AuditLogEntryDto {
  id: string;
  timestamp: string;
  userId: string;
  userEmail?: string;
  action: string;
  resource: string;
  resourceId?: string;
  method: string;
  endpoint: string;
  status: number;
}

export interface AuditLogPage {
  entries: AuditLogEntryDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type AuditLogErrorCode =
  | "INVALID_FILTER"
  | "INVALID_WALLET"
  | "INVALID_ACTION"
  | "INVALID_DATE"
  | "INVALID_DATE_RANGE"
  | "FORBIDDEN"
  | "UNAVAILABLE";

const FILTER_ERROR_CODES: ReadonlySet<string> = new Set([
  "INVALID_FILTER",
  "INVALID_WALLET",
  "INVALID_ACTION",
  "INVALID_DATE",
  "INVALID_DATE_RANGE",
]);

/** Fallback text when the server gives no usable message. */
export const AUDIT_LOG_ERROR_MESSAGES: Record<AuditLogErrorCode, string> = {
  INVALID_FILTER: "One of the filters is not valid.",
  INVALID_WALLET: "The wallet filter is not a valid Stellar address.",
  INVALID_ACTION: "The action filter is not valid.",
  INVALID_DATE: "The date filter is not valid.",
  INVALID_DATE_RANGE: "The start date must not be after the end date.",
  FORBIDDEN: "Admin access is required to view the audit log.",
  UNAVAILABLE: "The audit log is temporarily unavailable. Please try again.",
};

export class AuditLogRequestError extends Error {
  readonly code: AuditLogErrorCode;
  /** The filter field the server rejected, when it says which. */
  readonly field?: string;

  constructor(code: AuditLogErrorCode, message?: string, field?: string) {
    super(message ?? AUDIT_LOG_ERROR_MESSAGES[code]);
    this.name = "AuditLogRequestError";
    this.code = code;
    this.field = field;
  }
}

export interface AuditLogRequestOptions {
  /** Admin bearer token. */
  authToken?: string;
  signal?: AbortSignal;
}

function authHeaders(authToken?: string): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

async function toRequestError(response: Response): Promise<AuditLogRequestError> {
  if (response.status === 401 || response.status === 403) {
    return new AuditLogRequestError("FORBIDDEN");
  }

  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
      details?: { field?: unknown };
    } | null;
    const code = typeof body?.error === "string" ? body.error : "";
    if (FILTER_ERROR_CODES.has(code)) {
      return new AuditLogRequestError(
        code as AuditLogErrorCode,
        typeof body?.message === "string" ? body.message : undefined,
        typeof body?.details?.field === "string" ? body.details.field : undefined,
      );
    }
    return new AuditLogRequestError("INVALID_FILTER");
  }

  return new AuditLogRequestError("UNAVAILABLE");
}

async function request(
  path: string,
  options: AuditLogRequestOptions,
): Promise<Response> {
  try {
    return await apiFetch(apiUrl(path), {
      headers: authHeaders(options.authToken),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AuditLogRequestError("UNAVAILABLE");
  }
}

/** Fetch one page of audit entries matching `filters`. */
export async function fetchAuditLogPage(
  filters: AuditLogFilterForm,
  options: AuditLogRequestOptions & { cursor?: string | null; limit?: number } = {},
): Promise<AuditLogPage> {
  const query = buildAuditLogQuery(filters, {
    cursor: options.cursor,
    limit: options.limit ?? AUDIT_PAGE_SIZE,
  });
  const response = await request(`/api/admin/audit-logs?${query}`, options);
  if (!response.ok) throw await toRequestError(response);

  const body = (await response.json().catch(() => null)) as {
    data?: AuditLogEntryDto[];
    pagination?: { nextCursor?: string | null; hasMore?: boolean };
  } | null;
  if (!body || !Array.isArray(body.data)) {
    throw new AuditLogRequestError("UNAVAILABLE");
  }

  return {
    entries: body.data,
    nextCursor: body.pagination?.nextCursor ?? null,
    hasMore: body.pagination?.hasMore === true,
  };
}

export interface AuditLogCsvExport {
  csv: string;
  /** True when the export hit the server's row cap and more rows exist. */
  truncated: boolean;
}

/** Download the CSV export for `filters`. */
export async function exportAuditLogsCsv(
  filters: AuditLogFilterForm,
  options: AuditLogRequestOptions = {},
): Promise<AuditLogCsvExport> {
  const query = buildAuditLogQuery(filters);
  const path = query
    ? `/api/admin/audit-logs/export?${query}`
    : "/api/admin/audit-logs/export";
  const response = await request(path, options);
  if (!response.ok) throw await toRequestError(response);

  return {
    csv: await response.text(),
    truncated: response.headers.get("X-Audit-Export-Truncated") === "true",
  };
}
