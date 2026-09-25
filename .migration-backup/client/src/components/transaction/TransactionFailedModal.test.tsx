import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import TransactionFailedModal from "./TransactionFailedModal";
import type { DecodedError } from "../../utils/errorDecoder";

const baseError: DecodedError = {
  title: "Transaction Failed",
  message: "Something went wrong.",
  suggestion: "Try again.",
  raw: "raw-log",
  code: 10,
};

describe("TransactionFailedModal", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows wallet recovery step for waiting_for_wallet failures", () => {
    render(
      <TransactionFailedModal
        error={baseError}
        onClose={() => {}}
        failurePhase="waiting_for_wallet"
        walletConnected={false}
        networkHealthy
      />,
    );

    expect(
      screen.getByText(/Reconnect your wallet, then retry the transaction/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Open wallet extension and approve the pending request/i),
    ).toBeInTheDocument();
  });

  it("shows network recovery step for submitting failures", () => {
    render(
      <TransactionFailedModal
        error={baseError}
        onClose={() => {}}
        failurePhase="submitting"
        walletConnected
        networkHealthy={false}
      />,
    );

    expect(
      screen.getByText(/Switch RPC endpoint or wait for network stability/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Retry submission with a fresh signature/i),
    ).toBeInTheDocument();
  });

  it("shows simulation recovery step and supports copy details", async () => {
    render(
      <TransactionFailedModal
        error={baseError}
        onClose={() => {}}
        failurePhase="simulating"
      />,
    );

    expect(
      screen.getByText(/Lower amount or increase slippage and simulate again/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /copy details/i }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
      expect(screen.getByText("Copied")).toBeInTheDocument();
    });
  });

  it("renders retry and view details controls when callbacks are provided", () => {
    const onRetry = vi.fn();
    const onViewDetails = vi.fn();

    render(
      <TransactionFailedModal
        error={baseError}
        onClose={() => {}}
        onRetry={onRetry}
        onViewDetails={onViewDetails}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    fireEvent.click(screen.getByRole("button", { name: /view details/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onViewDetails).toHaveBeenCalledTimes(1);
  });
});
