import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExposureMap } from "./ExposureMap";
import React from "react";

// Mock Recharts as it doesn't play well with jsdom
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  PieChart: ({ children }: any) => <div>{children}</div>,
  Pie: ({ children }: any) => <div>{children}</div>,
  Cell: () => <div />,
  Tooltip: () => <div />,
  Legend: () => <div />,
}));

describe("ExposureMap", () => {
  const mockData = {
    byAsset: { USDC: 1000, XLM: 500 },
    byProtocol: { Blend: 1500 },
    totalValue: 1500,
    warnings: ["High concentration in Blend"],
  };

  it("renders headers", () => {
    render(<ExposureMap data={mockData} />);
    expect(screen.getByText("Asset Exposure")).toBeDefined();
    expect(screen.getByText("Protocol Exposure")).toBeDefined();
  });

  it("displays warnings", () => {
    render(<ExposureMap data={mockData} />);
    expect(screen.getByText("High concentration in Blend")).toBeDefined();
  });

  it("does not render warnings if empty", () => {
    render(<ExposureMap data={{ ...mockData, warnings: [] }} />);
    expect(screen.queryByText("Concentration Warnings")).toBeNull();
  });
});
