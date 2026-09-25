import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ApyDashboard from "../ApyDashboard";

const mockFetch = vi.fn();
global.fetch = mockFetch;

function createDeferredResponse() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("ApyDashboard states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
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

  it("shows loading state while APY data is being fetched", async () => {
    const deferred = createDeferredResponse();
    mockFetch.mockReturnValueOnce(deferred.promise);

    render(<ApyDashboard />);

    expect(screen.getByText(/Loading latest APY data/i)).toBeInTheDocument();

    deferred.resolve({
      ok: true,
      json: async () => [],
    });
    await screen.findByTestId("apy-empty-state");
  });

  it("renders APY cards when request succeeds", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          protocol: "Blend",
          asset: "USDC",
          apy: 8.42,
          tvl: 2450000,
          risk: "Low",
          change24h: 0.32,
          rewardTokens: ["BLND"],
          category: "Lending",
        },
      ],
    });

    render(<ApyDashboard />);

    const blendLabels = await screen.findAllByText("Blend");
    expect(blendLabels.length).toBeGreaterThan(0);
    expect(screen.getByText("USDC")).toBeInTheDocument();
    expect(screen.getByText("8.42")).toBeInTheDocument();
  });

  it("renders empty state when API returns no APY rows", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    render(<ApyDashboard />);

    expect(await screen.findByTestId("apy-empty-state")).toBeInTheDocument();
    expect(screen.getByText(/No APY data yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /New rates will appear here as protocols report yields/i,
      ),
    ).toBeInTheDocument();
  });

  it("shows retryable failure state and recovers on retry", async () => {
    const user = userEvent.setup();

    mockFetch
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            protocol: "Soroswap",
            asset: "XLM-USDC",
            apy: 14.75,
            tvl: 3100000,
            risk: "Medium",
          },
        ],
      });

    render(<ApyDashboard />);

    expect(
      await screen.findByText(/APY Data Temporarily Unavailable/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Retry/i }));

    const soroswapLabels = await screen.findAllByText("Soroswap");
    expect(soroswapLabels.length).toBeGreaterThan(0);
  });

  it("adds accessible sorting, risk tooltip, and stale status in table view", async () => {
    const user = userEvent.setup();
    const staleFetchedAt = new Date(Date.now() - 6 * 60_000).toISOString();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          protocol: "Blend",
          asset: "USDC",
          apy: 8.42,
          tvl: 2450000,
          risk: "Low",
          change24h: 0.32,
          rewardTokens: ["BLND"],
          category: "Lending",
          fetchedAt: staleFetchedAt,
        },
      ],
    });

    render(<ApyDashboard />);

    await screen.findByText("USDC");
    await user.click(screen.getByRole("button", { name: /^Table$/i }));

    const apySort = screen.getByRole("button", {
      name: /APY sorted descending; activate to sort ascending/i,
    });
    expect(apySort).toHaveAttribute("aria-pressed", "true");
    expect(apySort.closest("th")).toHaveAttribute("aria-sort", "descending");

    await user.click(apySort);
    expect(
      screen.getByRole("button", {
        name: /APY sorted ascending; activate to sort descending/i,
      }),
    ).toHaveAttribute("aria-pressed", "true");

    const staleBadge = screen.getByLabelText(
      /Stale APY data for Blend USDC; last updated/i,
    );
    expect(staleBadge).toHaveTextContent("Stale");

    const riskBadge = screen.getByText("Low");
    expect(riskBadge.parentElement).toHaveAttribute(
      "aria-describedby",
      "vault-risk-tip-table-blend-usdc",
    );
    expect(screen.getByRole("tooltip")).toHaveAttribute(
      "id",
      "vault-risk-tip-table-blend-usdc",
    );
  });

  it("handles partial APY rows without breaking layout", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          apy: "not-a-number",
          risk: "Unknown",
          rewardTokens: [],
        },
      ],
    });

    render(<ApyDashboard />);

    const unknownProtocols = await screen.findAllByText("Unknown Protocol");
    expect(unknownProtocols.length).toBeGreaterThan(0);
    expect(screen.getByText("Unknown Asset")).toBeInTheDocument();
    expect(screen.getByText("0.00")).toBeInTheDocument();
  });

  it("exposes accessible sort state, risk tooltips, and stale labels", async () => {
    const user = userEvent.setup();
    const fetchedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          protocol: "Blend",
          asset: "USDC",
          apy: 8.42,
          tvl: 2450000,
          risk: "Low",
          change24h: 0.32,
          rewardTokens: ["BLND"],
          category: "Lending",
          fetchedAt,
        },
      ],
    });

    render(<ApyDashboard />);

    expect(
      await screen.findByRole("button", { name: /Vault risk: Low\./i }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Stale APY data for Blend USDC; last updated/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Table$/i }));

    expect(screen.getByRole("columnheader", { name: /APY/i })).toHaveAttribute(
      "aria-sort",
      "descending",
    );

    const tvlSort = screen.getByRole("button", {
      name: /^Sort by TVL descending$/i,
    });
    expect(tvlSort).toHaveAttribute("aria-pressed", "false");

    await user.click(tvlSort);

    expect(screen.getByRole("columnheader", { name: /TVL/i })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(
      screen.getByRole("button", {
        name: /TVL sorted descending; activate to sort ascending/i,
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("shows cached rates with an offline banner and refreshes on reconnect", async () => {
    const user = userEvent.setup();
    const rows = [
      {
        protocol: "Blend",
        asset: "USDC",
        apy: 8.42,
        tvl: 2450000,
        risk: "Low",
        change24h: 0.32,
        rewardTokens: ["BLND"],
        category: "Lending",
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => rows,
    });

    render(<ApyDashboard />);
    await screen.findByText("USDC");

    // Subsequent refresh fails (offline) — cached rows keep rendering.
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await user.click(screen.getByRole("button", { name: /Refresh Rates/i }));

    const banner = await screen.findByTestId("offline-cache-banner");
    expect(banner).toHaveTextContent("Offline — Showing Cached Data");
    expect(screen.getAllByText("Blend").length).toBeGreaterThan(0);
    expect(
      screen.queryByText(/APY Data Temporarily Unavailable/i),
    ).not.toBeInTheDocument();

    // Reconnect: fresh response replaces the cache and clears the banner.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          protocol: "Soroswap",
          asset: "XLM-USDC",
          apy: 14.75,
          tvl: 3100000,
          risk: "Medium",
        },
      ],
    });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect((await screen.findAllByText("Soroswap")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.queryByTestId("offline-cache-banner")).not.toBeInTheDocument();
    });
  });
});

// ── Deterministic ordering (#1118) ───────────────────────────────────────────

describe("ApyDashboard deterministic row ordering (#1118)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  const fetchedAt = new Date().toISOString();

  function makeRow(protocol: string, asset: string) {
    return {
      protocol,
      asset,
      apy: 5,
      tvl: 1_000_000,
      risk: "Low",
      change24h: 0,
      rewardTokens: ["BLND"],
      category: "Lending",
      fetchedAt,
    };
  }

  /** Render, switch to table view, and return the table row ids in DOM order. */
  async function getTableRowOrder(rows: unknown[]): Promise<string[]> {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => rows });
    const user = userEvent.setup();
    const view = render(<ApyDashboard />);

    const tableToggle = await screen.findByRole("button", { name: /^Table$/i });
    await user.click(tableToggle);

    await waitFor(() => {
      expect(
        document.querySelectorAll('[id^="vault-risk-tip-table-"]').length,
      ).toBe(rows.length);
    });

    const order = Array.from(
      document.querySelectorAll('[id^="vault-risk-tip-table-"]'),
    ).map((el) => el.id.replace(/^vault-risk-tip-table-/, ""));

    view.unmount();
    return order;
  }

  it("keeps the same row order for equal-APY rows regardless of backend order", async () => {
    const alpha = makeRow("Alpha", "USDC");
    const mid = makeRow("Mid", "XLM");
    const zeta = makeRow("Zeta", "USDC");

    const firstRefresh = await getTableRowOrder([zeta, alpha, mid]);
    const secondRefresh = await getTableRowOrder([mid, zeta, alpha]);

    // All values tie (apy, tvl, risk) → final tiebreak is the ascending
    // protocol-asset row id, independent of backend response order.
    expect(firstRefresh).toEqual(["alpha-usdc", "mid-xlm", "zeta-usdc"]);
    expect(secondRefresh).toEqual(firstRefresh);
  });

  it("breaks protocol-name ties deterministically by row id when sorting by protocol", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeRow("Blend", "XLM"),
        makeRow("Blend", "USDC"),
        makeRow("Alpha", "USDC"),
      ],
    });
    const user = userEvent.setup();
    render(<ApyDashboard />);

    await user.click(await screen.findByRole("button", { name: /^Table$/i }));
    await waitFor(() => {
      expect(
        document.querySelectorAll('[id^="vault-risk-tip-table-"]').length,
      ).toBe(3);
    });

    await user.click(
      screen.getByRole("button", { name: /^Sort by Protocol descending$/i }),
    );

    const order = Array.from(
      document.querySelectorAll('[id^="vault-risk-tip-table-"]'),
    ).map((el) => el.id.replace(/^vault-risk-tip-table-/, ""));

    // Primary key: protocol descending → Blend rows before Alpha.
    // Equal protocol → ascending row id tiebreak → blend-usdc before blend-xlm.
    expect(order).toEqual(["blend-usdc", "blend-xlm", "alpha-usdc"]);
  });

  it("sorts fee attribution rows alphabetically by vault", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeRow("Zeta", "USDC"), makeRow("Alpha", "USDC")],
    });
    render(<ApyDashboard />);

    await screen.findByRole("button", { name: /^Table$/i });

    await waitFor(() => {
      const feeHeading = screen.getByText(/Cross-Vault Fee Attribution/i);
      expect(feeHeading).toBeInTheDocument();
    });

    const feeTable = Array.from(document.querySelectorAll("table")).find(
      (table) => table.textContent?.includes("Total Drag"),
    );
    expect(feeTable).toBeTruthy();
    const feeVaultCells = Array.from(
      feeTable!.querySelectorAll("tbody tr td:first-child"),
    ).map((cell) => cell.textContent?.trim());
    expect(feeVaultCells).toEqual(["Alpha", "Zeta"]);
  });
});
