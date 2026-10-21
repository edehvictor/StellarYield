import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { validatePortfolioDust } from "../../../../shared/types/portfolioDust";
import DustAllocationWarning from "./DustAllocationWarning";

const allocations = [
  { vaultContractId: "blend", vaultName: "Blend", weight: 50 },
  { vaultContractId: "soroswap", vaultName: "Soroswap", weight: 50 },
];

describe("DustAllocationWarning", () => {
  it("renders nothing when the portfolio has no dust", () => {
    const validation = validatePortfolioDust({
      totalAmount: 1_000n,
      allocations,
    });

    const { container } = render(<DustAllocationWarning validation={validation} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each flagged vault with stable copy and triggers cleanup", () => {
    const validation = validatePortfolioDust({
      totalAmount: 1n,
      allocations,
    });
    const onAutoResolve = vi.fn();

    render(
      <DustAllocationWarning
        validation={validation}
        onAutoResolve={onAutoResolve}
      />,
    );

    expect(screen.getByText("Dust allocations detected")).toBeInTheDocument();
    expect(screen.getByText(/Soroswap/)).toBeInTheDocument();
    expect(screen.getAllByTestId("dust-issue-AMOUNT_ROUNDS_TO_ZERO")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Remove dust & rebalance/i }));
    expect(onAutoResolve).toHaveBeenCalledTimes(1);
  });

  it("shows a loading state while the rebalance is applied", () => {
    const validation = validatePortfolioDust({
      totalAmount: 1n,
      allocations,
    });

    render(
      <DustAllocationWarning
        validation={validation}
        onAutoResolve={vi.fn()}
        isResolving
      />,
    );

    expect(screen.getByRole("button", { name: /Rebalancing/i })).toBeDisabled();
  });

  it("does not offer cleanup when no suggestion is possible", () => {
    const validation = validatePortfolioDust({
      totalAmount: 1n,
      allocations,
    });

    render(<DustAllocationWarning validation={validation} />);
    expect(
      screen.queryByRole("button", { name: /Remove dust & rebalance/i }),
    ).not.toBeInTheDocument();
  });
});
