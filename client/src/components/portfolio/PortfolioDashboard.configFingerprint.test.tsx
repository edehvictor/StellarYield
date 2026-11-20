import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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

const CONFIG_A = { version: 1, network: "testnet", pricingSource: "reflector" } as const;
const CONFIG_B = { version: 1, network: "testnet", pricingSource: "fallback-oracle" } as const;

const position = (currentValue: number): VaultPosition => ({
  protocol: "Blend",
  asset: "USDC",
  deposited: 1000,
  currentValue,
  apy: 5.0,
  shares: 1000,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("PortfolioDashboard — stale valuation configuration snapshots (#1862)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits refreshed positions and passes the config fingerprint to onRefresh", async () => {
    const onRefresh = vi.fn(async () => [position(1100)]);
    render(
      <PortfolioDashboard
        walletAddress={WALLET}
        initialPositions={[position(1050)]}
        onRefresh={onRefresh}
        valuationConfig={CONFIG_A}
      />,
    );

    expect(screen.queryByTestId("valuation-config-stale-notice")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("refresh-portfolio-button"));

    await waitFor(() => {
      expect(screen.getByTestId("priced-holding-value")).toHaveTextContent("$1,100.00");
    });
    expect(onRefresh).toHaveBeenCalledWith({
      configFingerprint: expect.stringMatching(/^pvcfg1:[0-9a-f]{16}$/),
    });
    expect(screen.queryByTestId("valuation-refresh-error-banner")).not.toBeInTheDocument();
  });

  it("discards a refresh whose config changed mid-flight and preserves existing balances", async () => {
    const pending = deferred<VaultPosition[]>();
    const onRefresh = vi.fn(() => pending.promise);
    const initialPositions = [position(1050)];
    const { rerender } = render(
      <PortfolioDashboard
        walletAddress={WALLET}
        initialPositions={initialPositions}
        onRefresh={onRefresh}
        valuationConfig={CONFIG_A}
      />,
    );

    fireEvent.click(screen.getByTestId("refresh-portfolio-button"));

    // Configuration changes while the refresh is still in flight.
    rerender(
      <PortfolioDashboard
        walletAddress={WALLET}
        initialPositions={initialPositions}
        onRefresh={onRefresh}
        valuationConfig={CONFIG_B}
      />,
    );
    await act(async () => {
      pending.resolve([position(9999)]);
    });

    const banner = await screen.findByTestId("valuation-refresh-error-banner");
    expect(banner).toHaveTextContent("Valuation settings changed during the refresh");
    expect(banner).not.toHaveTextContent("pvcfg1");
    // Stale result rejected — last confirmed balance kept.
    expect(screen.getByTestId("priced-holding-value")).toHaveTextContent("$1,050.00");
    expect(screen.getByTestId("retry-refresh-button")).toBeInTheDocument();
  });

  it("retries safely against the new config and clears the stale state", async () => {
    const first = deferred<VaultPosition[]>();
    const fingerprints: Array<string | null> = [];
    const onRefresh = vi.fn(({ configFingerprint }: { configFingerprint: string | null }) => {
      fingerprints.push(configFingerprint);
      return fingerprints.length === 1 ? first.promise : Promise.resolve([position(1200)]);
    });
    const initialPositions = [position(1050)];
    const { rerender } = render(
      <PortfolioDashboard
        walletAddress={WALLET}
        initialPositions={initialPositions}
        onRefresh={onRefresh}
        valuationConfig={CONFIG_A}
      />,
    );

    fireEvent.click(screen.getByTestId("refresh-portfolio-button"));
    rerender(
      <PortfolioDashboard
        walletAddress={WALLET}
        initialPositions={initialPositions}
        onRefresh={onRefresh}
        valuationConfig={CONFIG_B}
      />,
    );
    await act(async () => {
      first.resolve([position(9999)]);
    });
    fireEvent.click(await screen.findByTestId("retry-refresh-button"));

    await waitFor(() => {
      expect(screen.getByTestId("priced-holding-value")).toHaveTextContent("$1,200.00");
    });
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
    expect(screen.queryByTestId("valuation-refresh-error-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("valuation-config-stale-notice")).not.toBeInTheDocument();
  });

  it("flags positions valued under an older config and revalues on demand", async () => {
    const onRefresh = vi.fn(async () => [position(1300)]);
    const initialPositions = [position(1050)];
    const { rerender } = render(
      <PortfolioDashboard
        walletAddress={WALLET}
        initialPositions={initialPositions}
        onRefresh={onRefresh}
        valuationConfig={CONFIG_A}
      />,
    );

    rerender(
      <PortfolioDashboard
        walletAddress={WALLET}
        initialPositions={initialPositions}
        onRefresh={onRefresh}
        valuationConfig={CONFIG_B}
      />,
    );
    expect(await screen.findByTestId("valuation-config-stale-notice")).toBeInTheDocument();
    // Existing balances stay visible while flagged.
    expect(screen.getByTestId("priced-holding-value")).toHaveTextContent("$1,050.00");

    fireEvent.click(screen.getByTestId("revalue-portfolio-button"));
    await waitFor(() => {
      expect(screen.getByTestId("priced-holding-value")).toHaveTextContent("$1,300.00");
    });
    expect(screen.queryByTestId("valuation-config-stale-notice")).not.toBeInTheDocument();
  });

  it("keeps legacy behaviour when no valuation config is supplied", async () => {
    const onRefresh = vi.fn(async () => [position(1100)]);
    render(
      <PortfolioDashboard
        walletAddress={WALLET}
        initialPositions={[position(1050)]}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByTestId("refresh-portfolio-button"));
    await waitFor(() => {
      expect(screen.getByTestId("priced-holding-value")).toHaveTextContent("$1,100.00");
    });
    expect(onRefresh).toHaveBeenCalledWith({ configFingerprint: null });
    expect(screen.queryByTestId("valuation-config-stale-notice")).not.toBeInTheDocument();
  });
});
