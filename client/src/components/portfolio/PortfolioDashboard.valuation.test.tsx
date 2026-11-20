import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import PortfolioDashboard, { type VaultPosition } from "./PortfolioDashboard";

// Mock out heavy child visualizers so tests focus strictly on valuation state and rendering
vi.mock("../visualizations", () => ({
  YieldFlowCanvas: () => <div data-testid="yield-flow-canvas" />,
}));
vi.mock("../visualizer/PortfolioVisualizer", () => ({
  default: () => <div data-testid="portfolio-visualizer" />,
}));
vi.mock("../../portfolio/ExposureMap", () => ({
  ExposureMap: ({ data }: { data: { warnings?: string[] } }) => (
    <div data-testid="exposure-map">
      {data.warnings?.map((w, i) => (
        <span key={i} data-testid="exposure-map-warning">
          {w}
        </span>
      ))}
    </div>
  ),
}));
vi.mock("../../portfolio/DailyMovementPanel", () => ({
  DailyMovementPanel: () => <div data-testid="daily-movement-panel" />,
}));
vi.mock("../../features/presets/PresetsPanel", () => ({
  default: () => <div data-testid="presets-panel">Presets</div>,
}));
vi.mock("./PortfolioExport", () => ({ default: () => <div data-testid="portfolio-export" /> }));
vi.mock("./PortfolioImport", () => ({ default: () => <div data-testid="portfolio-import" /> }));
vi.mock("../../hooks/useDailyMovement", () => ({
  useDailyMovement: () => ({ movement: null }),
}));

const WALLET = "GA7YQD7VNOYPIDBAHCGOTEQWNZ3YTM27DYZZOHLKUA26QUBN3V2V";

describe("PortfolioDashboard — Distinguish unavailable valuations from zero balances (#1660)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders mixed priced and unpriced holdings with visibly incomplete totals", async () => {
    const mixedPositions: VaultPosition[] = [
      {
        protocol: "Blend",
        asset: "USDC",
        deposited: 5000,
        currentValue: 5200,
        apy: 6.5,
        shares: 5000,
      },
      {
        protocol: "DeFindex",
        asset: "YIELD_INDEX",
        deposited: 3000,
        currentValue: null, // Unpriced!
        apy: 8.0,
        shares: 3000,
        isPriceUnavailable: true,
      },
      {
        protocol: "Soroswap",
        asset: "XLM",
        deposited: 0,
        currentValue: 0, // Genuine zero balance!
        apy: 0,
        shares: 0,
      },
    ];

    render(
      <PortfolioDashboard
        walletAddress={WALLET}
        initialPositions={mixedPositions}
      />,
    );

    // 1. Incomplete banner appears and names the unpriced asset
    const banner = screen.getByTestId("valuation-incomplete-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent("YIELD_INDEX");
    expect(banner).toHaveTextContent("1 unpriced");

    // 2. Current Value card displays partial total with incomplete badge and notice
    expect(screen.getByTestId("incomplete-valuation-badge")).toHaveTextContent("Incomplete");
    const partialTotal = screen.getByTestId("total-value-partial");
    expect(partialTotal).toHaveTextContent("$5,200.00*");
    expect(screen.getByTestId("partial-valuation-notice")).toHaveTextContent(
      "Excludes 1 unpriced holding",
    );

    // 3. Yield Earned card calculates fair yield on priced holdings only ($5,200 - $5,000 = +$200)
    const partialYield = screen.getByTestId("yield-earned-partial");
    expect(partialYield).toHaveTextContent("+$200.00*");
    expect(screen.getByText("On priced holdings")).toBeInTheDocument();

    // 4. In Positions table, distinguish unpriced row from zero-balance row
    const unpricedValue = screen.getByTestId("unpriced-holding-value");
    expect(unpricedValue).toHaveTextContent("Price unavailable");
    const unpricedPnl = screen.getByTestId("unpriced-holding-pnl");
    expect(unpricedPnl).toHaveTextContent("—");

    const zeroValue = screen.getByTestId("zero-holding-value");
    expect(zeroValue).toHaveTextContent("$0.00");
    const zeroPnl = screen.getByTestId("zero-holding-pnl");
    expect(zeroPnl).toHaveTextContent("$0.00");

    const pricedValue = screen.getByTestId("priced-holding-value");
    expect(pricedValue).toHaveTextContent("$5,200.00");
    const pricedPnl = screen.getByTestId("priced-holding-pnl");
    expect(pricedPnl).toHaveTextContent("+$200.00");

    // 5. ExposureMap receives warning indicating unpriced holdings are excluded
    const mapWarning = screen.getByTestId("exposure-map-warning");
    expect(mapWarning).toHaveTextContent("Exposure calculation excludes 1 unpriced holding");
  });

  it("handles all-unpriced portfolio cleanly without division by zero or fake loss", async () => {
    const allUnpricedPositions: VaultPosition[] = [
      {
        protocol: "DeFindex",
        asset: "UNLISTED_A",
        deposited: 2500,
        currentValue: null,
        apy: 5.0,
        shares: 2500,
      },
      {
        protocol: "Blend",
        asset: "UNLISTED_B",
        deposited: 3500,
        currentValue: null,
        apy: 7.0,
        shares: 3500,
      },
    ];

    render(
      <PortfolioDashboard
        walletAddress={WALLET}
        initialPositions={allUnpricedPositions}
      />,
    );

    // 1. Shows "Valuations Temporarily Unavailable" notice
    const banner = screen.getByTestId("valuation-incomplete-banner");
    expect(banner).toHaveTextContent("Valuations Temporarily Unavailable");
    expect(banner).toHaveTextContent("All unpriced");

    // 2. Current Value card displays "Unavailable", not $0.00
    expect(screen.getByTestId("total-value-unavailable")).toHaveTextContent("Unavailable");

    // 3. Yield Earned card displays "—", not -$6,000.00
    expect(screen.getByTestId("yield-earned-unavailable")).toHaveTextContent("—");

    // 4. All rows show "Price unavailable"
    const unpricedRows = screen.getAllByTestId("unpriced-holding-value");
    expect(unpricedRows).toHaveLength(2);
  });

  it("preserves position state and displays stable error message when refresh fails", async () => {
    const initial: VaultPosition[] = [
      {
        protocol: "Blend",
        asset: "USDC",
        deposited: 1000,
        currentValue: 1050,
        apy: 5.0,
        shares: 1000,
      },
    ];

    let failRefresh = true;
    const onRefreshMock = vi.fn(async () => {
      if (failRefresh) {
        throw new Error("HTTP 429: Too Many Requests from Oracle Provider");
      }
      return [
        {
          protocol: "Blend",
          asset: "USDC",
          deposited: 1000,
          currentValue: 1100,
          apy: 5.0,
          shares: 1000,
        },
      ];
    });

    render(
      <PortfolioDashboard
        walletAddress={WALLET}
        initialPositions={initial}
        onRefresh={onRefreshMock}
      />,
    );

    // Initial state rendered
    expect(screen.getByTestId("priced-holding-value")).toHaveTextContent("$1,050.00");

    // Click Refresh
    const refreshBtn = screen.getByTestId("refresh-portfolio-button");
    fireEvent.click(refreshBtn);

    // Error banner appears with stable message, suppressing raw provider trace
    const errorBanner = await screen.findByTestId("valuation-refresh-error-banner");
    expect(errorBanner).toBeInTheDocument();
    expect(errorBanner).toHaveTextContent(
      "Valuation provider rate limit reached. Please wait a moment before refreshing.",
    );
    expect(errorBanner).not.toHaveTextContent("HTTP 429");

    // CRITICAL REQUIREMENT: Position state is PRESERVED, not wiped out
    expect(screen.getByTestId("priced-holding-value")).toHaveTextContent("$1,050.00");

    // Retry after fixing failure
    failRefresh = false;
    const retryBtn = screen.getByTestId("retry-refresh-button");
    fireEvent.click(retryBtn);

    // After successful retry, updated positions are shown and error is cleared
    await waitFor(() => {
      expect(screen.getByTestId("priced-holding-value")).toHaveTextContent("$1,100.00");
    });
    expect(screen.queryByTestId("valuation-refresh-error-banner")).not.toBeInTheDocument();
  });
});
