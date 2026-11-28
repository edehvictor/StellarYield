/**
 * ApyDashboard — failure diagnostics (#1877).
 *
 * Covers how the yield display renders server diagnostics, partial/missing/
 * malformed diagnostic context, client-side failures, privacy, and that a
 * failed refresh keeps the rates already on screen.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ApyDashboard from "../ApyDashboard";
import { resetDefaultCacheStore } from "../../../lib/cachedFetch";
import {
  YIELD_DIAGNOSTIC_CATALOG,
  buildYieldDiagnostic,
} from "../../../../../shared/types/yieldDiagnostics";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const ROW = {
  protocol: "Blend",
  asset: "USDC",
  apy: 8.42,
  tvl: 2_450_000,
  risk: "Low",
  change24h: 0.32,
  rewardTokens: ["BLND"],
  category: "Lending",
  fetchedAt: new Date().toISOString(),
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  };
}

function nonJsonResponse(status: number) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
  };
}

async function findNotice() {
  return screen.findByTestId("yield-diagnostic");
}

beforeEach(() => {
  mockFetch.mockReset();
  window.localStorage.clear();
  resetDefaultCacheStore();
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

describe("ApyDashboard diagnostics — success path", () => {
  it("renders rates and no diagnostic when the request succeeds", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [ROW]));
    render(<ApyDashboard />);

    expect((await screen.findAllByText("Blend")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("yield-diagnostic")).not.toBeInTheDocument();
  });
});

describe("ApyDashboard diagnostics — server diagnostics", () => {
  it("shows the failed stage, remediation and reference for a complete diagnostic", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(500, {
        error: "YIELD_FETCH_FAILED",
        message: "Unable to fetch yield data right now.",
        requestId: "req-42",
        diagnostic: buildYieldDiagnostic("source_retrieval", "req-42"),
      }),
    );
    render(<ApyDashboard />);

    const notice = await findNotice();
    expect(notice).toHaveAttribute("role", "alert");
    expect(notice).toHaveAttribute("data-stage", "source_retrieval");
    expect(within(notice).getByText(/APY Data Temporarily Unavailable/i)).toBeInTheDocument();
    expect(within(notice).getByText("Loading yield sources")).toBeInTheDocument();
    expect(
      within(notice).getByText(YIELD_DIAGNOSTIC_CATALOG.YIELD_SOURCE_UNAVAILABLE.remediation!),
    ).toBeInTheDocument();
    expect(within(notice).getByText("req-42")).toBeInTheDocument();
    expect(within(notice).getByText("500")).toBeInTheDocument();
    expect(within(notice).getByRole("button", { name: /Retry/i })).toBeEnabled();
    expect(screen.queryByTestId("apy-empty-state")).not.toBeInTheDocument();
  });

  it("completes a partial diagnostic that only names the stage", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(500, { error: "YIELD_FETCH_FAILED", diagnostic: { stage: "reliability_scoring" } }),
    );
    render(<ApyDashboard />);

    const notice = await findNotice();
    expect(within(notice).getByText("Source health check")).toBeInTheDocument();
    expect(
      within(notice).getByText(YIELD_DIAGNOSTIC_CATALOG.YIELD_RELIABILITY_UNAVAILABLE.remediation!),
    ).toBeInTheDocument();
    expect(within(notice).getByText("not available")).toBeInTheDocument();
  });

  it("does not offer Retry for a non-retryable validation failure", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(400, {
        error: "VALIDATION_FAILED",
        diagnostic: buildYieldDiagnostic("input_validation"),
      }),
    );
    render(<ApyDashboard />);

    const notice = await findNotice();
    expect(within(notice).getByText("Request validation")).toBeInTheDocument();
    expect(within(notice).queryByRole("button", { name: /Retry/i })).not.toBeInTheDocument();
  });
});

describe("ApyDashboard diagnostics — insufficient context", () => {
  it.each([
    ["a legacy body without diagnostic", { error: "YIELD_FETCH_FAILED", message: "x" }],
    ["a null diagnostic", { diagnostic: null }],
    ["an unrecognised diagnostic", { diagnostic: { code: "???", stage: "warp" } }],
    ["a null body", null],
    ["a non-object body", "Bad Gateway"],
  ])("falls back to an explicit unknown stage for %s", async (_label, body) => {
    mockFetch.mockResolvedValueOnce(jsonResponse(502, body));
    render(<ApyDashboard />);

    const notice = await findNotice();
    expect(notice).toHaveAttribute("data-stage", "unknown");
    expect(within(notice).getByText("Could not be determined")).toBeInTheDocument();
    expect(
      within(notice).getByText(/not enough information to suggest a specific fix/i),
    ).toBeInTheDocument();
    expect(within(notice).queryByText(/What to do:/)).not.toBeInTheDocument();
  });

  it("does not crash when the error body is not JSON, and uses the header request id", async () => {
    mockFetch.mockResolvedValueOnce({
      ...nonJsonResponse(503),
      headers: new Headers({ "x-request-id": "hdr-7" }),
    });
    render(<ApyDashboard />);

    const notice = await findNotice();
    expect(notice).toHaveAttribute("data-stage", "unknown");
    expect(within(notice).getByText("hdr-7")).toBeInTheDocument();
  });

  it("reports a 2xx body that is not a list as a parsing failure, not an empty market", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { rows: [ROW] }));
    render(<ApyDashboard />);

    const notice = await findNotice();
    expect(notice).toHaveAttribute("data-stage", "response_parsing");
    expect(within(notice).getByText("Reading the response")).toBeInTheDocument();
    expect(screen.queryByTestId("apy-empty-state")).not.toBeInTheDocument();
  });

  it("reports a request that never got a response as a network failure", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<ApyDashboard />);

    const notice = await findNotice();
    expect(notice).toHaveAttribute("data-stage", "network");
    expect(within(notice).getByText("Connecting to the yield service")).toBeInTheDocument();
  });
});

describe("ApyDashboard diagnostics — privacy", () => {
  it("never renders raw error text, stack traces or secrets from the response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(500, {
        error: "YIELD_FETCH_FAILED",
        message: "ECONNREFUSED postgres://admin:hunter2@10.0.0.5:5432",
        stack: "Error: boom\n    at handler (/srv/app/routes/yields.ts:42:7)",
        requestId: "<img src=x onerror=alert(1)>",
        diagnostic: {
          code: "YIELD_SOURCE_UNAVAILABLE",
          summary: "provider key sk_live_ABC123 rejected",
          remediation: "Set API_KEY=sk_live_ABC123",
        },
      }),
    );
    const { container } = render(<ApyDashboard />);

    await findNotice();
    const text = container.textContent ?? "";
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("yields.ts:42");
    expect(text).not.toContain("sk_live_ABC123");
    expect(text).not.toContain("onerror");
    expect(container.querySelector("img")).toBeNull();
    expect(text).toContain(YIELD_DIAGNOSTIC_CATALOG.YIELD_SOURCE_UNAVAILABLE.summary);
  });
});

describe("ApyDashboard diagnostics — state preservation and retry", () => {
  it("keeps the rates already on screen when a refresh fails", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [ROW]));
    render(<ApyDashboard />);
    await screen.findByText("USDC");
    // No cache to fall back on: the refresh fails outright.
    window.localStorage.clear();
    resetDefaultCacheStore();

    mockFetch.mockResolvedValueOnce(
      jsonResponse(500, { diagnostic: buildYieldDiagnostic("yield_enrichment", "req-9") }),
    );
    await user.click(screen.getByRole("button", { name: /Refresh Rates/i }));

    const notice = await findNotice();
    expect(notice).toHaveAttribute("role", "status");
    expect(within(notice).getByText(/Showing the last available rates/i)).toBeInTheDocument();
    expect(within(notice).getByText("Net yield calculation")).toBeInTheDocument();
    // Previously loaded rates are untouched.
    expect(screen.getByText("USDC")).toBeInTheDocument();
    expect(screen.getByText("8.42")).toBeInTheDocument();
    expect(screen.queryByText(/APY Data Temporarily Unavailable/i)).not.toBeInTheDocument();
  });

  it("recovers on retry, issuing one request per retry and rendering rows once", async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(500, { diagnostic: buildYieldDiagnostic("source_retrieval") }),
      )
      .mockResolvedValueOnce(jsonResponse(200, [ROW]));
    render(<ApyDashboard />);

    const notice = await findNotice();
    await user.click(within(notice).getByRole("button", { name: /Retry/i }));

    await screen.findByText("USDC");
    await waitFor(() =>
      expect(screen.queryByTestId("yield-diagnostic")).not.toBeInTheDocument(),
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("USDC")).toHaveLength(1);
  });

  it("ignores a slow failure that resolves after a newer successful response", async () => {
    const user = userEvent.setup();
    let resolveFirst: (value: unknown) => void = () => {};
    mockFetch
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(jsonResponse(200, [ROW]));
    render(<ApyDashboard />);

    // Wait until the slow initial request is in flight, then refresh.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole("button", { name: /Refresh Rates/i }));
    await screen.findByText("USDC");

    resolveFirst(jsonResponse(500, { diagnostic: buildYieldDiagnostic("source_retrieval") }));
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.queryByTestId("yield-diagnostic")).not.toBeInTheDocument();
    expect(screen.getByText("USDC")).toBeInTheDocument();
  });
});
