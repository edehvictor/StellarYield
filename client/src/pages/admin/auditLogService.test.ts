import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_AUDIT_FILTER_FORM } from "./auditLogFilters";
import {
  AUDIT_LOG_ERROR_MESSAGES,
  AuditLogRequestError,
  exportAuditLogsCsv,
  fetchAuditLogPage,
} from "./auditLogService";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const entry = (id: string) => ({
  id,
  timestamp: "2025-03-01T09:00:00.000Z",
  userId: "admin-1",
  action: "ADMIN_ACTION_CONFIRMED",
  resource: "VAULT",
  method: "POST",
  endpoint: "/x",
  status: 200,
});

function mockFetch(response: Response | (() => Promise<Response>)) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(typeof response === "function" ? response : () => Promise.resolve(response));
}

function requested(spy: ReturnType<typeof mockFetch>) {
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  const parsed = new URL(url, "http://localhost");
  return { path: parsed.pathname, query: parsed.searchParams, headers: new Headers(init.headers) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchAuditLogPage", () => {
  it("maps a page and its pagination", async () => {
    mockFetch(json({ data: [entry("a"), entry("b")], pagination: { nextCursor: "b", hasMore: true, limit: 25 } }));

    const page = await fetchAuditLogPage(EMPTY_AUDIT_FILTER_FORM);

    expect(page.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe("b");
    expect(page.hasMore).toBe(true);
  });

  it("sends the filters, cursor and bearer token", async () => {
    const spy = mockFetch(json({ data: [], pagination: { nextCursor: null, hasMore: false, limit: 25 } }));

    await fetchAuditLogPage(
      { wallet: "gbrpyhil2ci3fnq4bxlfmndlfjunpu2hy3zmfshonuceoasw7qc7ox2h", actions: "A,B", startDate: "2025-03-01", endDate: "" },
      { authToken: "secret-token", cursor: "abc" },
    );

    const { path, query, headers } = requested(spy);
    expect(path).toBe("/api/admin/audit-logs");
    expect(query.get("wallet")).toBe("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H");
    expect(query.get("action")).toBe("A,B");
    expect(query.get("startDate")).toBe("2025-03-01");
    expect(query.has("endDate")).toBe(false);
    expect(query.get("cursor")).toBe("abc");
    expect(query.get("limit")).toBe("25");
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
  });

  it("sends no Authorization header without a token", async () => {
    const spy = mockFetch(json({ data: [], pagination: { nextCursor: null, hasMore: false, limit: 25 } }));

    await fetchAuditLogPage(EMPTY_AUDIT_FILTER_FORM);

    expect(requested(spy).headers.has("Authorization")).toBe(false);
  });

  it("returns an empty page for an empty result", async () => {
    mockFetch(json({ data: [], pagination: { nextCursor: null, hasMore: false, limit: 25 } }));

    await expect(fetchAuditLogPage(EMPTY_AUDIT_FILTER_FORM)).resolves.toEqual({
      entries: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("surfaces the server's typed filter error, code, message and field", async () => {
    mockFetch(json({ error: "INVALID_WALLET", message: "wallet must be a valid Stellar public key.", details: { field: "wallet" } }, 400));

    const failure = await fetchAuditLogPage(EMPTY_AUDIT_FILTER_FORM).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AuditLogRequestError);
    expect(failure).toMatchObject({
      code: "INVALID_WALLET",
      field: "wallet",
      message: "wallet must be a valid Stellar public key.",
    });
  });

  it("falls back to a stable message when a 400 carries an unknown body", async () => {
    mockFetch(json({ oops: true }, 400));

    await expect(fetchAuditLogPage(EMPTY_AUDIT_FILTER_FORM)).rejects.toMatchObject({
      code: "INVALID_FILTER",
      message: AUDIT_LOG_ERROR_MESSAGES.INVALID_FILTER,
    });
  });

  it.each([401, 403])("maps HTTP %i to FORBIDDEN", async (status) => {
    mockFetch(json({ error: "FORBIDDEN" }, status));

    await expect(fetchAuditLogPage(EMPTY_AUDIT_FILTER_FORM)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("maps a 500 to UNAVAILABLE without leaking the server message", async () => {
    mockFetch(json({ error: "connection refused: db-primary:5432" }, 500));

    const failure = await fetchAuditLogPage(EMPTY_AUDIT_FILTER_FORM).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "UNAVAILABLE", message: AUDIT_LOG_ERROR_MESSAGES.UNAVAILABLE });
    expect((failure as Error).message).not.toContain("db-primary");
  });

  it("maps a network failure to UNAVAILABLE", async () => {
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    await expect(fetchAuditLogPage(EMPTY_AUDIT_FILTER_FORM)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("maps a malformed success body to UNAVAILABLE", async () => {
    mockFetch(json({ nope: true }));

    await expect(fetchAuditLogPage(EMPTY_AUDIT_FILTER_FORM)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("lets an abort through so callers can ignore superseded requests", async () => {
    mockFetch(() => Promise.reject(new DOMException("aborted", "AbortError")));

    await expect(fetchAuditLogPage(EMPTY_AUDIT_FILTER_FORM)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("exportAuditLogsCsv", () => {
  it("returns the CSV with the same filters", async () => {
    const spy = mockFetch(new Response("ID,Timestamp\n", { status: 200 }));

    const result = await exportAuditLogsCsv({ ...EMPTY_AUDIT_FILTER_FORM, actions: "A" }, { authToken: "t" });

    expect(result).toEqual({ csv: "ID,Timestamp\n", truncated: false });
    const { path, query, headers } = requested(spy);
    expect(path).toBe("/api/admin/audit-logs/export");
    expect(query.get("action")).toBe("A");
    expect(headers.get("Authorization")).toBe("Bearer t");
  });

  it("uses the bare export path when unfiltered", async () => {
    const spy = mockFetch(new Response("", { status: 200 }));

    await exportAuditLogsCsv(EMPTY_AUDIT_FILTER_FORM);

    expect((spy.mock.calls[0][0] as string).endsWith("/api/admin/audit-logs/export")).toBe(true);
  });

  it("reports a truncated export", async () => {
    mockFetch(new Response("x", { status: 200, headers: { "X-Audit-Export-Truncated": "true" } }));

    await expect(exportAuditLogsCsv(EMPTY_AUDIT_FILTER_FORM)).resolves.toMatchObject({ truncated: true });
  });

  it("maps failures like the list endpoint", async () => {
    mockFetch(json({ error: "INVALID_DATE", message: "bad date" }, 400));

    await expect(exportAuditLogsCsv(EMPTY_AUDIT_FILTER_FORM)).rejects.toMatchObject({ code: "INVALID_DATE" });
  });
});
