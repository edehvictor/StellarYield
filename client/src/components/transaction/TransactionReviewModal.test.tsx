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

  describe("boundary validation against malformed external data (#1889)", () => {
    it("rejects non-numeric input amounts and blocks confirmation without mutating state", () => {
      const onConfirm = vi.fn();
      render(
        <TransactionReviewModal
          isOpen={true}
          onClose={vi.fn()}
          onConfirm={onConfirm}
          walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
          inputToken={{ symbol: "USDC", amount: "not-a-number" }}
          vaultToken={{ symbol: "yUSDC", amount: "99.5" }}
          slippageTolerance={0.5}
        />,
      );

      expect(screen.getByTestId("transaction-review-validation-error")).toBeInTheDocument();
      expect(screen.getByText(/INVALID_INPUT_AMOUNT/i)).toBeInTheDocument();

      const confirmBtn = screen.getByTestId("confirm-transaction-btn");
      expect(confirmBtn).toBeDisabled();

      fireEvent.click(confirmBtn);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("rejects malformed wallet address and blocks confirmation", () => {
      const onConfirm = vi.fn();
      render(
        <TransactionReviewModal
          isOpen={true}
          onClose={vi.fn()}
          onConfirm={onConfirm}
          walletAddress="bad-address"
          inputToken={{ symbol: "USDC", amount: "100" }}
          vaultToken={{ symbol: "yUSDC", amount: "99.5" }}
          slippageTolerance={0.5}
        />,
      );

      expect(screen.getByTestId("transaction-review-validation-error")).toBeInTheDocument();
      expect(screen.getByText(/INVALID_WALLET_ADDRESS/i)).toBeInTheDocument();
      expect(screen.getByTestId("confirm-transaction-btn")).toBeDisabled();
      fireEvent.click(screen.getByTestId("confirm-transaction-btn"));
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("rejects minAmount that exceeds output amount", () => {
      const onConfirm = vi.fn();
      render(
        <TransactionReviewModal
          isOpen={true}
          onClose={vi.fn()}
          onConfirm={onConfirm}
          walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
          inputToken={{ symbol: "USDC", amount: "100" }}
          vaultToken={{ symbol: "yUSDC", amount: "99.5", minAmount: "120.0" }}
          slippageTolerance={0.5}
        />,
      );

      expect(screen.getByTestId("transaction-review-validation-error")).toBeInTheDocument();
      expect(screen.getByText(/MIN_AMOUNT_EXCEEDS_OUTPUT/i)).toBeInTheDocument();
      expect(screen.getByTestId("confirm-transaction-btn")).toBeDisabled();
      fireEvent.click(screen.getByTestId("confirm-transaction-btn"));
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("rejects invalid slippage tolerance percentage", () => {
      const onConfirm = vi.fn();
      render(
        <TransactionReviewModal
          isOpen={true}
          onClose={vi.fn()}
          onConfirm={onConfirm}
          walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
          inputToken={{ symbol: "USDC", amount: "100" }}
          vaultToken={{ symbol: "yUSDC", amount: "99.5" }}
          slippageTolerance={-1}
        />,
      );

      expect(screen.getByTestId("transaction-review-validation-error")).toBeInTheDocument();
      expect(screen.getByText(/INVALID_SLIPPAGE/i)).toBeInTheDocument();
      expect(screen.getByTestId("confirm-transaction-btn")).toBeDisabled();
      fireEvent.click(screen.getByTestId("confirm-transaction-btn"));
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("rejects expired quote assumptions at the review boundary", () => {
      const onConfirm = vi.fn();
      const expiredAssumptions = {
        ...mockAssumptions,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
      render(
        <TransactionReviewModal
          isOpen={true}
          onClose={vi.fn()}
          onConfirm={onConfirm}
          walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
          inputToken={{ symbol: "USDC", amount: "100" }}
          vaultToken={{ symbol: "yUSDC", amount: "99.5" }}
          slippageTolerance={0.5}
          assumptions={expiredAssumptions}
          fingerprint={computeQuoteAssumptionFingerprint(expiredAssumptions).fingerprint}
        />,
      );

      expect(screen.getByTestId("transaction-review-validation-error")).toBeInTheDocument();
      expect(screen.getByText(/ASSUMPTIONS_EXPIRED/i)).toBeInTheDocument();
      expect(screen.getByTestId("confirm-transaction-btn")).toBeDisabled();
      fireEvent.click(screen.getByTestId("confirm-transaction-btn"));
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("supports safe retry behavior when malformed data is corrected", () => {
      const onConfirm = vi.fn();
      const { rerender } = render(
        <TransactionReviewModal
          isOpen={true}
          onClose={vi.fn()}
          onConfirm={onConfirm}
          walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
          inputToken={{ symbol: "USDC", amount: "malformed" }}
          vaultToken={{ symbol: "yUSDC", amount: "99.5" }}
          slippageTolerance={0.5}
        />,
      );

      // Initially blocked
      expect(screen.getByTestId("transaction-review-validation-error")).toBeInTheDocument();
      const confirmBtn = screen.getByTestId("confirm-transaction-btn");
      expect(confirmBtn).toBeDisabled();
      fireEvent.click(confirmBtn);
      expect(onConfirm).not.toHaveBeenCalled();

      // Retry with valid corrected input
      rerender(
        <TransactionReviewModal
          isOpen={true}
          onClose={vi.fn()}
          onConfirm={onConfirm}
          walletAddress="GBWM7FAKESTELLARWALLETADDRESS123456"
          inputToken={{ symbol: "USDC", amount: "100" }}
          vaultToken={{ symbol: "yUSDC", amount: "99.5" }}
          slippageTolerance={0.5}
        />,
      );

      // Error clears and confirm button becomes enabled
      expect(screen.queryByTestId("transaction-review-validation-error")).not.toBeInTheDocument();
      expect(confirmBtn).not.toBeDisabled();

      // Confirm succeeds cleanly
      fireEvent.click(confirmBtn);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });
});
