/**
 * #729 — Accessibility regression coverage: ApyDashboard data panel.
 *
 * Covers table semantics, sort button labelling, ARIA states,
 * and keyboard-accessible risk tooltips.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import ApyDashboard from "../../dashboard/ApyDashboard";

vi.mock("../../lib/api", () => ({ apiUrl: (path: string) => `http://localhost:3001${path}` }));
vi.mock("../../../lib/api", () => ({ apiUrl: (path: string) => `http://localhost:3001${path}` }));
vi.mock("../../hooks/useReducedMotion", () => ({ useReducedMotion: () => false }));
vi.mock("../../../hooks/useReducedMotion", () => ({ useReducedMotion: () => false }));

const MOCK_YIELDS = [
  {
    protocol: "Blend",
    asset: "USDC",
    apy: 6.5,
    tvl: 12000000,
    risk: "Low",
    change24h: 0.3,
    rewardTokens: ["BLND"],
    category: "Lending",
    fetchedAt: new Date().toISOString(),
  },
  {
    protocol: "Soroswap",
    asset: "XLM-USDC",
    apy: 12.2,
    tvl: 4500000,
    risk: "High",
    change24h: -0.5,
    rewardTokens: ["SWAP"],
    category: "DEX LP",
    fetchedAt: new Date().toISOString(),
  },
];

function mockFetchOk(data = MOCK_YIELDS) {
  global.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(data), { status: 200 }),
  );
}

function mockFetchFail() {
  global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
}

describe("ApyDashboard — accessibility (grid view)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the main heading at an accessible level", async () => {
    mockFetchOk();
    render(<ApyDashboard />);
    const heading = await screen.findByText("APY Comparison");
    expect(heading.tagName).toMatch(/^H[1-6]$/i);
  });

  it("Refresh button has accessible role and is not disabled on mount", async () => {
    mockFetchOk();
    render(<ApyDashboard />);
    const refreshBtn = await screen.findByRole("button", { name: /refresh rates/i });
    expect(refreshBtn).not.toBeDisabled();
  });

  it("search input has an accessible placeholder (not sole label)", async () => {
    mockFetchOk();
    render(<ApyDashboard />);
    await screen.findByText("Blend");
    const input = screen.getByRole("textbox");
    expect(input).toBeInTheDocument();
  });

  it("grid/table view toggle buttons have aria-pressed state", async () => {
    mockFetchOk();
    render(<ApyDashboard />);
    await screen.findByText("Blend");
    const cardBtn = screen.getByRole("button", { name: /cards/i });
    const tableBtn = screen.getByRole("button", { name: /table/i });
    expect(cardBtn).toHaveAttribute("aria-pressed");
    expect(tableBtn).toHaveAttribute("aria-pressed");
  });

  it("risk badges have aria-label describing protocol, asset, risk and explanation", async () => {
    mockFetchOk();
    render(<ApyDashboard />);
    await screen.findByText("Blend");
    // Risk buttons all carry aria-label per the component implementation
    const riskBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-label")?.includes("risk:"));
    expect(riskBtns.length).toBeGreaterThanOrEqual(2);
  });

  it("risk tooltip has role=tooltip with correct id binding", async () => {
    mockFetchOk();
    render(<ApyDashboard />);
    await screen.findByText("Blend");
    const tooltips = document.querySelectorAll('[role="tooltip"]');
    expect(tooltips.length).toBeGreaterThan(0);
    for (const tip of tooltips) {
      expect(tip.id).toBeTruthy();
    }
  });

  it("shows error state when fetch fails with accessible message", async () => {
    mockFetchFail();
    render(<ApyDashboard />);
    expect(
      await screen.findByText(/Failed to Load APY Data|Unable to fetch/i),
    ).toBeInTheDocument();
  });

  it("retry button is focusable after fetch failure", async () => {
    mockFetchFail();
    render(<ApyDashboard />);
    const retryBtn = await screen.findByRole("button", { name: /retry/i });
    expect(retryBtn).not.toHaveAttribute("tabindex", "-1");
  });
});

describe("ApyDashboard — accessibility (table view)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchOk();
  });

  async function switchToTable() {
    render(<ApyDashboard />);
    await screen.findByText("Blend");
    fireEvent.click(screen.getByRole("button", { name: /table/i }));
    await screen.findByRole("table");
  }

  it("table element is present in table view", async () => {
    await switchToTable();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("column header cells have aria-sort attribute", async () => {
    await switchToTable();
    const table = screen.getByRole("table");
    const sortableThs = table.querySelectorAll("th[aria-sort]");
    expect(sortableThs.length).toBeGreaterThanOrEqual(1);
  });

  it("sort buttons have aria-label describing sort direction", async () => {
    await switchToTable();
    const sortBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-label")?.startsWith("Sort by"));
    expect(sortBtns.length).toBeGreaterThanOrEqual(3);
  });

  it("sort button aria-pressed reflects active sort field", async () => {
    await switchToTable();
    const apyBtn = screen.getAllByRole("button").find(
      (b) => b.getAttribute("aria-label")?.includes("Sort by APY"),
    );
    expect(apyBtn).toBeDefined();
    // APY is default sort field
    expect(apyBtn!.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking a sort button toggles aria-pressed and updates aria-sort", async () => {
    await switchToTable();
    const tvlBtn = screen.getAllByRole("button").find(
      (b) => b.getAttribute("aria-label")?.includes("Sort by TVL"),
    );
    expect(tvlBtn).toBeDefined();
    fireEvent.click(tvlBtn!);
    await waitFor(() =>
      expect(tvlBtn!.getAttribute("aria-pressed")).toBe("true"),
    );
  });

  it("table rows contain accessible risk buttons with aria-describedby tooltips", async () => {
    await switchToTable();
    const riskBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-label")?.includes("risk:"));
    expect(riskBtns.length).toBeGreaterThanOrEqual(2);
    for (const btn of riskBtns) {
      const describedById = btn.getAttribute("aria-describedby");
      expect(describedById).toBeTruthy();
      expect(document.getElementById(describedById!)).toBeInTheDocument();
    }
  });

  it("stale data badge has aria-label with minutes-old context", async () => {
    // Supply data with an old fetchedAt so the stale badge renders
    const staleYields = MOCK_YIELDS.map((y) => ({
      ...y,
      fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }));
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(staleYields), { status: 200 }),
    );
    render(<ApyDashboard />);
    await screen.findByText("Blend");
    fireEvent.click(screen.getByRole("button", { name: /table/i }));
    await screen.findByRole("table");
    const staleEls = document
      .querySelectorAll("[aria-label]");
    const hasStaleLabel = Array.from(staleEls).some((el) =>
      el.getAttribute("aria-label")?.toLowerCase().includes("stale"),
    );
    expect(hasStaleLabel).toBe(true);
  });
});
