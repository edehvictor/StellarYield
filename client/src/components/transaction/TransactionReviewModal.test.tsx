import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionReviewModal } from "./TransactionReviewModal";
import { computeQuoteAssumptionFingerprint } from "../../../../shared/types/quoteAssumptionFingerprint";

const mockAssumptions = {
  inputTokenContract: "CB64D3G7AW2Z64V6B3H6Y5A5LGBY2QW6K3V6W7G3E2D1",
  vaultTokenContract: "CVLTFAKECONTRACTIDFORLOCALBUILDONLY",
  amountInStroops: "100000000",
  expectedAmountOutStroops: "99500000",
  minAmountOutStroops: "99000000",
  slippageTolerancePct: 0.5,
  routeHash: "mockroutehash123",
  path: ["CB64D3G7AW2Z64V6B3H6Y5A5LGBY2QW6K3V6W7G3E2D1", "CVLTFAKECONTRACTIDFORLOCALBUILDONLY"],
  source: "router_simulation",
  assetConfigVersion: "v1-config",
  quotedAt: new Date(Date.now() - 5000).toISOString(),
  expiresAt: new Date(Date.now() + 55000).toISOString(),
};

const mockFingerprint = computeQuoteAssumptionFingerprint(mockAssumptions).fingerprint;

describe("TransactionReviewModal", () => {
  it("does not render when isOpen is false", () => {
    render(
      <TransactionReviewModal
        isOpen={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
        inputToken={{ symbol: "USDC", amount: "100" }}
        vaultToken={{ symbol: "yUSDC", amount: "99.5", minAmount: "99.0" }}
        slippageTolerance={0.5}
      />,
    );
    expect(screen.queryByTestId("transaction-review-modal")).not.toBeInTheDocument();
  });

  it("renders review parameters and embedded assumption fingerprint when open", () => {
    render(
      <TransactionReviewModal
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
        inputToken={{ symbol: "USDC", amount: "100" }}
        vaultToken={{ symbol: "yUSDC", amount: "99.5", minAmount: "99.0" }}
        slippageTolerance={0.5}
        assumptions={mockAssumptions}
        fingerprint={mockFingerprint}
      />,
    );

    expect(screen.getByTestId("transaction-review-modal")).toBeInTheDocument();
    expect(screen.getByText("Review Transaction")).toBeInTheDocument();
    expect(screen.getByText("100 USDC")).toBeInTheDocument();
    expect(screen.getByText("99.5 yUSDC")).toBeInTheDocument();
    expect(screen.getByText(/99.0 yUSDC/i)).toBeInTheDocument();
    expect(screen.getByTestId("fingerprint-verified")).toBeInTheDocument();
  });

  it("triggers onConfirm when Confirm & Sign is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <TransactionReviewModal
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={onConfirm}
        walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
        inputToken={{ symbol: "USDC", amount: "100" }}
        vaultToken={{ symbol: "yUSDC", amount: "99.5", minAmount: "99.0" }}
        slippageTolerance={0.5}
        assumptions={mockAssumptions}
        fingerprint={mockFingerprint}
      />,
    );

    const confirmBtn = screen.getByTestId("confirm-transaction-btn");
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables confirm button and displays stale warning when isStale is true", () => {
    const onConfirm = vi.fn();
    render(
      <TransactionReviewModal
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={onConfirm}
        walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
        inputToken={{ symbol: "USDC", amount: "100" }}
        vaultToken={{ symbol: "yUSDC", amount: "99.5", minAmount: "99.0" }}
        slippageTolerance={0.5}
        assumptions={mockAssumptions}
        fingerprint={mockFingerprint}
        isStale={true}
      />,
    );

    const confirmBtn = screen.getByTestId("confirm-transaction-btn");
    expect(confirmBtn).toBeDisabled();
    expect(screen.getByTestId("fingerprint-stale")).toBeInTheDocument();
  });

  it("disables confirm button when isSubmitting is true", () => {
    render(
      <TransactionReviewModal
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isSubmitting={true}
        walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
        inputToken={{ symbol: "USDC", amount: "100" }}
        vaultToken={{ symbol: "yUSDC", amount: "99.5" }}
        slippageTolerance={0.5}
      />,
    );

    const confirmBtn = screen.getByTestId("confirm-transaction-btn");
    expect(confirmBtn).toBeDisabled();
    expect(screen.getByText(/Signing…/i)).toBeInTheDocument();
  });

  it("calls onClose when Cancel button or Close X is clicked", () => {
    const onClose = vi.fn();
    render(
      <TransactionReviewModal
        isOpen={true}
        onClose={onClose}
        onConfirm={vi.fn()}
        walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
        inputToken={{ symbol: "USDC", amount: "100" }}
        vaultToken={{ symbol: "yUSDC", amount: "99.5" }}
        slippageTolerance={0.5}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText(/close review dialog/i));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
