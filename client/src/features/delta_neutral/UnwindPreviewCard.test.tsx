import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UnwindPreviewCard } from "./UnwindPreviewCard";
import type { UnwindQuote } from "./unwindPreview";

function makeQuote(overrides: Partial<UnwindQuote> = {}): UnwindQuote {
  return {
    depositor: "GDEPOSITOR",
    legs: [
      { leg: "spot", status: "quoted", expectedOutputUsdc: "10000000" },
      { leg: "perp", status: "quoted", expectedOutputUsdc: "5000000" },
    ],
    totalExpectedUsdc: "15000000",
    canExecute: true,
    riskNotes: ["Perp leg is an off-chain estimate."],
    isEstimate: true,
    quotedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("UnwindPreviewCard", () => {
  it("complete: enables the confirm action and shows both leg amounts", () => {
    render(<UnwindPreviewCard quote={makeQuote()} onConfirm={vi.fn()} />);
    expect(screen.getByText("$1.00")).toBeDefined();
    expect(screen.getByText("$0.50")).toBeDefined();
    const button = screen.getByText("Close Position") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("partial: names the unavailable leg and disables the confirm action", () => {
    const quote = makeQuote({
      canExecute: false,
      legs: [
        { leg: "spot", status: "unavailable", reason: "Price oracle unreachable." },
        { leg: "perp", status: "quoted", expectedOutputUsdc: "5000000" },
      ],
    });
    render(<UnwindPreviewCard quote={quote} onConfirm={vi.fn()} />);

    expect(screen.getByText(/Unavailable — Price oracle unreachable\./)).toBeDefined();
    const button = screen.getByText("Close Position") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/cannot proceed to execution/)).toBeDefined();
  });

  it("unavailable: disables confirm when both legs are unavailable", () => {
    const quote = makeQuote({
      canExecute: false,
      legs: [
        { leg: "spot", status: "unavailable", reason: "No open position found for this depositor." },
        { leg: "perp", status: "unavailable", reason: "No open position found for this depositor." },
      ],
      totalExpectedUsdc: undefined,
    });
    render(<UnwindPreviewCard quote={quote} onConfirm={vi.fn()} />);

    const button = screen.getByText("Close Position") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getAllByText(/Unavailable — No open position found/)).toHaveLength(2);
  });

  it("shows a loading state and no preview state", () => {
    const { rerender } = render(
      <UnwindPreviewCard quote={null} isLoading onConfirm={vi.fn()} />
    );
    expect(screen.getByText("Loading preview…")).toBeDefined();

    rerender(<UnwindPreviewCard quote={null} onConfirm={vi.fn()} />);
    expect(screen.getByText("No preview available yet.")).toBeDefined();
  });
});
