import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TxStatusTimeline from "./TxStatusTimeline";
import type { TxPhase } from "../../services/transactionPhase";

const defaultSteps: readonly TxPhase[] = ["building", "submitting", "polling"];

describe("TxStatusTimeline", () => {
  it("renders steps and highlights the active/completed ones", () => {
    render(
      <TxStatusTimeline
        steps={defaultSteps}
        phase="submitting"
      />
    );

    expect(screen.getByText("Building transaction")).toBeInTheDocument();
    expect(screen.getByText("Submitting")).toBeInTheDocument();
    expect(screen.getByText("Confirming on network")).toBeInTheDocument();
  });

  it("decodes and displays recognized contract errors", () => {
    // "Error(Contract, #3)" is code 3 which is "Zero Amount" in errorDecoder.ts
    const rawError = "Error(Contract, #3)";

    render(
      <TxStatusTimeline
        steps={defaultSteps}
        phase="failure"
        errorMessage={rawError}
        failedAtPhase="submitting"
      />
    );

    // Should display the decoded title "Zero Amount" and the code 3
    expect(screen.getByText(/Zero Amount/i)).toBeInTheDocument();
    expect(screen.getByText(/Code: 3/i)).toBeInTheDocument();
    expect(screen.getByText(/You must deposit or withdraw an amount greater than zero/i)).toBeInTheDocument();
    expect(screen.getByText(/Enter a positive token amount and try again/i)).toBeInTheDocument();
  });

  it("falls back to generic failure layout for unrecognized errors", () => {
    const rawError = "Some unexpected connection reset error from the router";

    render(
      <TxStatusTimeline
        steps={defaultSteps}
        phase="failure"
        errorMessage={rawError}
        failedAtPhase="submitting"
      />
    );

    // Title should be "Transaction Failed"
    expect(screen.getByText("Transaction Failed")).toBeInTheDocument();
    // Message should contain the raw error string
    expect(screen.getByText("Some unexpected connection reset error from the router")).toBeInTheDocument();
  });

  it("calls onRetry when retry button is clicked", () => {
    const onRetry = vi.fn();
    render(
      <TxStatusTimeline
        steps={defaultSteps}
        phase="failure"
        errorMessage="Error(Contract, #3)"
        failedAtPhase="submitting"
        onRetry={onRetry}
      />
    );

    const retryBtn = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
