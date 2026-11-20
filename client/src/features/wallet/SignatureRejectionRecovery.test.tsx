import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  classifyWalletSignatureError,
  type WalletSignatureRejection,
} from "../../../../shared/types/walletSignatureRejection";
import SignatureRejectionRecovery from "./SignatureRejectionRecovery";

function rejection(overrides: Partial<WalletSignatureRejection> = {}) {
  return {
    ...classifyWalletSignatureError("User rejected signing", {
      provider: "freighter",
    }),
    ...overrides,
  };
}

function renderPanel(overrides: Partial<WalletSignatureRejection> = {}) {
  const handlers = {
    onRetry: vi.fn(),
    onReconnect: vi.fn(),
    onSwitchWallet: vi.fn(),
    onCancel: vi.fn(),
  };

  render(
    <SignatureRejectionRecovery
      actionLabel="deposit"
      rejection={rejection(overrides)}
      {...handlers}
    />,
  );

  return handlers;
}

describe("SignatureRejectionRecovery", () => {
  it("renders stable copy and wires the retry, switch, and cancel actions", () => {
    const handlers = renderPanel();

    expect(screen.getByRole("alert")).toHaveAttribute(
      "data-testid",
      "signature-rejection-recovery",
    );
    expect(screen.getByText("Signature request declined")).toBeInTheDocument();
    expect(
      screen.getByText(/nothing was sent to the network/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Retry deposit/i }));
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Switch wallet/i }));
    expect(handlers.onSwitchWallet).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("removes retry once the attempt limit is reached", () => {
    renderPanel({
      ...classifyWalletSignatureError("User rejected signing", {
        attempt: 3,
        maxAttempts: 3,
      }),
    });

    expect(
      screen.queryByRole("button", { name: /Retry deposit/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/attempt limit reached/i)).toBeInTheDocument();
  });

  it("offers reconnect for a locked wallet and no switch action", () => {
    const handlers = renderPanel(classifyWalletSignatureError("Wallet is locked"));

    fireEvent.click(screen.getByRole("button", { name: /Reconnect wallet/i }));
    expect(handlers.onReconnect).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: /Switch wallet/i }),
    ).not.toBeInTheDocument();
  });

  it("shows partial batch progress and disables actions while retrying", () => {
    render(
      <SignatureRejectionRecovery
        actionLabel="deposit"
        rejection={rejection()}
        isRetrying
        progress={{ completed: 2, total: 4 }}
        onRetry={vi.fn()}
        onReconnect={vi.fn()}
        onSwitchWallet={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId("signature-rejection-progress")).toHaveTextContent(
      "2 of 4 steps already completed",
    );
    expect(screen.getByRole("button", { name: /Waiting for wallet/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeDisabled();
  });
});
