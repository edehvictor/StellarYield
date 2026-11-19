import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuditLogPanel from "./AuditLogPanel";

const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  timestamp: "2025-03-01T09:00:00.000Z",
  userId: "admin-1",
  action: "ADMIN_ACTION_CONFIRMED",
  resource: "VAULT",
  resourceId: "vault-7",
  method: "POST",
  endpoint: "/api/admin/confirm",
  status: 200,
  ...overrides,
});

const page = (entries: unknown[], nextCursor: string | null = null) =>
  new Response(
    JSON.stringify({ data: entries, pagination: { nextCursor, hasMore: nextCursor !== null, limit: 25 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const errorResponse = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchSpy: ReturnType<typeof vi.spyOn>;

/** Answer every call with a fresh Response (a body can only be read once). */
const respondWith = (make: () => Response) =>
  fetchSpy.mockImplementation(() => Promise.resolve(make()));

function requestedQueries(): URLSearchParams[] {
  return fetchSpy.mock.calls.map(([url]: [string]) => new URL(url, "http://localhost").searchParams);
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuditLogPanel", () => {
  it("loads and lists the unfiltered log on mount, newest first", async () => {
    respondWith(() => page([entry("a"), entry("b", { action: "UPDATE_VAULT_PARAMETERS" })]));

    render(<AuditLogPanel authToken="t" />);

    expect(screen.getByText("Loading audit log…")).toBeInTheDocument();
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2
    expect(within(table).getByText("UPDATE_VAULT_PARAMETERS")).toBeInTheDocument();
    expect(requestedQueries()[0].has("wallet")).toBe(false);
    expect(fetchSpy.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer t");
  });

  it("shows an empty state that differs with and without filters", async () => {
    respondWith(() => page([]));

    render(<AuditLogPanel authToken="t" />);
    expect(await screen.findByText("No audit entries have been recorded yet.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Actions (comma-separated)"), "NOPE");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByText("No audit entries match these filters.")).toBeInTheDocument();
  });

  it("applies wallet, action and date-range filters together", async () => {
    respondWith(() => page([entry("a")]));
    render(<AuditLogPanel authToken="t" />);
    await screen.findByRole("table");

    await userEvent.type(screen.getByLabelText("Wallet address"), WALLET.toLowerCase());
    await userEvent.type(screen.getByLabelText("Actions (comma-separated)"), "A, B");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2025-03-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2025-03-31" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const query = requestedQueries()[1];
    expect(query.get("wallet")).toBe(WALLET);
    expect(query.get("action")).toBe("A,B");
    expect(query.get("startDate")).toBe("2025-03-01");
    expect(query.get("endDate")).toBe("2025-03-31");
    expect(query.has("cursor")).toBe(false);

    const chips = within(screen.getByLabelText("Applied filters")).getAllByRole("listitem");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      `Wallet ${WALLET.slice(0, 4)}…${WALLET.slice(-4)}`,
      "Actions: A, B",
      "2025-03-01 → 2025-03-31",
    ]);
  });

  it("blocks an invalid form with inline errors and sends nothing", async () => {
    respondWith(() => page([entry("a")]));
    render(<AuditLogPanel authToken="t" />);
    await screen.findByRole("table");

    await userEvent.type(screen.getByLabelText("Wallet address"), "not-a-wallet");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2025-03-02" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2025-03-01" } });

    expect(screen.getByText(/valid Stellar public key/)).toBeInTheDocument();
    expect(screen.getByText(/must not be before the start date/)).toBeInTheDocument();
    expect(screen.getByLabelText("Wallet address")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Apply filters" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Export CSV/ })).toBeDisabled();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the initial load
  });

  it("clears the filters and reloads the full log", async () => {
    respondWith(() => page([entry("a")]));
    render(<AuditLogPanel authToken="t" />);
    await screen.findByRole("table");

    await userEvent.type(screen.getByLabelText("Actions (comma-separated)"), "A");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
    expect(requestedQueries()[2].has("action")).toBe(false);
    expect(screen.getByLabelText("Actions (comma-separated)")).toHaveValue("");
    expect(screen.queryByLabelText("Applied filters")).not.toBeInTheDocument();
  });

  it("pages with the cursor, keeping the applied filters and appending rows", async () => {
    fetchSpy
      .mockResolvedValueOnce(page([entry("a")]))
      .mockResolvedValueOnce(page([entry("b")], "b"))
      .mockResolvedValueOnce(page([entry("c")]));
    render(<AuditLogPanel authToken="t" />);
    await screen.findByRole("table");

    await userEvent.type(screen.getByLabelText("Actions (comma-separated)"), "ADMIN_ACTION_CONFIRMED");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await userEvent.click(await screen.findByRole("button", { name: /more/ }));

    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3));
    const query = requestedQueries()[2];
    expect(query.get("cursor")).toBe("b");
    expect(query.get("action")).toBe("ADMIN_ACTION_CONFIRMED");
    expect(screen.queryByRole("button", { name: /more/ })).not.toBeInTheDocument();
  });

  it("keeps loaded rows and reports a failed page inline", async () => {
    fetchSpy
      .mockResolvedValueOnce(page([entry("a")], "a"))
      .mockResolvedValueOnce(errorResponse(500, { error: "db exploded" }));
    render(<AuditLogPanel authToken="t" />);
    await userEvent.click(await screen.findByRole("button", { name: /more/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
    expect(screen.queryByText(/db exploded/)).not.toBeInTheDocument();
  });

  it("shows a stable message with retry when the server is down, never the raw error", async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse(500, { error: "connection refused: db-primary:5432" }));
    render(<AuditLogPanel authToken="t" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("temporarily unavailable");
    expect(alert).not.toHaveTextContent("db-primary");

    fetchSpy.mockResolvedValueOnce(page([entry("a")]));
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("explains missing admin access without offering a pointless retry", async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse(403, { error: "FORBIDDEN" }));
    render(<AuditLogPanel authToken="viewer" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Admin access is required");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("surfaces a server-side filter rejection with the server's message", async () => {
    fetchSpy
      .mockResolvedValueOnce(page([entry("a")]))
      .mockResolvedValueOnce(errorResponse(400, { error: "INVALID_DATE", message: "endDate must be a calendar date.", details: { field: "endDate" } }));
    render(<AuditLogPanel authToken="t" />);
    await screen.findByRole("table");

    await userEvent.type(screen.getByLabelText("Actions (comma-separated)"), "A");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("endDate must be a calendar date.");
  });

  it("ignores a superseded response", async () => {
    let resolveFirst!: (response: Response) => void;
    fetchSpy
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(page([entry("second", { action: "SECOND_REQUEST" })]));
    render(<AuditLogPanel authToken="t" />);

    await userEvent.type(screen.getByLabelText("Actions (comma-separated)"), "X");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByText("SECOND_REQUEST")).toBeInTheDocument();

    resolveFirst(page([entry("first", { action: "FIRST_REQUEST" })]));
    await Promise.resolve();

    expect(screen.queryByText("FIRST_REQUEST")).not.toBeInTheDocument();
    expect(screen.getByText("SECOND_REQUEST")).toBeInTheDocument();
  });

  it("asks for an admin token when none is supplied, and keeps it out of storage", async () => {
    respondWith(() => errorResponse(403));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(<AuditLogPanel />);
    await screen.findByRole("alert");

    respondWith(() => page([entry("a")]));
    await userEvent.type(screen.getByLabelText("Admin access token"), "typed-token");
    await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(fetchSpy.mock.calls.at(-1)?.[1].headers.get("Authorization")).toBe("Bearer typed-token");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("does not render the token field when a token is supplied", async () => {
    respondWith(() => page([]));
    render(<AuditLogPanel authToken="t" />);
    await screen.findByText("No audit entries have been recorded yet.");

    expect(screen.queryByLabelText("Admin access token")).not.toBeInTheDocument();
  });

  describe("export", () => {
    let createObjectURL: ReturnType<typeof vi.fn>;
    let click: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      createObjectURL = vi.fn(() => "blob:audit");
      Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
      click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    });

    it("downloads a CSV of the applied filters", async () => {
      fetchSpy.mockResolvedValueOnce(page([entry("a")]));
      render(<AuditLogPanel authToken="t" />);
      await screen.findByRole("table");
      await userEvent.type(screen.getByLabelText("Actions (comma-separated)"), "A");
      fetchSpy.mockResolvedValueOnce(page([entry("a")]));
      await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

      fetchSpy.mockResolvedValueOnce(new Response("ID\n", { status: 200 }));
      await userEvent.click(screen.getByRole("button", { name: /Export CSV/ }));

      expect(await screen.findByText("Export downloaded.")).toBeInTheDocument();
      const exportCall = fetchSpy.mock.calls.at(-1) as [string];
      expect(exportCall[0]).toContain("/api/admin/audit-logs/export?");
      expect(new URL(exportCall[0], "http://localhost").searchParams.get("action")).toBe("A");
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
    });

    it("warns when the export was truncated", async () => {
      fetchSpy.mockResolvedValueOnce(page([entry("a")]));
      render(<AuditLogPanel authToken="t" />);
      await screen.findByRole("table");

      fetchSpy.mockResolvedValueOnce(new Response("ID\n", { status: 200, headers: { "X-Audit-Export-Truncated": "true" } }));
      await userEvent.click(screen.getByRole("button", { name: /Export CSV/ }));

      expect(await screen.findByRole("status")).toHaveTextContent("Export truncated");
    });

    it("reports a failed export with a stable message and downloads nothing", async () => {
      fetchSpy.mockResolvedValueOnce(page([entry("a")]));
      render(<AuditLogPanel authToken="t" />);
      await screen.findByRole("table");

      fetchSpy.mockResolvedValueOnce(errorResponse(500));
      await userEvent.click(screen.getByRole("button", { name: /Export CSV/ }));

      expect(await screen.findByRole("status")).toHaveTextContent("temporarily unavailable");
      expect(createObjectURL).not.toHaveBeenCalled();
    });
  });
});
