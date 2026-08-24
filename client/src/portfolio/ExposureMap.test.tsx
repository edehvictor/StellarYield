import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExposureMap } from "./ExposureMap";
import React from "react";

// Mock Recharts as it doesn't play well with jsdom
type WrapperProps = { children?: React.ReactNode };

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: WrapperProps) => <div>{children}</div>,
  PieChart: ({ children }: WrapperProps) => <div>{children}</div>,
  Pie: ({ children }: WrapperProps) => <div>{children}</div>,
  Cell: () => <div />,
  Tooltip: () => <div />,
  Legend: () => <div />,
}));

describe("ExposureMap", () => {
  // USDC is 67% of the portfolio (warn) and Blend holds 100% of it (critical).
  const mockData = {
    byAsset: { USDC: 1000, XLM: 500 },
    byProtocol: { Blend: 1500 },
    totalValue: 1500,
  };

  const balanced = {
    byAsset: { USDC: 500, XLM: 500 },
    byProtocol: { Blend: 500, Soroswap: 500 },
    totalValue: 1000,
  };

  it("renders headers", () => {
    render(<ExposureMap data={mockData} />);
    expect(screen.getByText("Asset Exposure")).toBeDefined();
    expect(screen.getByText("Protocol Exposure")).toBeDefined();
  });

  it("warns on an asset above the warn threshold", () => {
    render(<ExposureMap data={mockData} />);
    expect(screen.getByText("High concentration in USDC (67%)")).toBeDefined();
  });

  it("escalates to critical for a dominant protocol", () => {
    render(<ExposureMap data={mockData} />);
    expect(screen.getByText("Critical concentration in Blend protocol (100%)")).toBeDefined();
  });

  it("does not warn on a diversified portfolio", () => {
    render(<ExposureMap data={balanced} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows each bucket's share of the portfolio, flagging the breaching ones", () => {
    render(<ExposureMap data={mockData} />);
    expect(screen.getByText("33%")).toBeDefined();
    expect(screen.getByText("67% · Warning")).toBeDefined();
    expect(screen.getByText("100% · Critical")).toBeDefined();
  });

  it("honors custom thresholds", () => {
    // A 67% asset share is fine at a 70% warn threshold.
    render(<ExposureMap data={mockData} thresholds={{ asset: { warn: 0.7 } }} />);
    expect(screen.queryByText(/concentration in USDC/)).toBeNull();
  });

  it("lowers the threshold to catch smaller concentrations", () => {
    render(<ExposureMap data={balanced} thresholds={{ asset: { warn: 0.4 } }} />);
    expect(screen.getByText("High concentration in USDC (50%)")).toBeDefined();
    expect(screen.getByText("High concentration in XLM (50%)")).toBeDefined();
  });

  it("renders caller-supplied warnings alongside computed ones", () => {
    render(<ExposureMap data={{ ...balanced, warnings: ["Custom risk note"] }} />);
    expect(screen.getByText("Custom risk note")).toBeDefined();
  });

  it("handles an empty portfolio without warning", () => {
    render(<ExposureMap data={{ byAsset: {}, byProtocol: {}, totalValue: 0 }} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
