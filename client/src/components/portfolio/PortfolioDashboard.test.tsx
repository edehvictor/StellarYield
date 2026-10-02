import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import PortfolioDashboard from "./PortfolioDashboard";

/**
 * Issue #1151 — dashboard loading isolation for analytics widgets.
 *
 * PortfolioDashboard previously gated its ENTIRE tree (including
 * RiskScoreBreakdownPanel and UnifiedActivityTimeline, which already fetch
 * their own data independently) behind a single `isLoading` full-page
 * spinner driven by the mock position fetch. This coverage asserts that:
 *  - a slow/pending position fetch does not block the independently
 *    fetching widgets from rendering their own data,
 *  - a failed independent widget shows its own recovery state without
 *    affecting siblings or the position-dependent section,
 *  - there's no full-page spinner blocking the whole layout during partial
 *    loading — only the position-dependent section shows a scoped loader.
 */

// Heavy/irrelevant children mocked out so this test focuses purely on
// loading isolation, not their internal rendering.
vi.mock("../visualizations", () => ({
  YieldFlowCanvas: () => <div data-testid="yield-flow-canvas" />,
}));
vi.mock("../visualizer/PortfolioVisualizer", () => ({
  default: () => <div data-testid="portfolio-visualizer" />,
}));
vi.mock("../../portfolio/ExposureMap", () => ({
  ExposureMap: () => <div data-testid="exposure-map" />,
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

const WALLET = "GTESTWALLETADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function mockFetchByUrl(handlers: Record<string, () => Promise<unknown> | unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      for (const [key, handler] of Object.entries(handlers)) {
        if (url.includes(key)) {
          const result = handler();
          if (result instanceof Promise) {
            return result;
          }
          return Promise.resolve(result);
        }
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    }),
  );
}

describe("PortfolioDashboard loading isolation (#1151)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders healthy independent widgets while positions are still loading, with no full-page spinner", async () => {
    // Risk breakdown and activity timeline resolve quickly; the mock
    // position fetch inside PortfolioDashboard itself takes 800ms (real
    // timer), so we assert on the widgets before that resolves.
    mockFetchByUrl({
      "/api/risk/breakdown-snapshots": () => ({
        ok: true,
        json: async () => ({
          snapshots: [
            {
              regime: "calm",
              portfolioRiskScore: 2.1,
              label: "Low",
              breakdown: { tvl: 1, volatility: 1, age: 1 },
              weights: { tvl: 0.4, volatility: 0.3, age: 0.3 },
            },
          ],
        }),
      }),
      "/api/portfolio/activity": () => ({
        ok: true,
        json: async () => ({ timeline: [] }),
      }),
    });

    render(<PortfolioDashboard walletAddress={WALLET} />);

    // The position-dependent section shows its own scoped loading state...
    expect(screen.getByTestId("positions-section-loading")).toBeInTheDocument();
    // ...but there is no single full-page spinner wrapping everything: the
    // independent widgets are present in the DOM immediately, not hidden
    // behind the positions gate.
    expect(screen.queryByTestId("positions-section")).not.toBeInTheDocument();

    // Independent widgets resolve on their own, unblocked by the pending
    // position fetch.
    await waitFor(() =>
      expect(screen.getByText(/Calm/)).toBeInTheDocument(),
    );
    expect(screen.getByText("No activity found for this view.")).toBeInTheDocument();

    // Eventually the position-dependent section loads too.
    await waitFor(
      () => expect(screen.getByTestId("positions-section")).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it("shows a per-widget recovery state when the risk breakdown widget fails, without affecting the activity timeline sibling", async () => {
    mockFetchByUrl({
      "/api/risk/breakdown-snapshots": () => ({ ok: false, status: 500, json: async () => ({}) }),
      "/api/portfolio/activity": () => ({
        ok: true,
        json: async () => ({ timeline: [] }),
      }),
    });

    render(<PortfolioDashboard walletAddress={WALLET} />);

    const riskError = await screen.findByTestId("risk-breakdown-error");
    expect(within(riskError).getByText(/Retry/)).toBeInTheDocument();

    // Sibling widget is unaffected by the risk panel's failure.
    expect(await screen.findByText("No activity found for this view.")).toBeInTheDocument();
  });

  it("shows a per-widget recovery state when the activity timeline fails, without affecting the risk breakdown sibling", async () => {
    mockFetchByUrl({
      "/api/risk/breakdown-snapshots": () => ({
        ok: true,
        json: async () => ({ snapshots: [] }),
      }),
      "/api/portfolio/activity": () => ({ ok: false, status: 500, json: async () => ({}) }),
    });

    render(<PortfolioDashboard walletAddress={WALLET} />);

    const timelineError = await screen.findByTestId("activity-timeline-error");
    expect(within(timelineError).getByText(/Retry/)).toBeInTheDocument();

    // Risk panel still renders its own (empty) resolved state, unaffected.
    await waitFor(() =>
      expect(screen.queryByText("Loading risk score breakdown…")).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("risk-breakdown-error")).not.toBeInTheDocument();
  });
});
