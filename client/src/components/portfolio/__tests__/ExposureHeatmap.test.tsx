import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import ExposureHeatmap from "../ExposureHeatmap";

const p = (asset: string, protocol: string, valueUsd: number) => ({ asset, protocol, valueUsd });

describe("ExposureHeatmap", () => {
  it("renders an asset × protocol grid with shares and totals", () => {
    render(
      <ExposureHeatmap
        positions={[p("USDC", "Blend", 5_000), p("XLM", "Soroswap", 2_000), p("USDC", "Soroswap", 3_000)]}
      />,
    );

    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Asset \\ Protocol", "Blend", "Soroswap", "Total"]);

    expect(screen.getByTestId("heatmap-cell-USDC-Blend")).toHaveTextContent("50.0%");
    expect(screen.getByTestId("heatmap-cell-USDC-Soroswap")).toHaveTextContent("30.0%");
    expect(screen.getByTestId("heatmap-cell-XLM-Blend")).toHaveTextContent("—");
    expect(screen.getByTestId("heatmap-cell-XLM-Blend")).toHaveAttribute(
      "aria-label",
      "XLM on Blend: no exposure",
    );
    expect(screen.getByText("$10,000")).toBeInTheDocument();
  });

  it("outlines pairs that breach the concentration threshold", () => {
    render(<ExposureHeatmap positions={[p("USDC", "Blend", 90), p("XLM", "Soroswap", 10)]} />);

    const hot = screen.getByTestId("heatmap-cell-USDC-Blend");
    expect(hot).toHaveAttribute("data-severity", "critical");
    expect(hot.getAttribute("aria-label")).toMatch(/critical$/);
    expect(screen.getByTestId("heatmap-cell-XLM-Soroswap")).toHaveAttribute("data-severity", "ok");
    expect(screen.getByText(/1 pair above the 50% concentration threshold/)).toBeInTheDocument();
  });

  it("respects threshold overrides", () => {
    render(
      <ExposureHeatmap
        positions={[p("USDC", "Blend", 60), p("XLM", "Soroswap", 40)]}
        thresholds={{ asset: { warn: 0.7 }, protocol: { warn: 0.7 } }}
      />,
    );
    expect(screen.getByTestId("exposure-heatmap")).toHaveAttribute("data-severity", "ok");
  });

  it("collapses the long tail into Other and lists its members", () => {
    render(
      <ExposureHeatmap
        positions={[p("A", "Blend", 50), p("B", "Blend", 30), p("C", "Blend", 15), p("D", "Blend", 5)]}
        maxAssets={3}
      />,
    );
    const other = screen.getByRole("rowheader", { name: "Other" });
    expect(other).toHaveAttribute("title", "C, D");
    expect(screen.getByTestId("heatmap-cell-__other__-Blend")).toHaveTextContent("20.0%");
  });

  it("shows the loading skeleton", () => {
    render(<ExposureHeatmap positions={[]} loading />);
    expect(screen.getByTestId("exposure-heatmap-loading")).toBeInTheDocument();
  });

  it("shows the empty state for no funded positions", () => {
    render(<ExposureHeatmap positions={[p("USDC", "Blend", 0)]} />);
    expect(screen.getByTestId("exposure-heatmap-empty")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows a code-mapped error for invalid positions instead of crashing", () => {
    render(<ExposureHeatmap positions={[p("USDC", "Blend", Number.NaN)]} />);
    const alert = screen.getByTestId("exposure-heatmap-error");
    expect(alert).toHaveAttribute("data-error-code", "INVALID_POSITION");
    expect(alert).toHaveTextContent("missing or invalid values");
  });
});
