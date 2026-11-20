import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QuoteAssumptionFingerprintDisplay } from "./QuoteAssumptionFingerprintDisplay";
import {
  computeQuoteAssumptionFingerprint,
  type QuoteAssumptions,
} from "../../../../shared/types/quoteAssumptionFingerprint";

function makeMockAssumptions(overrides: Partial<QuoteAssumptions> = {}): QuoteAssumptions {
  return {
    inputTokenContract: "CB64D3G7AW2Z64V6B3H6Y5A5LGBY2QW6K3V6W7G3E2D1",
    vaultTokenContract: "CVLTFAKECONTRACTIDFORLOCALBUILDONLY",
    amountInStroops: "100000000",
    expectedAmountOutStroops: "99500000",
    minAmountOutStroops: "99000000",
    slippageTolerancePct: 0.5,
    routeHash: "abc123routehash",
    path: ["CB64D3G7AW2Z64V6B3H6Y5A5LGBY2QW6K3V6W7G3E2D1", "CVLTFAKECONTRACTIDFORLOCALBUILDONLY"],
    source: "router_simulation",
    assetConfigVersion: "v1-active-config",
    quotedAt: new Date(Date.now() - 5000).toISOString(),
    expiresAt: new Date(Date.now() + 55000).toISOString(),
    protocol: "soroswap",
    reserveSafe: true,
    ...overrides,
  };
}

describe("QuoteAssumptionFingerprintDisplay", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders empty state when no assumptions or fingerprint provided", () => {
    render(<QuoteAssumptionFingerprintDisplay />);
    expect(screen.getByTestId("fingerprint-empty")).toBeInTheDocument();
    expect(
      screen.getByText(/Enter an amount to generate a quote and cryptographic assumption fingerprint/i),
    ).toBeInTheDocument();
  });

  it("renders loading state with aria-busy", () => {
    render(<QuoteAssumptionFingerprintDisplay isLoading={true} />);
    const el = screen.getByTestId("fingerprint-loading");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText(/Computing quote assumption fingerprint…/i)).toBeInTheDocument();
  });

  it("renders explicit error state with retry button", () => {
    const onRefresh = vi.fn();
    render(
      <QuoteAssumptionFingerprintDisplay
        error="DEX router pool drained"
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByTestId("fingerprint-error")).toBeInTheDocument();
    expect(screen.getByText("DEX router pool drained")).toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retryBtn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("renders verified fingerprint badge and enables breakdown toggle", () => {
    const assumptions = makeMockAssumptions();
    const { fingerprint } = computeQuoteAssumptionFingerprint(assumptions);

    render(
      <QuoteAssumptionFingerprintDisplay
        assumptions={assumptions}
        fingerprint={fingerprint}
      />,
    );

    expect(screen.getByTestId("fingerprint-verified")).toBeInTheDocument();
    expect(screen.getByText(/Quote fingerprint/i)).toBeInTheDocument();

    // Toggle accordion breakdown
    const toggleBtn = screen.getByTestId("toggle-breakdown-btn");
    expect(screen.queryByTestId("fingerprint-breakdown")).not.toBeInTheDocument();

    fireEvent.click(toggleBtn);
    expect(screen.getByTestId("fingerprint-breakdown")).toBeInTheDocument();
    expect(screen.getByText(/99000000 stroops/i)).toBeInTheDocument();
    expect(screen.getByText(/Router Simulation/i)).toBeInTheDocument();
  });

  it("handles copy to clipboard interaction", async () => {
    const assumptions = makeMockAssumptions();
    const { fingerprint } = computeQuoteAssumptionFingerprint(assumptions);

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    render(
      <QuoteAssumptionFingerprintDisplay
        assumptions={assumptions}
        fingerprint={fingerprint}
      />,
    );

    const copyBtn = screen.getByTestId("copy-fingerprint-btn");
    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(writeTextMock).toHaveBeenCalledWith(fingerprint);
  });

  it("renders stale/expired state when quote has expired", () => {
    const onRefresh = vi.fn();
    const assumptions = makeMockAssumptions({
      quotedAt: new Date(Date.now() - 70000).toISOString(),
      expiresAt: new Date(Date.now() - 10000).toISOString(), // expired in past
    });
    const { fingerprint } = computeQuoteAssumptionFingerprint(assumptions);

    render(
      <QuoteAssumptionFingerprintDisplay
        assumptions={assumptions}
        fingerprint={fingerprint}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByTestId("fingerprint-stale")).toBeInTheDocument();
    expect(screen.getByText(/Quote assumptions expired/i)).toBeInTheDocument();

    const refreshBtn = screen.getByRole("button", { name: /refresh/i });
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("renders drifted state when parameters diverge from fingerprint", () => {
    const originalAssumptions = makeMockAssumptions({
      minAmountOutStroops: "99000000",
    });
    const { fingerprint } = computeQuoteAssumptionFingerprint(originalAssumptions);

    // Current state has a different minAmountOutStroops (drift)
    const driftedAssumptions = makeMockAssumptions({
      minAmountOutStroops: "85000000",
    });

    render(
      <QuoteAssumptionFingerprintDisplay
        assumptions={driftedAssumptions}
        fingerprint={fingerprint}
      />,
    );

    expect(screen.getByTestId("fingerprint-drifted")).toBeInTheDocument();
    expect(screen.getByText(/Assumption drift detected/i)).toBeInTheDocument();
  });
});
