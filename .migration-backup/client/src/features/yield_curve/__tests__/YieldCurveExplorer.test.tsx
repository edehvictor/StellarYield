import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import YieldCurveExplorer from "../YieldCurveExplorer";

// Recharts' ResponsiveContainer requires ResizeObserver, which is not
// implemented in jsdom. Provide a no-op shim before any component renders.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver =
    NoopResizeObserver;
}

// Stub ResponsiveContainer so its layout effect does not bail before the
// children render under jsdom (it sizes to 0×0, which Recharts treats as
// "do not render").
vi.mock("recharts", async () => {
  const actual: Record<string, unknown> = await vi.importActual("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="recharts-responsive-container">{children}</div>
    ),
  };
});

describe("YieldCurveExplorer", () => {
  it("renders all four horizon options", () => {
    render(<YieldCurveExplorer />);
    const group = screen.getByRole("radiogroup", {
      name: /projection horizon/i,
    });
    for (const horizon of ["7d", "30d", "90d", "365d"]) {
      expect(within(group).getByRole("radio", { name: horizon })).toBeInTheDocument();
    }
  });

  it("renders best, base, and stress scenario summary cards", () => {
    render(<YieldCurveExplorer />);
    expect(screen.getByTestId("scenario-card-best")).toBeInTheDocument();
    expect(screen.getByTestId("scenario-card-base")).toBeInTheDocument();
    expect(screen.getByTestId("scenario-card-stress")).toBeInTheDocument();
  });

  it("displays an illustrative-not-guaranteed disclaimer", () => {
    render(<YieldCurveExplorer />);
    expect(screen.getByRole("note")).toHaveTextContent(/illustrative/i);
    expect(screen.getByRole("note")).toHaveTextContent(/not represent guaranteed returns/i);
  });

  it("changes the active horizon when a different option is selected", () => {
    render(<YieldCurveExplorer />);
    const group = screen.getByRole("radiogroup", {
      name: /projection horizon/i,
    });
    const sevenDay = within(group).getByRole("radio", { name: "7d" });
    const annual = within(group).getByRole("radio", { name: "365d" });
    expect(sevenDay).toHaveAttribute("aria-checked", "false");
    expect(annual).toHaveAttribute("aria-checked", "false");

    fireEvent.click(sevenDay);
    expect(sevenDay).toHaveAttribute("aria-checked", "true");
  });

  it("warns when allocation weights do not sum to 100%", () => {
    render(
      <YieldCurveExplorer
        initialAllocations={[
          { id: "a", label: "Alpha", apyPct: 8, weightPct: 25 },
          { id: "b", label: "Beta", apyPct: 12, weightPct: 25 },
        ]}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/sum to 100/i);
  });

  it("recomputes the projection when fee drag changes", () => {
    render(<YieldCurveExplorer />);
    const initialFinal = screen
      .getByTestId("scenario-card-base")
      .textContent ?? "";

    const feeSlider = screen.getByLabelText(/Fee drag/i);
    fireEvent.change(feeSlider, { target: { value: "10" } });

    const updatedFinal = screen
      .getByTestId("scenario-card-base")
      .textContent ?? "";
    expect(updatedFinal).not.toBe(initialFinal);
  });

  it("renders the chart container", () => {
    render(<YieldCurveExplorer />);
    expect(screen.getByTestId("yield-curve-chart")).toBeInTheDocument();
  });
});
